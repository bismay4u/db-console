// sessionstore.js
// express-session store that keeps each session in its own file under
// <data dir>/sessions. Unlike the default in-memory store it works with
// several PM2 cluster workers (any worker can serve any request) and
// survives restarts, so updating the app doesn't sign everyone out.
//
// File names are a hash of the session id, so an id never becomes a path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const { DATA_DIR, ensureDir, writeFileAtomic } = require('./datadir');

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 4;
const PRUNE_EVERY_MS = 1000 * 60 * 30;
// touch() only rewrites the file when the expiry moved by more than this,
// so ordinary page loads don't each cause a disk write.
const TOUCH_THRESHOLD_MS = 1000 * 60;

class FileSessionStore extends session.Store {
  constructor() {
    super();
    ensureDir(SESSIONS_DIR);
    this.prune();
    setInterval(() => this.prune(), PRUNE_EVERY_MS).unref();
  }

  file(sid) {
    return path.join(SESSIONS_DIR, crypto.createHash('sha256').update(String(sid)).digest('hex') + '.json');
  }

  expiryOf(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + DEFAULT_TTL_MS;
  }

  read(sid) {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(sid), 'utf8'));
      if (data.expires <= Date.now()) {
        this.destroy(sid, () => {});
        return null;
      }
      return data;
    } catch (e) {
      return null; // missing, or removed while being read
    }
  }

  get(sid, cb) {
    const data = this.read(sid);
    cb(null, data ? data.sess : null);
  }

  set(sid, sess, cb) {
    try {
      ensureDir(SESSIONS_DIR);
      writeFileAtomic(this.file(sid), JSON.stringify({ expires: this.expiryOf(sess), sess }));
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sess, cb) {
    const data = this.read(sid);
    if (data && Math.abs(this.expiryOf(sess) - data.expires) > TOUCH_THRESHOLD_MS) {
      return this.set(sid, { ...data.sess, cookie: sess.cookie }, cb);
    }
    return cb && cb(null);
  }

  destroy(sid, cb) {
    fs.unlink(this.file(sid), () => cb && cb(null));
  }

  // Deletes expired session files. Safe to run from several workers at once.
  prune() {
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR);
    } catch (e) {
      return;
    }
    const now = Date.now();
    for (const name of files) {
      const file = path.join(SESSIONS_DIR, name);
      try {
        if (name.endsWith('.tmp')) {
          // leftover from a crash mid-write
          if (now - fs.statSync(file).mtimeMs > 60000) fs.unlinkSync(file);
          continue;
        }
        const { expires } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!(expires > now)) fs.unlinkSync(file);
      } catch (e) {
        // removed by another worker, or unreadable; skip
      }
    }
  }
}

module.exports = FileSessionStore;
