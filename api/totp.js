// api/totp.js
// Two-factor sign-in with an authenticator app (TOTP, RFC 6238: HMAC-SHA1, 30 s steps, 6 digits —
// what Google Authenticator, Microsoft Authenticator, Authy, 1Password and friends implement),
// plus one-time recovery codes.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(text).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Not a valid secret');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Returns the time step the code belongs to (so it can be remembered and never accepted twice), or null.
// One step either side is allowed for clock drift.
function verify(secret, token, { now = Date.now(), lastStep = 0 } = {}) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const current = Math.floor(now / 1000 / STEP);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastStep) continue;
    const a = Buffer.from(codeAt(secret, step)); const b = Buffer.from(t);
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

const uri = (account, issuer, secret) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// ---- recovery codes ----
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[\s-]/g, '')).digest('hex');
function newRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  return { codes, hashes: codes.map(hashCode) };
}
// The remaining hashes if `code` is one of them (it is consumed), otherwise null.
function useRecoveryCode(hashes, code) {
  const h = hashCode(code);
  return Array.isArray(hashes) && hashes.includes(h) ? hashes.filter((x) => x !== h) : null;
}

module.exports = { newSecret, verify, codeAt, uri, newRecoveryCodes, useRecoveryCode, base32Encode, base32Decode };
