// Analysis: dismissed findings, runtime rules (transactions, lock waits, deadlocks), one-click fixes.
const { test } = require('node:test');
const path = require('path');
const mysql2 = require('mysql2/promise');
const T = require('./helpers');
const seed = require('./fixtures');
const { check, finish } = T;

const open = async () => mysql2.createConnection({ host: T.DB.host, port: T.DB.port, user: T.DB.user, password: T.DB.password, database: 'anom' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('analysis: dismissals, runtime rules, apply fix', { timeout: 120000 }, async () => {
  seed.anom();
  const srv = await T.startServer();
  const conns = [];
  try {
    const cookie = await T.login(srv.B);
    const api = (ck = cookie) => async (method, p, body) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    const A = api();
    const analyze = async (ck) => (await api(ck)('GET', '/api/explore/shop/anom/analyze')).data;
    const find = (res, rule, object) => res.findings.find((f) => f.rule === rule && (!object || f.object === object));

    // ---- dismiss / restore
    let res = await analyze();
    const total = res.summary.total;
    check(find(res, 'no-primary-key', 'logs'), 'logs is flagged first');
    let r = await A('POST', '/api/explore/shop/anom/analyze/dismiss', { rule: 'no-primary-key', object: 'logs', reason: 'append-only log' });
    check(r.status === 200, 'dismiss', r.data);
    res = await analyze();
    check(!find(res, 'no-primary-key', 'logs') && res.summary.total === total - 1, 'a dismissed finding disappears from the list and the counts');
    check(res.dismissed.length === 1 && res.dismissed[0].reason === 'append-only log' && res.dismissed[0].dismissedBy === 'admin', 'and is listed as dismissed with its reason', res.dismissed);
    r = await A('POST', '/api/explore/shop/anom/analyze/restore', { rule: 'no-primary-key', object: 'logs' });
    res = await analyze();
    check(r.data.ok && find(res, 'no-primary-key', 'logs') && !res.dismissed.length, 'restore brings it back');

    // ---- apply a fix
    r = await A('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'no-primary-key', object: 'logs', sql: 'DROP DATABASE anom' });
    check(r.status === 200 && /ADD COLUMN `id`/.test(r.data.sql) && !r.data.destructive && r.data.denied === null, 'preview returns the server-side fix (a SQL sent by the browser is ignored)', r.data);
    check(T.mysql("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='anom' AND table_name='logs' AND column_name='id'") === '0', 'a preview changes nothing');
    await A('POST', '/api/users', { username: 'ro', password: 'ro-pass-1234', role: 'user' });
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ro'], readOnly: true });
    const RO = api(await T.login(srv.B, 'ro', 'ro-pass-1234'));
    r = await RO('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'no-primary-key', object: 'logs' });
    check(r.status === 200 && r.data.denied, 'a read-only user sees the preview but is told it is not allowed', r.data);
    r = await RO('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'no-primary-key', object: 'logs', confirm: true });
    check(r.status === 403, 'and cannot apply it', r.data);
    r = await RO('POST', '/api/explore/shop/anom/analyze/dismiss', { rule: 'no-primary-key', object: 'logs', reason: 'x' });
    check(r.status === 403, 'nor dismiss findings', r.status);
    r = await A('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'no-primary-key', object: 'logs', confirm: true });
    check(r.status === 200 && r.data.ok, 'the owner applies it', r.data);
    check(T.mysql("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='anom' AND table_name='logs' AND column_name='id'") === '1', 'the column exists now');
    res = await analyze();
    check(!find(res, 'no-primary-key', 'logs'), 'and the finding is gone');
    r = await A('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'no-primary-key', object: 'logs', confirm: true });
    check(r.status === 404, 'applying it again says the finding is gone', r.data);
    const lg = (await A('GET', '/api/logs?source=analysis-fix')).data;
    check(lg.total >= 1, 'applied fixes are in the query log', lg.total);

    // ---- table size limit, unused index
    await A('PUT', '/api/analyzer/rules/table-size-limit', { params: { maxMb: 0 } });
    res = await analyze();
    check(find(res, 'table-size-limit', 'orders'), 'table over the size limit');
    check(res.skipped.some((s) => s.id === 'unused-index' && /performance_schema|up only|only been up/.test(s.reason)), 'unused-index explains why it could not run', res.skipped);

    // ---- long transaction + lock wait
    await A('PUT', '/api/analyzer/rules/long-transaction', { params: { seconds: 0 } });
    await A('PUT', '/api/analyzer/rules/lock-waits', { params: { seconds: 0 } });
    const a = await open(); const b = await open(); conns.push(a, b);
    await a.query('START TRANSACTION'); await a.query("UPDATE customers SET name = 'locked' WHERE id = 1");
    const blocked = b.query("UPDATE customers SET name = 'blocked' WHERE id = 1").catch(() => {});
    await wait(1800);
    res = await analyze();
    const lt = find(res, 'long-transaction');
    check(lt && /KILL \d+/.test(lt.fix), 'a transaction left open is reported, with a KILL fix', res.findings.filter((f) => f.category === 'Runtime'));
    const lw = find(res, 'lock-waits');
    check(lw && /waited \d+s for a lock held by connection/.test(lw.message), 'a statement waiting for a lock is reported', res.skipped);
    // the KILL fix is destructive; killing the blocker releases the waiter
    r = await A('POST', '/api/explore/shop/anom/analyze/apply', { rule: 'lock-waits', object: lw.object });
    check(r.data.destructive === true && /^KILL \d+$/.test(r.data.sql), 'the KILL fix is marked destructive in the preview', r.data);
    await a.query('ROLLBACK'); await blocked; await b.query('ROLLBACK');

    // ---- deadlock
    await a.query('START TRANSACTION'); await b.query('START TRANSACTION');
    await a.query('UPDATE customers SET name = "a" WHERE id = 10');
    await b.query('UPDATE customers SET name = "b" WHERE id = 11');
    const p1 = a.query('UPDATE customers SET name = "a2" WHERE id = 11').catch((e) => e);
    await wait(500);
    const p2 = b.query('UPDATE customers SET name = "b2" WHERE id = 10').catch((e) => e);
    await Promise.all([p1, p2]);
    await a.query('ROLLBACK').catch(() => {}); await b.query('ROLLBACK').catch(() => {});
    res = await analyze();
    const dl = find(res, 'recent-deadlock');
    check(dl && /deadlock was detected at/.test(dl.message), 'a recent deadlock is reported', dl || res.skipped);
    check(!res.skipped.some((s) => s.id !== 'unused-index'), 'no other rule failed', res.skipped);
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await srv.stop();
  }
  finish();
});
