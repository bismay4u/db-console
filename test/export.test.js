// Ported from the original ad-hoc scripts: export, restore and round trips.
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
const objects = (db) => mysql(`SELECT CONCAT_WS(',',
  (SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}'),
  (SELECT GROUP_CONCAT(ROUTINE_NAME ORDER BY ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='${db}'),
  (SELECT GROUP_CONCAT(TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${db}'),
  (SELECT GROUP_CONCAT(EVENT_NAME) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${db}'))`);
const dataSig = (db) => mysql(`SELECT MD5(GROUP_CONCAT(CONCAT_WS('|', id, name, price, price_tax, IFNULL(note,'NULL')) ORDER BY id)) FROM ${db}.prod`);
test('export, restore and round trips', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.dropAll();
  seed.expSrc();
  try {
  const cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).headers.get('set-cookie').split(';')[0];
  const exp = async (options) => { const r = await fetch(B + '/api/explore/shop/exp_src/export?options=' + encodeURIComponent(JSON.stringify(options)), { headers: { cookie } }); return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), body: Buffer.from(await r.arrayBuffer()) }; };
  const restore = async (db, body, format) => {
    mysql(`DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db} CHARACTER SET utf8mb4`);
    const r = await fetch(B + `/api/explore/shop/${db}/restore?format=${format}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/octet-stream' }, body });
    const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    return events.find((e) => e.type === 'done') || events.find((e) => e.type === 'error');
  };
  const src = objects('exp_src');
  let e = await exp({ format: 'sql' });
  const dump = e.body.toString('utf8');
  check(e.status === 200 && /exp_src-\d{8}-\d{4}\.sql/.test(e.disp) && /DELIMITER ;;/.test(dump) && /CREATE PROCEDURE/.test(dump) && !/DEFINER=/.test(dump), 'SQL export includes routines/triggers/events, no DEFINER', e.disp);
  check(!/price_tax`\) VALUES/.test(dump) && /INSERT INTO `prod` \(`id`, `name`, `price`, `note`\)/.test(dump), 'generated column left out of INSERTs');
  let d = await restore('exp_r1', e.body, 'sql');
  check(d.failed === 0, 'restore .sql: no failures', { executed: d.executed, failed: d.failed, errors: d.errors });
  check(objects('exp_r1') === src && dataSig('exp_r1') === dataSig('exp_src'), 'restored objects and data identical', objects('exp_r1'));
  check(mysql('SELECT exp_r1.twice(21)') === '42', 'restored function works');
  mysql("CALL exp_r1.add_prod('New')");
  check(mysql("SELECT msg FROM exp_r1.audit ORDER BY id DESC LIMIT 1") === 'added New', 'restored procedure + trigger work');
  check(mysql("SELECT COUNT(*) FROM exp_r1.audit") === '1', 'trigger did not fire during the data restore (only for the new row)');

  e = await exp({ format: 'sql.gz' });
  check(e.status === 200 && e.body[0] === 0x1f && e.body[1] === 0x8b && zlib.gunzipSync(e.body).toString().includes('CREATE TRIGGER'), 'SQL gzip export', e.disp);
  d = await restore('exp_r2', e.body, 'sqlgz');
  check(d.failed === 0 && objects('exp_r2') === src && dataSig('exp_r2') === dataSig('exp_src'), 'restore .sql.gz identical', { failed: d.failed });

  // The real mysqldump / mariadb-dump (if installed) must restore too.
  const dumpBin = ['mysqldump', 'mariadb-dump'].find((b) => { try { execSync(`command -v ${b}`, { stdio: 'ignore' }); return true; } catch (e) { return false; } });
  if (dumpBin) {
  const dumped = execSync(`${dumpBin} -h ${T.DB.host} -P ${T.DB.port} -u ${T.DB.user} --routines --triggers --events --default-character-set=utf8mb4 exp_src`, { env: { ...process.env, MYSQL_PWD: T.DB.password }, maxBuffer: 1 << 28 });
  d = await restore('exp_r3', dumped, 'sql');
  check(d.failed === 0 && objects('exp_r3') === src && dataSig('exp_r3') === dataSig('exp_src'), 'restore real mysqldump output (DELIMITER blocks)', { executed: d.executed, failed: d.failed, errors: d.errors });
  }

  e = await exp({ format: 'sql', tables: ['prod'], structure: 'none', routines: false, triggers: false, events: false, views: false });
  const partial = e.body.toString();
  check(!/CREATE TABLE/.test(partial) && /INSERT INTO `prod`/.test(partial) && !/audit/.test(partial) && !/PROCEDURE/.test(partial), 'options: one table, data only, no routines');
  e = await exp({ format: 'sql', data: false, structure: 'create' });
  check(!/INSERT INTO `/.test(e.body.toString()) && !/DROP TABLE/.test(e.body.toString()) && /CREATE TABLE `prod`/.test(e.body.toString()), 'options: structure only, CREATE without DROP');

  e = await exp({ format: 'tsv', tables: ['prod'] });
  const tsv = e.body.toString().split('\n');
  check(/prod\.tsv/.test(e.disp) && tsv[1] === '1\tCafé ☕\t3.50\t4.20\tline1\\nline2\\ttab' && tsv[2].endsWith('\t\\N'), 'TSV single table (escapes, \\N)', tsv.slice(0, 3));
  e = await exp({ format: 'csv' });
  const tarFile = __dirname + '/exp.tar.gz'; fs.writeFileSync(tarFile, e.body);
  const listing = execSync(`tar tzf ${tarFile}`).toString().trim().split('\n').sort();
  check(/exp_src-csv-\d{8}-\d{4}\.tar\.gz/.test(e.disp) && JSON.stringify(listing) === JSON.stringify(['audit.csv', 'cheap.csv', 'prod.csv']), 'CSV multi-table export is a tar.gz of CSV files', listing);
  const prodCsv = execSync(`tar xzf ${tarFile} -O prod.csv`).toString();
  check(prodCsv.includes('"Semi;colon"') || prodCsv.includes('Semi;colon'), 'CSV content', prodCsv.split('\r\n')[3]);
  } finally {
    await srv.stop();
  }
  T.finish();
});
