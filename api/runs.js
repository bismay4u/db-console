// api/runs.js
// A registry of Query Runner runs that are in progress, so a run can be
// stopped (KILL QUERY) from another request, even one answered by a different
// PM2 worker: each run is a small file in <data dir>/runs.
//
//   { username, started, conns: { <connection key>: { thread, sql } } }
//
// `thread` is the MySQL thread (connection id) executing the statement and
// `sql` the beginning of that statement. Before killing, the thread's current
// statement is compared with `sql`, so a thread that has meanwhile been handed
// to someone else's query (pooled connections are reused) is never killed.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDir, readJson, writeJson } = require('./datadir');

const DIR = path.join(DATA_DIR, 'runs');
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STALE_MS = 6 * 3600 * 1000;

const file = (id) => path.join(DIR, `${id}.json`);
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

function sweep() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true });
    }
  } catch (e) { /* no directory yet */ }
}

// Tracks one run. Returns an object per connection key for runQuery().
function begin(id, username) {
  if (!validId(id)) return null;
  ensureDir(DIR);
  sweep();
  const run = { username, started: Date.now(), conns: {} };
  const save = () => { if (Object.keys(run.conns).length) writeJson(file(id), run); else fs.rmSync(file(id), { force: true }); };
  return {
    track(key) {
      return {
        thread(thread) { run.conns[key] = { thread, sql: '' }; save(); },
        statement(sql) { if (run.conns[key]) { run.conns[key].sql = String(sql).slice(0, 200); save(); } },
        done() { delete run.conns[key]; save(); }
      };
    },
    end() { fs.rmSync(file(id), { force: true }); }
  };
}

function read(id) {
  if (!validId(id)) return null;
  return readJson(file(id), null);
}

module.exports = { begin, read, validId };
