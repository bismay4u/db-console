// api/engines/sqlite-worker.js
// Runs one SQLite database in a worker thread: better-sqlite3 is synchronous, so a slow query would otherwise freeze
// the whole server — and this way "Stop" can end a query by ending the thread.

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const MAX_RESULT_ROWS = 10000;
const db = new Database(workerData.file, { fileMustExist: !workerData.create, readonly: Boolean(workerData.readonly) });
db.defaultSafeIntegers(true);
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.function('regexp', { deterministic: true }, (pattern, value) => {
  if (value === null || value === undefined) return 0;
  try { return new RegExp(String(pattern), 'i').test(String(value)) ? 1 : 0; } catch (e) { return 0; }
});

const iterators = new Map();
let iterSeq = 0;

const handlers = {
  all({ sql, params = [] }) {
    const st = db.prepare(sql);
    return { columns: st.columns().map((c) => c.name), rows: st.all(...params) };
  },
  run({ sql, params = [] }) {
    const r = db.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  },
  // A list of statements for the Query Runner; stops at the first error.
  statements({ statements, guard = [] }) {
    const out = [];
    for (let n = 0; n < statements.length; n++) {
      const sql = statements[n];
      const start = Date.now();
      try {
        if (guard[n]) db.pragma('query_only = ON');
        let entry;
        try {
          const st = db.prepare(sql);
          if (st.reader) {
            const columns = st.columns().map((c) => c.name);
            const rows = []; let total = 0;
            for (const row of st.iterate()) { total++; if (rows.length < MAX_RESULT_ROWS) rows.push(row); }
            entry = { sql, ok: true, type: 'rows', columns, rows, rowCount: total, truncated: total > MAX_RESULT_ROWS };
          } else {
            const r = st.run();
            entry = { sql, ok: true, type: 'result', affectedRows: Number(r.changes), insertId: r.lastInsertRowid > 0n ? Number(r.lastInsertRowid) : undefined };
          }
        } finally { if (guard[n]) db.pragma('query_only = OFF'); }
        entry.durationMs = Date.now() - start;
        out.push(entry);
      } catch (e) {
        out.push({ sql, ok: false, error: e.message, durationMs: Date.now() - start });
        break;
      }
    }
    return out;
  },
  open({ sql, params = [] }) {
    const st = db.prepare(sql);
    if (!st.reader) throw new Error('That statement does not return rows');
    const id = ++iterSeq;
    iterators.set(id, st.iterate(...params));
    return { cur: id, columns: st.columns().map((c) => c.name) };
  },
  next({ cur, n }) {
    const it = iterators.get(cur);
    const rows = [];
    while (it && rows.length < n) { const x = it.next(); if (x.done) { iterators.delete(cur); break; } rows.push(x.value); }
    return rows;
  },
  close({ cur }) { const it = iterators.get(cur); if (it) { it.return(); iterators.delete(cur); } return true; }
};

parentPort.on('message', (m) => {
  try { parentPort.postMessage({ id: m.id, ok: true, result: handlers[m.op](m) }); } catch (e) { parentPort.postMessage({ id: m.id, ok: false, error: e.message }); }
});
parentPort.postMessage({ ready: true });
