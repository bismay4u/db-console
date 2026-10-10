// Ported from the original ad-hoc scripts: cancelled exports, imports and restores.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = () => mysql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND INFO LIKE '%big%' AND INFO NOT LIKE '%PROCESSLIST%'");
const conns = () => Number(mysql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = '"+T.DB.user+"'"));
test('cancelled exports, imports and restores', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.big();
  try {
  const cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).headers.get('set-cookie').split(';')[0];
  const before = conns();

  // Export: read 2 MB, then drop the connection.
  for (const format of ['sql.gz', 'sql', 'csv']) {
    await new Promise((resolve) => {
      const req = http.get({ host: 'localhost', port: srv.port, path: `/api/explore/shop/big/export?options=${encodeURIComponent(JSON.stringify({ format, tables: ['events'] }))}`, headers: { cookie } }, (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; if (n > 2e6) { req.destroy(); resolve(); } });
        res.on('end', resolve);
      });
      req.on('error', resolve);
    });
    await sleep(1500);
    check(busy() === '0', `export ${format} cancelled: no query left running`);
  }

  // Upload that stops halfway (restore and atomic import).
  const partialUpload = (url, file, bytes) => new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: srv.port, path: url, method: 'POST', headers: { cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size } });
    req.on('error', () => resolve());
    req.on('response', (res) => res.resume());
    const rs = fs.createReadStream(file, { end: bytes });
    rs.pipe(req, { end: false });
    rs.on('end', () => setTimeout(() => { req.destroy(); resolve(); }, 800));
  });

  // Make a CSV and a dump to upload.
  const csv = path.join(S, 'cancel.csv');
  await new Promise((resolve) => http.get({ host: 'localhost', port: srv.port, path: `/api/explore/shop/big/export?options=${encodeURIComponent(JSON.stringify({ format: 'csv', tables: ['events'] }))}`, headers: { cookie } },
    (res) => res.pipe(fs.createWriteStream(csv)).on('finish', resolve)));
  mysql('DROP DATABASE IF EXISTS big_c; CREATE DATABASE big_c; CREATE TABLE big_c.customers LIKE big.customers; INSERT INTO big_c.customers SELECT * FROM big.customers; CREATE TABLE big_c.events LIKE big.events;');
  const cols = mysql("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='big' AND TABLE_NAME='events'").split(',').map((c) => (c === 'amount_x2' ? null : c));
  await partialUpload(`/api/explore/shop/big_c/events/import-file?options=${encodeURIComponent(JSON.stringify({ columns: cols, atomic: true }))}`, csv, Math.floor(fs.statSync(csv).size * 0.4));
  await sleep(1500);
  check(mysql('SELECT COUNT(*) FROM big_c.events') === '0' && busy() === '0', 'atomic import cancelled halfway: nothing kept, nothing running');
  await partialUpload(`/api/explore/shop/big_c/events/import-file?options=${encodeURIComponent(JSON.stringify({ columns: cols, atomic: false }))}`, csv, Math.floor(fs.statSync(csv).size * 0.4));
  await sleep(1500);
  const kept = Number(mysql('SELECT COUNT(*) FROM big_c.events'));
  check(kept > 0 && kept % 10000 === 0 && busy() === '0', 'non-atomic import cancelled: committed batches kept', kept);

  const dump = path.join(S, 'cancel.sql');
  await new Promise((resolve) => http.get({ host: 'localhost', port: srv.port, path: `/api/explore/shop/big/export?options=${encodeURIComponent(JSON.stringify({ format: 'sql' }))}`, headers: { cookie } },
    (res) => res.pipe(fs.createWriteStream(dump)).on('finish', resolve)));
  mysql('DROP DATABASE IF EXISTS big_c2; CREATE DATABASE big_c2;');
  await partialUpload('/api/explore/shop/big_c2/restore?format=sql', dump, Math.floor(fs.statSync(dump).size * 0.3));
  await sleep(1500);
  check(busy() === '0', 'restore cancelled: nothing running');

  await sleep(500);
  const after = conns();
  check(after <= before + 5, 'no connections leaked (pool size is 5)', { before, after });
  const r = await fetch(B + '/api/explore/shop/big/events/rows?page=1&pageSize=5', { headers: { cookie } });
  check(r.ok, 'server still answers');
  for (const f of [csv, dump]) fs.rmSync(f, { force: true });
  } finally {
    await srv.stop();
  }
  T.finish();
});
