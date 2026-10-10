// Ported from the original ad-hoc scripts: read-only sharing.
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { execSync, spawn } = require('child_process');
const T = require('./helpers');
const seed = require('./fixtures');
const { check } = T;
let B, srv, S;
const mysql = (sql) => T.mysql(sql, 'diag');
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('read-only sharing', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.diag();
  try {
  const admin = await login('admin', 'admin123!');
  const req = async (cookie, method, path, body) => { const r = await fetch(B + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 80); } return { status: r.status, data: d }; };
  await req(admin, 'POST', '/api/users', { username: 'rouser', password: 'rouser-pass-1', role: 'user', displayName: 'RO' });
  let r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], readOnly: true });
  check(r.status === 200 && r.data.sharePermissions.rouser.length === 0, 'owner sets read-only share', r.data.sharePermissions);
  const ro = await login('rouser', 'rouser-pass-1');
  const conns = (await req(ro, 'GET', '/api/connections')).data;
  const shop = conns.find((c) => c.key === 'shop');
  check(shop && shop.canWrite === false && shop.sharedWithMe, 'user sees it with canWrite=false');
  const q = (sql, extra = {}) => req(ro, 'POST', '/api/query', { dbKeys: ['shop'], sql, databases: { shop: 'diag' }, ...extra });
  r = await q('SELECT COUNT(*) AS n FROM customers; SHOW TABLES; USE diag; DESCRIBE orders');
  check(r.data.results[0].ok && r.data.results[0].statements.length === 4, 'SELECT / SHOW / USE / DESCRIBE run');
  r = await q("UPDATE customers SET name = 'x'");
  check(!r.data.results[0].ok && /Read-only/.test(r.data.results[0].statements[0].error), 'UPDATE refused', r.data.results[0].statements[0].error);
  r = await q('SELECT 1; DELETE FROM customers');
  check(!r.data.results[0].ok && r.data.results[0].statements.length === 1 && /DELETE/.test(r.data.results[0].statements[0].error), 'batch with a write is refused before anything runs');
  r = await q('SELECT sneaky()');
  check(!r.data.results[0].ok && mysql('SELECT COUNT(*) FROM notes') === '0', 'writing function blocked by the read-only transaction', r.data.results[0].statements[0].error);
  r = await q("SELECT * FROM customers INTO OUTFILE '/tmp/x.csv'");
  check(!r.data.results[0].ok && /OUTFILE/.test(r.data.results[0].statements[0].error), 'INTO OUTFILE refused');
  r = await q('/* hi */ select 1');
  check(r.data.results[0].ok, 'leading comment ok');
  r = await q('SELECT * FROM customers', { explain: true });
  check(r.data.results[0].ok, 'EXPLAIN works');
  r = await req(ro, 'GET', '/api/explore/shop/diag/customers/rows?page=1&pageSize=10');
  check(r.status === 200, 'browse rows', r.status);
  r = await req(ro, 'GET', '/api/explore/shop/diag/export?options=' + encodeURIComponent(JSON.stringify({ format: 'sql', tables: ['customers'] })));
  check(r.status === 200, 'export allowed', r.status);
  for (const [m, path, body] of [
    ['POST', '/api/explore/shop/diag/customers/rows', { values: { name: 'zz' } }],
    ['PUT', '/api/explore/shop/diag/customers/rows', { where: { id: 1 }, values: { name: 'zz' } }],
    ['DELETE', '/api/explore/shop/diag/customers/rows', { where: { id: 1 } }],
    ['POST', '/api/explore/shop/diag/tables', { name: 't2', columns: [{ name: 'id', type: 'INT' }] }],
    ['POST', '/api/explore/shop/diag/table-actions', { action: 'truncate', tables: ['customers'] }],
    ['POST', '/api/explore/shop/diag/objects/save', { kind: 'view', sql: 'CREATE VIEW v AS SELECT 1' }],
    ['POST', '/api/explore/shop/diag/customers/indexes', { action: 'add', name: 'i', columns: ['name'] }],
    ['POST', '/api/explore/shop/databases', { name: 'nope' }],
    ['DELETE', '/api/explore/shop/diag', {}],
    ['POST', '/api/explore/shop/diag/restore', {}],
    ['POST', '/api/explore/shop/diag/customers/import', {}]
  ]) {
    r = await req(ro, m, path, body);
    check(r.status === 403, `${m} ${path.replace('/api/explore/shop/diag', '')} → 403`, r.status);
  }
  check(mysql('SELECT COUNT(*) FROM customers') === '2' && mysql("SELECT COUNT(*) FROM customers WHERE name='zz'") === '0', 'data unchanged');
  r = await req(ro, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], readOnly: false });
  check(r.status === 403, 'shared user cannot lift read-only', r.status);
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'] });
  check(r.data.sharePermissions.rouser.length === 0, 'omitting readOnly keeps the setting');
  await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], readOnly: false });
  r = await q("UPDATE customers SET name = 'ann2' WHERE name = 'ann'");
  check(r.data.results[0].ok && mysql("SELECT COUNT(*) FROM customers WHERE name='ann2'") === '1', 'full share: UPDATE runs again');
  r = await req(admin, 'POST', '/api/query', { dbKeys: ['shop'], sql: "UPDATE customers SET name = 'ann' WHERE name = 'ann2'", databases: { shop: 'diag' } });
  check(r.data.results[0].ok, 'owner unaffected');
  await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], readOnly: true });
  } finally {
    await srv.stop();
  }
  T.finish();
});
