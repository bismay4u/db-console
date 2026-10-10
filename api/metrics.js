// api/metrics.js
// Server health for a connection: a snapshot of what the server is doing, a list of things worth a look,
// and a history of a few counters recorded once a minute for connections that have "record metrics" on
// (data/metrics/<connection>.jsonl, the newest 7 days).

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDir } = require('./datadir');
const { getPool } = require('./db');

const DIR = path.join(DATA_DIR, 'metrics');
const KEEP_SAMPLES = 7 * 24 * 60;

const n = (v) => Number(v || 0);
const pct = (a, b) => (b > 0 ? a / b * 100 : null);

async function statusMap(pool) {
  const [rows] = await pool.query('SHOW GLOBAL STATUS');
  return Object.fromEntries(rows.map((r) => [r.Variable_name, r.Value]));
}
async function varMap(pool, names) {
  const [rows] = await pool.query(`SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names.map(() => '?').join(',')})`, names);
  return Object.fromEntries(rows.map((r) => [r.Variable_name, r.Value]));
}

// The few numbers worth keeping over time (counters stay raw; rates are worked out when reading).
function sampleFrom(st) {
  return {
    ts: Date.now(), up: n(st.Uptime), threads: n(st.Threads_connected), running: n(st.Threads_running),
    questions: n(st.Questions), slow: n(st.Slow_queries), aborted: n(st.Aborted_connects) + n(st.Aborted_clients),
    lockWaits: n(st.Innodb_row_lock_current_waits), bpReads: n(st.Innodb_buffer_pool_reads), bpRequests: n(st.Innodb_buffer_pool_read_requests)
  };
}

async function snapshot(key) {
  const pool = getPool(key);
  const [st, vars] = await Promise.all([
    statusMap(pool),
    varMap(pool, ['version', 'max_connections', 'slow_query_log', 'long_query_time', 'innodb_buffer_pool_size', 'read_only'])
  ]);
  const out = {
    at: Date.now(), version: vars.version, readOnly: /^(1|on)$/i.test(String(vars.read_only)), uptime: n(st.Uptime),
    connections: { current: n(st.Threads_connected), running: n(st.Threads_running), max: n(vars.max_connections), maxUsed: n(st.Max_used_connections), aborted: n(st.Aborted_connects) + n(st.Aborted_clients) },
    queries: { total: n(st.Questions), slow: n(st.Slow_queries), slowLog: /^(1|on)$/i.test(String(vars.slow_query_log)), longQueryTime: n(vars.long_query_time) },
    innodb: {
      bufferPoolBytes: n(vars.innodb_buffer_pool_size),
      hitRatio: pct(n(st.Innodb_buffer_pool_read_requests) - n(st.Innodb_buffer_pool_reads), n(st.Innodb_buffer_pool_read_requests)),
      rowLockWaitsNow: n(st.Innodb_row_lock_current_waits), rowLockWaitsTotal: n(st.Innodb_row_lock_waits), rowLockTimeAvgMs: n(st.Innodb_row_lock_time_avg),
      historyListLength: st.Innodb_history_list_length === undefined ? null : n(st.Innodb_history_list_length)
    },
    tmpTables: { disk: n(st.Created_tmp_disk_tables), total: n(st.Created_tmp_tables), diskPct: pct(n(st.Created_tmp_disk_tables), n(st.Created_tmp_tables)) },
    tableLocks: { waited: n(st.Table_locks_waited), immediate: n(st.Table_locks_immediate) },
    traffic: { received: n(st.Bytes_received), sent: n(st.Bytes_sent) },
    sample: sampleFrom(st)
  };

  const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { if (process.env.DBC_DEBUG) console.error('health:', e.message); return fallback; } };
  // what is running now for a while, transactions that stay open, statements waiting for locks, replication
  out.running = await safe(async () => {
    const [rows] = await pool.query("SELECT ID AS id, USER AS user, DB AS db, TIME AS time, STATE AS state, INFO AS info FROM information_schema.PROCESSLIST WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump') AND ID <> CONNECTION_ID() AND INFO IS NOT NULL ORDER BY TIME DESC LIMIT 10");
    return rows.map((r) => ({ ...r, info: String(r.info).slice(0, 300) }));
  }, []);
  out.transactions = await safe(async () => {
    const [rows] = await pool.query('SELECT trx_mysql_thread_id AS id, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age, trx_rows_modified AS modified, trx_query AS query FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 10');
    return rows.map((r) => ({ ...r, query: r.query ? String(r.query).slice(0, 200) : null }));
  }, []);
  out.lockWaits = await safe(async () => {
    try {
      const [rows] = await pool.query(`SELECT w.trx_mysql_thread_id AS waiting, TIMESTAMPDIFF(SECOND, w.trx_wait_started, NOW()) AS secs, b.trx_mysql_thread_id AS blocking, w.trx_query AS waitingQuery
          FROM information_schema.INNODB_LOCK_WAITS lw JOIN information_schema.INNODB_TRX w ON w.trx_id = lw.requesting_trx_id JOIN information_schema.INNODB_TRX b ON b.trx_id = lw.blocking_trx_id`);
      return rows;
    } catch (e) {
      const [rows] = await pool.query(`SELECT r.trx_mysql_thread_id AS waiting, TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS secs, b.trx_mysql_thread_id AS blocking, r.trx_query AS waitingQuery
          FROM performance_schema.data_lock_waits w JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID`);
      return rows;
    }
  }, []);
  out.replication = await safe(async () => {
    let rows;
    try { [rows] = await pool.query('SHOW REPLICA STATUS'); } catch (e) { [rows] = await pool.query('SHOW SLAVE STATUS'); }
    if (!rows.length) return null;
    const r = rows[0];
    const io = r.Replica_IO_Running || r.Slave_IO_Running; const sql = r.Replica_SQL_Running || r.Slave_SQL_Running;
    const lag = r.Seconds_Behind_Source ?? r.Seconds_Behind_Master;
    return { io, sql, lag: lag === null || lag === undefined ? null : Number(lag), error: r.Last_SQL_Error || r.Last_IO_Error || '', source: r.Source_Host || r.Master_Host };
  }, null);
  out.flags = flags(out);
  return out;
}

// Plain-language things worth a look: [{ level: 'error'|'warning'|'info', text }]
function flags(s) {
  const f = [];
  const c = s.connections;
  const used = pct(c.current, c.max);
  if (used !== null && used >= 80) f.push({ level: used >= 95 ? 'error' : 'warning', text: `${c.current} of ${c.max} connections are in use (${used.toFixed(0)}%). New clients will be refused when the limit is reached.` });
  if (c.max && c.maxUsed >= c.max) f.push({ level: 'error', text: `The connection limit (${c.max}) has been reached since the server started.` });
  if (c.running >= 20) f.push({ level: 'warning', text: `${c.running} queries are running at the same time.` });
  if (s.innodb.hitRatio !== null && s.queries.total > 100000 && s.innodb.hitRatio < 95) f.push({ level: 'warning', text: `The InnoDB buffer pool serves only ${s.innodb.hitRatio.toFixed(1)}% of reads from memory; the buffer pool may be too small for the data.` });
  if (s.innodb.rowLockWaitsNow > 0) f.push({ level: 'warning', text: `${s.innodb.rowLockWaitsNow} statement(s) are waiting for a row lock right now.` });
  if (s.lockWaits && s.lockWaits.some((w) => w.secs >= 5)) f.push({ level: 'error', text: `A statement has waited ${Math.max(...s.lockWaits.map((w) => w.secs))}s for a lock held by another transaction.` });
  const oldTx = (s.transactions || []).find((t) => t.age >= 60);
  if (oldTx) f.push({ level: 'warning', text: `Connection ${oldTx.id} has had a transaction open for ${oldTx.age}s${oldTx.query ? '' : ' and is idle (a client that forgot to COMMIT?)'}.` });
  if (s.innodb.historyListLength !== null && s.innodb.historyListLength > 1000000) f.push({ level: 'warning', text: `The InnoDB history list is ${s.innodb.historyListLength.toLocaleString()} entries long; a long transaction is stopping cleanup.` });
  if (s.tmpTables.diskPct !== null && s.tmpTables.total > 1000 && s.tmpTables.diskPct > 25) f.push({ level: 'info', text: `${s.tmpTables.diskPct.toFixed(0)}% of temporary tables go to disk; large sorts and GROUP BYs may need better indexes.` });
  if (!s.queries.slowLog) f.push({ level: 'info', text: 'The slow query log is off, so slow queries are only counted, not recorded.' });
  else if (s.queries.slow > 0 && s.uptime > 3600) f.push({ level: 'info', text: `${s.queries.slow.toLocaleString()} queries took longer than ${s.queries.longQueryTime}s since the server started.` });
  if (s.replication) {
    if (s.replication.io !== 'Yes' || s.replication.sql !== 'Yes') f.push({ level: 'error', text: `Replication is not running (IO: ${s.replication.io}, SQL: ${s.replication.sql}).${s.replication.error ? ' ' + s.replication.error : ''}` });
    else if (s.replication.lag !== null && s.replication.lag > 60) f.push({ level: 'warning', text: `The replica is ${s.replication.lag}s behind its source.` });
  }
  if (s.uptime < 600) f.push({ level: 'info', text: `The server restarted ${Math.round(s.uptime / 60)} minute(s) ago; counters and caches are still warming up.` });
  return f;
}

async function innodbStatus(key) {
  const [rows] = await getPool(key).query('SHOW ENGINE INNODB STATUS');
  return String((rows[0] && (rows[0].Status || rows[0].status)) || '');
}

// ---------- recorded history ----------
const fileFor = (key) => path.join(DIR, key.replace(/[^\w.-]/g, '_') + '.jsonl');

async function record(key) {
  const st = await statusMap(getPool(key));
  const s = sampleFrom(st);
  ensureDir();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = fileFor(key);
  fs.appendFileSync(file, JSON.stringify(s) + '\n', { mode: 0o600 });
  try {
    if (fs.statSync(file).size > KEEP_SAMPLES * 160 * 1.3) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(-KEEP_SAMPLES).join('\n') + '\n', { mode: 0o600 });
    }
  } catch (e) { /* trimming is best effort */ }
  return s;
}

// Points with rates: queries per second, slow queries and aborted connections per minute, buffer pool hit ratio.
function history(key, sinceMs) {
  let text;
  try { text = fs.readFileSync(fileFor(key), 'utf8'); } catch (e) { return []; }
  const raw = [];
  for (const line of text.split('\n')) { if (!line) continue; try { const s = JSON.parse(line); if (s.ts >= sinceMs) raw.push(s); } catch (e) { /* torn line */ } }
  return withRates(raw);
}

function withRates(raw) {
  return raw.map((s, i) => {
    const p = raw[i - 1];
    const dt = p ? (s.ts - p.ts) / 1000 : 0;
    const ok = p && dt > 0 && s.up >= p.up; // a restart resets the counters
    const rate = (a, b) => (ok ? Math.max(0, (a - b) / dt) : null);
    const dReq = ok ? s.bpRequests - p.bpRequests : 0;
    return {
      ts: s.ts, threads: s.threads, running: s.running, lockWaits: s.lockWaits,
      qps: rate(s.questions, p && p.questions), slowPerMin: ok ? rate(s.slow, p.slow) * 60 : null, abortedPerMin: ok ? rate(s.aborted, p.aborted) * 60 : null,
      hitRatio: ok && dReq > 0 ? (1 - (s.bpReads - p.bpReads) / dReq) * 100 : null
    };
  });
}

module.exports = { snapshot, flags, innodbStatus, record, history, withRates, sampleFrom };
