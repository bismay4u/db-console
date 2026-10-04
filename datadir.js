// datadir.js
// Where the app keeps its runtime data, plus the file helpers every module
// that writes there uses. Safe with several processes sharing the same
// directory (PM2 cluster mode):
//   - writes are atomic (temp file + rename), so a reader never sees a
//     half-written file
//   - read-modify-write sequences run under withLock(), a cross-process
//     lock file, so two workers never overwrite each other's changes
//   - files are created readable by the app's OS user only (they hold
//     database passwords, password hashes and session data)
//
// The directory defaults to ./data and can be moved with the DATA_DIR
// environment variable or `dataDir` in config.js.

const fs = require('fs');
const path = require('path');

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  try {
    const config = require('./config');
    if (config.dataDir) return path.resolve(__dirname, config.dataDir);
  } catch (e) {
    // no config.js yet
  }
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();
const LOCK_FILE = path.join(DATA_DIR, '.store.lock');
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 10000;
const FILE_MODE = 0o600;

function ensureDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback = []) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  return raw.trim() ? JSON.parse(raw) : fallback;
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

function writeJson(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

// Blocks the thread for `ms` without spinning the CPU.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

let lockDepth = 0;

// Runs fn() while holding the data-directory lock. Re-entrant within a
// process. A lock left behind by a crashed process expires after
// LOCK_STALE_MS. Store operations are small and synchronous, so waiting
// synchronously here is fine.
function withLock(fn) {
  if (lockDepth > 0) {
    lockDepth++;
    try { return fn(); } finally { lockDepth--; }
  }

  ensureDir();
  const started = Date.now();
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx', FILE_MODE);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch (statErr) {
        continue; // released between our open and stat
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('Timed out waiting for the data directory lock');
      sleepSync(5 + Math.random() * 10);
    }
  }

  lockDepth = 1;
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    lockDepth = 0;
    fs.closeSync(fd);
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* already gone */ }
  }
}

module.exports = { DATA_DIR, FILE_MODE, ensureDir, readJson, writeJson, writeFileAtomic, withLock };
