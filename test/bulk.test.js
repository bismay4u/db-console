// Ported from the original ad-hoc scripts: bulk edit.
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
const mysql = (sql) => T.mysql(sql, 'bulk');
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('bulk edit', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.bulk();
  try {
  const cookie = await login('admin', 'admin123!');
  const call = async (t, body, c = cookie) => { const r = await fetch(B + '/api/explore/shop/bulk/' + t + '/bulk-update', { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  let r = await call('items', { rows: [{ id: 1 }, { id: 2 }], changes: { note: { mode: 'value', value: 'fruit' } }, preview: true });
  check(r.data.matched === 2 && /UPDATE `bulk`.`items` SET `note` = 'fruit' WHERE \(`id` = 1\) OR \(`id` = 2\)/.test(r.data.sql), 'preview selected', r.data);
  check(mysql("SELECT COUNT(*) FROM items WHERE note='fruit'") === '0', 'preview changes nothing');
  r = await call('items', { rows: [{ id: 1 }, { id: 2 }], changes: { note: { mode: 'value', value: 'fruit' }, updated: { mode: 'fn', fn: 'NOW' } } });
  check(r.data.affectedRows === 2 && mysql("SELECT COUNT(*) FROM items WHERE note='fruit' AND updated IS NOT NULL") === '2', 'selected rows updated (value + NOW())', r.data);
  r = await call('items', { all: true, filters: [{ col: 'price', op: '>=', value: '2' }], changes: { price: { mode: 'add', value: '-0.5' } } });
  check(r.data.matched === 3 && mysql('SELECT GROUP_CONCAT(price ORDER BY id) FROM items') === '1.50,0.25,2.50,1.50,3.50', 'filtered rows: add −0.5', r.data);
  r = await call('items', { all: true, filters: [{ col: '*', op: 'contains', value: 'an' }], changes: { name: { mode: 'replace', find: 'an', replace: 'AN' } } });
  check(mysql('SELECT name FROM items WHERE id=2') === 'bANANa', 'search + find & replace', r.data.matched);
  r = await call('items', { all: true, changes: { note: { mode: 'append', value: '!' }, qty: { mode: 'null' } } });
  check(r.data.matched === 5 && mysql('SELECT COUNT(*) FROM items WHERE qty IS NULL') === '5' && mysql('SELECT note FROM items WHERE id=4') === 'brown!', 'whole table: append + NULL', r.data.matched);
  r = await call('items', { rows: [{ id: 3 }], changes: { price: { mode: 'default' }, qty: { mode: 'value', value: '' } } });
  check(mysql('SELECT price, qty IS NULL FROM items WHERE id=3') === '1.00\t1', 'DEFAULT, and blank → NULL for a nullable number');
  const before = mysql('SELECT GROUP_CONCAT(name ORDER BY id) FROM items');
  r = await call('items', { all: true, changes: { name: { mode: 'value', value: null } } });
  check(r.status === 400 && mysql('SELECT GROUP_CONCAT(name ORDER BY id) FROM items') === before, 'failing update leaves everything unchanged', r.data.error);
  r = await call('items', { rows: [{ id: 1 }], changes: { 'name`; DROP TABLE items; --': { mode: 'value', value: 'x' } } });
  check(r.status === 400 && /Unknown column/.test(r.data.error), 'unknown column rejected');
  r = await call('items', { rows: [{ id: 1 }], changes: { name: { mode: 'value', value: "o'brien\\" } } });
  check(mysql('SELECT name FROM items WHERE id=1') === "o'brien\\\\", 'quotes and backslashes bound safely', mysql('SELECT name FROM items WHERE id=1'));
  r = await call('items', { rows: [{ id: 1 }], changes: { qty: { mode: 'add', value: 'abc' } } });
  check(r.status === 400, 'add needs a number', r.data.error);
  r = await call('items', { rows: [], changes: { qty: { mode: 'null' } } });
  check(r.status === 400, 'no rows selected', r.data.error);
  r = await call('items', { rows: [{ name: 'x' }], changes: { qty: { mode: 'null' } } });
  check(r.status === 400 && /identifier/.test(r.data.error), 'row without key rejected');
  r = await call('nopk', { rows: [{ a: 1 }], changes: { b: { mode: 'value', value: 'z' } } });
  check(r.status === 400 && /primary key/.test(r.data.error), 'no-PK table: selected rows refused');
  r = await call('nopk', { all: true, filters: [{ col: 'a', op: '=', value: '1' }], changes: { b: { mode: 'value', value: 'z' } } });
  check(r.data.matched === 1 && mysql('SELECT b FROM nopk WHERE a=1') === 'z', 'no-PK table: filtered update works');
  r = await call('items', { rows: Array.from({ length: 1001 }, (_, i) => ({ id: i })), changes: { qty: { mode: 'null' } } });
  check(r.status === 400, 'over 1000 selected refused');
  await fetch(B + '/api/users', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rouser', password: 'rouser-pass-1', role: 'user', displayName: 'RO' }) });
  await fetch(B + '/api/connections/shop/sharing', { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedWith: ['rouser'], readOnly: true }) });
  const ro = await login('rouser', 'rouser-pass-1');
  r = await call('items', { all: true, changes: { qty: { mode: 'null' } }, preview: true }, ro);
  check(r.status === 403, 'read-only share refused', r.status);
  } finally {
    await srv.stop();
  }
  T.finish();
});
