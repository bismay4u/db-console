// Ported from the original ad-hoc scripts: data grid: binary keys, JSON, inline edit, multi-sort.
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
const mysql = (sql) => T.mysql(sql);
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('data grid: binary keys, JSON, inline edit, multi-sort', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.shop();
  try {
  const cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => { const r = await fetch(B + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { d = t; } return { status: r.status, data: d, raw: t }; };
  const T = '/api/explore/shop/shop/gadgets';
  let r = await call('GET', T + '/rows?sort=' + encodeURIComponent(JSON.stringify([{ col: 'kind', dir: 'desc' }, { col: 'name', dir: 'asc' }])));
  check(r.data.rows.map((x) => x.name).join(',') === 'Apple,Ball,Hammer', 'multi-column sort (kind desc, name asc)', r.data.rows.map((x) => x.name));
  const hammer = r.data.rows.find((x) => x.name === 'Hammer');
  check(hammer.id.__hex === '00112233445566778899aabbccddeeff' && hammer.photo.__blob && hammer.photo.size === 500 && hammer.doc.w === 2, 'binary key as hex, blob as size placeholder, JSON as object', { id: hammer.id, photo: hammer.photo });
  r = await call('PUT', T + '/rows', { where: { id: hammer.id }, changes: { name: { __fn: 'UPPER', arg: 'claw hammer' }, updated: { __fn: 'NOW' }, notes: null } });
  check(r.status === 200 && r.data.affectedRows === 1, 'edit by binary key with functions', r.data);
  check(mysql("SELECT CONCAT(name,'|',updated IS NOT NULL AND updated > '2025-01-01','|',IFNULL(notes,'NULL')) FROM shop.gadgets WHERE id=UNHEX('00112233445566778899aabbccddeeff')") === 'CLAW HAMMER|1|NULL', 'UPPER(value), NOW() and NULL applied');
  r = await call('PUT', T + '/rows', { where: { id: hammer.id }, changes: { photo: { __base64: Buffer.from('PNGDATA').toString('base64') } } });
  check(mysql("SELECT photo FROM shop.gadgets WHERE id=UNHEX('00112233445566778899aabbccddeeff')") === 'PNGDATA', 'upload replaces blob');
  r = await call('GET', T + '/cell?where=' + encodeURIComponent(JSON.stringify({ id: hammer.id })) + '&col=photo');
  check(r.raw === 'PNGDATA', 'download cell returns raw bytes', r.raw);
  r = await call('POST', T + '/rows', { values: { id: { __hex: 'aa'.repeat(16) }, name: 'Kite', kind: "it's", doc: '{"a":[1,2]}', made: { __fn: 'CURDATE' } } });
  check(r.status === 201 && mysql("SELECT CONCAT(name,'|',kind,'|',JSON_EXTRACT(doc,'$.a[1]'),'|',made=CURDATE()) FROM shop.gadgets WHERE id=UNHEX(REPEAT('aa',16))") === "Kite|it's|2|1", 'insert with hex key, enum with quote, JSON, CURDATE()');
  r = await call('PUT', T + '/rows', { where: { id: hammer.id }, changes: { name: { __fn: 'SLEEP', arg: 5 } } });
  check(r.status === 400 && /Unsupported function/.test(r.data.error), 'unknown function rejected', r.data.error);
  r = await call('PUT', T + '/rows', { where: { id: hammer.id }, changes: { photo: { __blob: true, size: 500 } } });
  check(r.status === 400, 'blob placeholder cannot be written back', r.data.error);
  r = await call('DELETE', T + '/rows', { where: { id: { __hex: 'aa'.repeat(16) } } });
  check(r.data.affectedRows === 1, 'delete by binary key');
  r = await call('POST', '/api/query', { dbKeys: ['shop'], sql: 'SELECT id, photo FROM gadgets ORDER BY name LIMIT 1' });
  const rr = r.data.results[0].statements[0].rows[0];
  check(rr.id.__hex && (rr.photo === null || rr.photo.__hex || rr.photo.__blob), 'query runner encodes binary too', rr);
  } finally {
    await srv.stop();
  }
  T.finish();
});
