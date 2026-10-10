const { test } = require('node:test');
const assert = require('node:assert');
const totp = require('../api/totp');

test('matches the RFC 6238 test vectors (SHA-1)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  // RFC 6238 appendix B, 8-digit codes truncated to the last 6 digits
  for (const [time, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.strictEqual(totp.codeAt(secret, Math.floor(time / 30)), code, `t=${time}`);
  }
});

test('verify allows one step of drift and never the same step twice', () => {
  const secret = totp.newSecret();
  const now = 1700000000000;
  const step = Math.floor(now / 30000);
  assert.strictEqual(totp.verify(secret, totp.codeAt(secret, step), { now }), step);
  assert.strictEqual(totp.verify(secret, totp.codeAt(secret, step - 1), { now }), step - 1);
  assert.strictEqual(totp.verify(secret, totp.codeAt(secret, step + 1), { now }), step + 1);
  assert.strictEqual(totp.verify(secret, totp.codeAt(secret, step - 2), { now }), null);
  assert.strictEqual(totp.verify(secret, totp.codeAt(secret, step), { now, lastStep: step }), null, 'a used code is refused');
  assert.strictEqual(totp.verify(secret, '12345', { now }), null);
  assert.strictEqual(totp.verify(secret, 'abcdef', { now }), null);
});

test('base32 round trip and recovery codes', () => {
  const buf = Buffer.from([1, 2, 3, 250, 251, 252, 0, 99]);
  assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  const { codes, hashes } = totp.newRecoveryCodes(3);
  assert.match(codes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  const rest = totp.useRecoveryCode(hashes, codes[1].toUpperCase().replace('-', ' '));
  assert.strictEqual(rest.length, 2);
  assert.strictEqual(totp.useRecoveryCode(rest, codes[1]), null, 'used once');
  assert.match(totp.uri('ann@x', 'DB Console', 'ABC'), /^otpauth:\/\/totp\/DB%20Console:ann%40x\?secret=ABC&issuer=DB%20Console/);
});
