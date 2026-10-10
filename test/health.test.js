// Server health: snapshot, flags, recorded history.
const { test } = require('node:test');
const mysql2 = require('mysql2/promise');
const T = require('./helpers');
const metrics = require('../api/metrics');
const { check, finish } = T;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('rates from recorded samples', () => {
  const base = { up: 1000, threads: 3, running: 1, lockWaits: 0, slow: 0, aborted: 0, bpReads: 0, bpRequests: 0 };
  const pts = metrics.withRates([
    { ...base, ts: 0, questions: 100 },
    { ...base, ts: 60000, questions: 700, slow: 3, aborted: 6, bpReads: 10, bpRequests: 1000, up: 1060 },
    { ...base, ts: 120000, questions: 50, up: 5 } // the server restarted
  ]);
  const assert = require('node:assert');
  assert.strictEqual(pts[0].qps, null);
  assert.strictEqual(pts[1].qps, 10);
  assert.strictEqual(pts[1].slowPerMin, 3);
  assert.strictEqual(pts[1].abortedPerMin, 6);
  assert.ok(Math.abs(pts[1].hitRatio - 99) < 0.001);
  assert.strictEqual(pts[2].qps, null, 'a restart resets the counters, so no rate');
});

test('flags describe the problems in words', () => {
  const assert = require('node:assert');
  const s = {
    uptime: 100000, connections: { current: 95, running: 25, max: 100, maxUsed: 100 }, innodb: { hitRatio: 80, rowLockWaitsNow: 2, historyListLength: null }, queries: { total: 200000, slow: 5, slowLog: false, longQueryTime: 10 },
    tmpTables: { total: 5000, diskPct: 40 }, lockWaits: [{ secs: 9 }], transactions: [{ id: 7, age: 120, query: null }], replication: { io: 'Yes', sql: 'No', error: 'dup key' }
  };
  const text = metrics.flags(s).map((f) => f.level + ': ' + f.text).join('\n');
  for (const re of [/95 of 100 connections/, /limit \(100\) has been reached/, /25 queries are running/, /80\.0% of reads/, /waiting for a row lock/, /waited 9s/, /Connection 7 .* idle/, /40% of temporary tables/, /slow query log is off/, /Replication is not running.*dup key/]) assert.match(text, re);
});

test('server health page data', { timeout: 60000 }, async () => {
  const srv = await T.startServer({ env: { SCHEDULER_TICK_MS: '200', METRICS_INTERVAL_MS: '400' } });
  const hold = await mysql2.createConnection({ host: T.DB.host, port: T.DB.port, user: T.DB.user, password: T.DB.password, database: 'shop' });
  try {
    const cookie = await T.login(srv.B);
    const A = async (method, p, body, ck = cookie) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    let r = await A('GET', '/api/server/shop/health');
    const h = r.data;
    check(r.status === 200 && /\d/.test(h.version) && h.uptime > 0 && h.connections.max > 0 && h.connections.current >= 1 && typeof h.queries.total === 'number', 'snapshot', Object.keys(h));
    check(h.innodb.hitRatio === null || h.innodb.hitRatio > 0, 'buffer pool hit ratio');
    check(Array.isArray(h.flags) && Array.isArray(h.running) && Array.isArray(h.transactions) && Array.isArray(h.lockWaits), 'lists for flags, running queries, transactions and lock waits');

    T.mysql('CREATE TABLE IF NOT EXISTS shop.hl_t (id INT PRIMARY KEY, v INT); REPLACE INTO shop.hl_t VALUES (1, 0)');
    await hold.query('START TRANSACTION'); await hold.query('UPDATE hl_t SET v = v + 1 WHERE id = 1');
    await wait(300); // information_schema.INNODB_TRX is cached for ~100 ms
    r = await A('GET', '/api/server/shop/health');
    check(r.data.transactions.length >= 1, 'an open transaction is listed', r.data.transactions);
    await hold.query('ROLLBACK');
    T.mysql('DROP TABLE shop.hl_t');

    r = await A('GET', '/api/server/shop/innodb-status');
    check(r.status === 200 && /INNODB MONITOR OUTPUT|BUFFER POOL/i.test(r.data.text), 'InnoDB status text');

    r = await A('GET', '/api/server/shop/health/history?hours=1');
    check(r.data.recording === false && r.data.points.length === 0, 'nothing is recorded until switched on');
    await A('PUT', '/api/connections/shop', { monitor: true });
    await wait(1800);
    r = await A('GET', '/api/server/shop/health/history?hours=1');
    check(r.data.recording === true && r.data.points.length >= 2, 'once recording, samples accumulate', r.data.points.length);
    check(r.data.points[1].qps === null || r.data.points[1].qps >= 0, 'with rates', r.data.points[1]);

    await A('POST', '/api/users', { username: 'other', password: 'other-pass-12', role: 'user' });
    const oc = await T.login(srv.B, 'other', 'other-pass-12');
    r = await A('GET', '/api/server/shop/health', undefined, oc);
    check(r.status === 404 || r.status === 403, 'only the owner or an admin sees it', r.status);
  } finally { await hold.end().catch(() => {}); await srv.stop(); }
  finish();
});
