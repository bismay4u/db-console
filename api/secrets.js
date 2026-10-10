// api/secrets.js
// Encryption at rest for secrets saved in the data directory (database
// passwords, SSH passwords and keys, …): AES-256-GCM with a random IV per
// value, stored as  enc:v1:<iv>:<tag>:<ciphertext>  (base64url).
//
// The key comes from, in order:
//   1. the DBC_ENCRYPTION_KEY environment variable
//   2. `encryptionKey` in config.js
//   3. data/.secret.key — 32 random bytes, generated on first use (mode 600)
// Options 1 and 2 are stretched with scrypt, so any long passphrase will do.
//
// With only option 3 the key sits next to the data: the stored values are
// then unreadable to someone who gets just connections.json (a backup, a
// copy, a commit) but not to someone who can read the whole data directory.
// Setting DBC_ENCRYPTION_KEY keeps the key out of the data directory.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, FILE_MODE, ensureDir } = require('./datadir');

const PREFIX = 'enc:v1:';
const KEY_FILE = path.join(DATA_DIR, '.secret.key');
let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  let passphrase = process.env.DBC_ENCRYPTION_KEY;
  if (!passphrase) {
    try { passphrase = require('./appconfig').encryptionKey; } catch (e) { /* no config */ }
  }
  if (passphrase) {
    // A fixed salt is fine here: the passphrase is the secret, and the key must be reproducible.
    cachedKey = crypto.scryptSync(String(passphrase), 'db-console-secrets-v1', 32);
    return cachedKey;
  }
  ensureDir();
  try {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (cachedKey.length !== 32) throw new Error('bad key file');
  } catch (e) {
    if (e.code !== 'ENOENT' && e.message !== 'bad key file') throw e;
    if (e.message === 'bad key file') throw new Error(`${KEY_FILE} is not a valid key file`);
    cachedKey = crypto.randomBytes(32);
    // 'wx': never overwrite a key another worker created a moment ago
    try {
      fs.writeFileSync(KEY_FILE, cachedKey.toString('hex') + '\n', { mode: FILE_MODE, flag: 'wx' });
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    }
  }
  return cachedKey;
}

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

// Returns the plain text; a value that isn't encrypted (older data) is returned as it is.
// Throws if the value is encrypted but can't be decrypted (wrong key).
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('Could not decrypt a stored secret — was the encryption key (DBC_ENCRYPTION_KEY / data/.secret.key) changed?');
  }
}

module.exports = { encrypt, decrypt, isEncrypted, KEY_FILE };
