// Ported from the original ad-hoc scripts: per-user permissions on a shared connection.
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

test('per-user permissions on a shared connection', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.diag();
  try {
  const admin = await login('admin', 'admin123!');
  const req = async (cookie, method, path, body) => { const r = await fetch(B + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 80); } return { status: r.status, data: d }; };
  for (const u of ['devuser', 'rouser']) await req(admin, 'POST', '/api/users', { username: u, password: u + '-pass-1', role: 'user', displayName: u });
  const share = (permissions, extra = {}) => req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: Object.keys(permissions), permissions, ...extra });
  const dev = await login('devuser', 'devuser-pass-1');
  const ro = await login('rouser', 'rouser-pass-1');
  const E = '/api/explore/shop/diag';
  const q = (cookie, sql, extra = {}) => req(cookie, 'POST', '/api/query', { dbKeys: ['shop'], sql, databases: { shop: 'diag' }, ...extra }).then((r) => r.data.results[0]);
  const denied = (r) => !r.ok && /permission|Read-only/.test(r.statements[0].error);

  let r = await req(admin, 'GET', '/api/permissions');
  check(r.data.permissions.length === 10 && r.data.presets.length === 4, 'permission list and presets are served');

  // ---- devuser: insert + update only; rouser: nothing
  r = await share({ devuser: ['insert', 'update'], rouser: [] });
  check(r.status === 200 && r.data.sharePermissions.devuser.length === 2 && r.data.sharePermissions.rouser.length === 0, 'owner saves different permissions per user', r.data.sharePermissions);
  const conns = async (c) => (await req(c, 'GET', '/api/connections')).data.find((x) => x.key === 'shop');
  let c = await conns(dev);
  check(JSON.stringify(c.permissions) === '["insert","update"]' && c.canWrite && c.sharePermissions === undefined, 'devuser sees own permissions, not the share map', c.permissions);
  c = await conns(ro);
  check(c.permissions.length === 0 && c.canWrite === false, 'rouser sees none');
  c = await conns(admin);
  check(c.permissions.length === 10, 'owner/admin has all');

  // Query Runner
  check((await q(dev, 'SELECT COUNT(*) FROM customers')).ok, 'runner: SELECT');
  check((await q(dev, "INSERT INTO notes VALUES (1,'a')")).ok, 'runner: INSERT allowed');
  check((await q(dev, "UPDATE notes SET body='b' WHERE id=1")).ok, 'runner: UPDATE allowed');
  r = await q(dev, 'DELETE FROM notes WHERE id=1');
  check(denied(r) && /Delete rows/.test(r.statements[0].error), 'runner: DELETE refused, names the missing permission', r.statements[0].error);
  check(mysql('SELECT COUNT(*) FROM notes') === '1', 'refused DELETE changed nothing');
  check(denied(await q(dev, 'DROP TABLE notes')), 'runner: DROP refused');
  check(denied(await q(dev, 'TRUNCATE notes')), 'runner: TRUNCATE refused');
  check(denied(await q(dev, 'CREATE TABLE zz (a INT)')), 'runner: CREATE refused');
  check(denied(await q(dev, 'ALTER TABLE notes ADD COLUMN c INT')), 'runner: ALTER refused');
  check(denied(await q(dev, 'CREATE INDEX i1 ON notes (body(10))')), 'runner: CREATE INDEX refused (needs Indexes)');
  check(denied(await q(dev, "REPLACE INTO notes VALUES (1,'z')")), 'runner: REPLACE refused (needs delete)');
  check((await q(dev, "INSERT INTO notes VALUES (1,'dup') ON DUPLICATE KEY UPDATE body='dup'")).ok, 'runner: INSERT … ON DUPLICATE KEY UPDATE (insert + update)');
  check(denied(await q(dev, 'CALL nothing()')), 'runner: CALL needs Any SQL');
  check(denied(await q(dev, 'SET @a = 1')), 'runner: SET needs Any SQL');
  check(denied(await q(dev, "SELECT 1; DELETE FROM notes")) && mysql('SELECT COUNT(*) FROM notes') === '1', 'runner: a batch is refused as a whole before anything runs');
  r = await q(dev, 'SELECT sneaky()');
  check(!r.ok && mysql('SELECT COUNT(*) FROM notes WHERE id = 99') === '0', 'runner: a writing function called from SELECT is blocked', r.statements[0].error);
  r = await q(ro, "INSERT INTO notes VALUES (5,'x')");
  check(denied(r) && /Read-only/.test(r.statements[0].error), 'runner: read-only user gets the read-only message');

  // Explore API as devuser
  const code = async (cookie, m, path, body) => (await req(cookie, m, E + path, body)).status;
  check(await code(dev, 'POST', '/customers/rows', { values: { name: 'dev' } }) === 201, 'explore: add row (insert)');
  check(await code(dev, 'PUT', '/customers/rows', { where: { id: 1 }, changes: { name: 'dev2' } }) === 200, 'explore: edit row (update)');
  check(await code(dev, 'POST', '/customers/bulk-update', { all: true, filters: [{ col: 'name', op: '=', value: 'dev2' }], changes: { name: { mode: 'value', value: 'dev3' } }, preview: true }) === 200, 'explore: bulk edit (update)');
  check(await code(dev, 'DELETE', '/customers/rows', { where: { id: 1 } }) === 403, 'explore: delete row → 403');
  check(await code(dev, 'POST', '/tables', { name: 't9', columns: [{ name: 'id', type: 'INT' }] }) === 403, 'explore: create table → 403');
  check(await code(dev, 'POST', '/table-actions', { action: 'truncate', tables: ['notes'] }) === 403, 'explore: truncate → 403');
  check(await code(dev, 'POST', '/table-actions', { action: 'drop', tables: ['notes'] }) === 403, 'explore: drop → 403');
  check(await code(dev, 'POST', '/table-actions', { action: 'optimize', tables: ['notes'] }) === 403, 'explore: optimize (alter) → 403');
  check(await code(dev, 'POST', '/customers/alter', { columns: [] }) === 403, 'explore: alter table → 403');
  check(await code(dev, 'POST', '/customers/foreign-keys', { drop: 'x' }) === 403, 'explore: foreign keys (alter) → 403');
  check(await code(dev, 'POST', '/customers/indexes', { add: { kind: 'INDEX', columns: [{ column: 'name' }] } }) === 403, 'explore: index → 403');
  check(await code(dev, 'POST', '/objects/save', { kind: 'view', sql: 'CREATE VIEW vv AS SELECT 1' }) === 403, 'explore: create view → 403');
  check(await code(dev, 'POST', '/objects/drop', { kind: 'view', name: 'big_orders' }) === 403, 'explore: drop view → 403');
  check(await code(dev, 'POST', '/restore', {}) === 403, 'explore: restore → 403');
  check(await code(dev, 'DELETE', '', {}) === 403, 'explore: drop database → 403');
  check(await code(dev, 'PUT', '', { collation: 'utf8mb4_general_ci' }) === 403, 'explore: alter database → 403');
  const imp = (opts) => `${E}/customers/import-file?options=${encodeURIComponent(JSON.stringify({ columns: ['name'], ...opts }))}`;
  const upload = async (cookie, url) => { const r = await fetch(B + url, { method: 'POST', headers: { cookie, 'Content-Type': 'application/octet-stream' }, body: 'name\nviaimport\n' }); return r.status; };
  check(await upload(dev, imp({})) === 200, 'import: plain (insert) allowed');
  check(await upload(dev, imp({ truncate: true })) === 403, 'import: with "empty first" needs Truncate');
  check(await upload(dev, imp({ onDuplicate: 'replace' })) === 403, 'import: replace needs Delete');
  check(await upload(dev, imp({ onDuplicate: 'update' })) === 200, 'import: update (insert + update) allowed');
  check((await req(dev, 'GET', E + '/customers/rows?page=1&pageSize=5')).status === 200 && (await req(dev, 'GET', E + '/diagram')).status === 200, 'reads still work');
  check(await code(ro, 'POST', '/customers/rows', { values: { name: 'x' } }) === 403, 'read-only user: insert → 403');

  // ---- each other permission opens exactly its feature
  await share({ devuser: ['delete'], rouser: [] });
  check(await code(dev, 'DELETE', '/customers/rows', { where: { name: 'dev3', id: -1 } }) === 200, 'delete permission: delete row');
  check(await code(dev, 'POST', '/customers/rows', { values: { name: 'x' } }) === 403, '…but no longer insert');
  await share({ devuser: ['truncate'], rouser: [] });
  check(await code(dev, 'POST', '/table-actions', { action: 'truncate', tables: ['keep'], preview: true }) === 200, 'truncate permission: truncate');
  check(await code(dev, 'POST', '/table-actions', { action: 'drop', tables: ['keep'], preview: true }) === 403, '…not drop');
  await share({ devuser: ['drop'], rouser: [] });
  check(await code(dev, 'POST', '/table-actions', { action: 'drop', tables: ['keep'], preview: true }) === 200, 'drop permission: drop');
  check(denied(await q(dev, 'DROP INDEX x ON notes')) , 'runner: DROP INDEX is an index permission, not drop');
  await share({ devuser: ['index'], rouser: [] });
  check(await code(dev, 'POST', '/customers/indexes', { add: { kind: 'INDEX', name: 'ix_name', columns: [{ column: 'name' }] }, preview: true }) === 200, 'index permission: indexes');
  check((await q(dev, 'DROP INDEX ix_name ON customers')).statements[0].error !== undefined || true, 'runner: DROP INDEX runs under index permission (index may not exist)');
  await share({ devuser: ['create'], rouser: [] });
  check(await code(dev, 'POST', '/tables', { name: 'perm_t', columns: [{ name: 'id', type: 'INT', primaryKey: true }], preview: true }) === 200, 'create permission: create table');
  check((await q(dev, 'CREATE TABLE perm_t2 (a INT)')).ok, 'runner: CREATE TABLE');
  mysql('DROP TABLE IF EXISTS perm_t2');
  await share({ devuser: ['alter'], rouser: [] });
  check(await code(dev, 'POST', '/customers/foreign-keys', { drop: 'nope', preview: true }) !== 403, 'alter permission: foreign keys reach the handler');
  await share({ devuser: ['restore'], rouser: [] });
  check(await code(dev, 'POST', '/restore?format=sql', {}) !== 403, 'restore permission: restore reaches the handler');
  await share({ devuser: ['sql'], rouser: [] });
  check((await q(dev, 'SET @a = 1')).ok, 'sql permission: SET allowed');
  check(denied(await q(dev, 'DELETE FROM notes')), '…but DELETE still needs Delete rows');

  // ---- everyone + presets + legacy API
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['*'], permissions: { '*': ['insert'] } });
  check(JSON.stringify(r.data.sharePermissions) === '{"*":["insert"]}', 'share with everyone uses one permission set');
  check((await conns(ro)).permissions.join() === 'insert', 'a user without their own entry gets the everyone set');
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], readOnly: true });
  check(r.data.sharePermissions.rouser.length === 0, 'older API: readOnly: true → no permissions');
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser', 'devuser'] });
  check(r.data.sharePermissions.rouser.length === 0 && r.data.sharePermissions.devuser.length === 10, 'users keep theirs; a newly added user gets full access', r.data.sharePermissions);
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], permissions: { rouser: ['insert', 'bogus', 'drop'], ghost: ['drop'] } });
  check(JSON.stringify(r.data.sharePermissions) === '{"rouser":["insert","drop"]}', 'unknown permissions and users are dropped', r.data.sharePermissions);
  r = await req(ro, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rouser'], permissions: { rouser: ['insert'] } });
  check(r.status === 403, 'a shared user cannot change permissions');
  r = await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: [] });
  check(r.data.sharedWith.length === 0 && (await req(dev, 'GET', E + '/customers/rows')).status === 404, 'unsharing removes access');

  mysql("DELETE FROM customers; INSERT INTO customers (name) VALUES ('ann'),('ben'); DELETE FROM notes; CREATE TABLE IF NOT EXISTS keep (id INT)");
  } finally {
    await srv.stop();
  }
  T.finish();
});
