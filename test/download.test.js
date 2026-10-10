// Ported from the original ad-hoc scripts: query result download.
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
const rssMb = (pid) => Number((fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1]) / 1024;
test('query result download', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  const N = seed.big();
  seed.diag();
  try {
  const admin = await login('admin', 'admin123!');
  const post = (cookie, fields) => fetch(B + '/api/query/export', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: 'shop', database: 'big', ...fields }) });
  const text = async (r) => Buffer.from(await r.arrayBuffer()).toString('utf8');
  const lines = (t) => t.split('\r\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const countLines = async (r) => { let n = 0, tail = ''; for await (const c of Readable.fromWeb(r.body)) { const s = tail + c.toString('latin1'); const parts = s.split('\n'); tail = parts.pop(); n += parts.length; } return n + (tail ? 1 : 0); };

  // ---- the full result, ignoring the preview LIMIT
  const sql = 'SELECT id, customer_id, kind FROM events LIMIT 10';
  let r = await post(admin, { sql });
  let t = await text(r);
  check(r.status === 200 && lines(t).length === 11 && /^id,customer_id,kind\r\n/.test(t), 'without "ignore LIMIT" the download is the 10 rows asked for', lines(t).length - 1);
  check(/attachment; filename="query-result-\d{8}-\d{4}\.csv"/.test(r.headers.get('content-disposition')) && /text\/csv/.test(r.headers.get('content-type')), 'attachment with a timestamped name');
  const pid = srv.pid;
  let peak = rssMb(pid);
  const timer = setInterval(() => { peak = Math.max(peak, rssMb(pid)); }, 100);
  const base = rssMb(pid);
  const t0 = Date.now();
  r = await post(admin, { sql, stripLimit: '1' });
  const n = await countLines(r);
  clearInterval(timer);
  check(n === N + 1, 'ignoring the LIMIT downloads every row (all rows + header)', n);
  console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s, server RSS ${base.toFixed(0)} → peak ${peak.toFixed(0)} MB`);
  check(peak - base < 120, 'memory stays flat while streaming a million rows', `+${(peak - base).toFixed(0)} MB`);
  for (const [label, q, expectAll] of [
    ['LIMIT n OFFSET m', 'SELECT id FROM events LIMIT 5 OFFSET 7', true], ['LIMIT m, n', 'SELECT id FROM events LIMIT 5, 10', true],
    ['lower case, trailing ;', 'select id from events limit 3;', true], ['subquery LIMIT is kept', 'SELECT id FROM (SELECT id FROM events LIMIT 3) x', false],
    ['LIMIT inside a string', "SELECT 'a limit 5' AS s FROM events LIMIT 2", true]
  ]) {
    r = await post(admin, { sql: q, stripLimit: '1', maxRows: '2000' });
    const c = lines(await text(r)).length - 1;
    check(expectAll ? c === 2000 : c === 3, `LIMIT handling: ${label}`, c);
  }
  const db = require('/home/user/db-console/api/db');
  check(db.stripTrailingLimit('SELECT 1 FROM t LIMIT 10') === 'SELECT 1 FROM t' && db.stripTrailingLimit('SELECT 1 /* c */') === 'SELECT 1 /* c */' && db.stripTrailingLimit('SELECT * FROM (SELECT 1 LIMIT 2) x') === 'SELECT * FROM (SELECT 1 LIMIT 2) x', 'stripTrailingLimit unit cases');

  // ---- formats
  r = await post(admin, { sql: "SELECT NULL AS a, '' AS b, 'x,\"y\"\nz' AS c, 1 AS a", bom: '1', nulls: 'empty' });
  t = await text(r);
  check(t === '\uFEFFa,b,c,a\r\n,,"x,""y""\nz",1\r\n', 'CSV: NULL as empty, quoting, duplicate column names kept', JSON.stringify(t));
  r = await post(admin, { sql: "SELECT NULL AS a, 'NULL' AS b", nulls: 'null' });
  check(await text(r) === 'a,b\r\nNULL,NULL\r\n', 'NULL written as NULL, no BOM when not asked');
  r = await post(admin, { sql: "SELECT NULL AS a, '\\\\N' AS b", nulls: '\\N' });
  check(await text(r) === 'a,b\r\n\\N,"\\N"\r\n', 'NULL as \\N, a real \\N text is quoted', JSON.stringify(await (async () => '')()));
  r = await post(admin, { sql: "SELECT 'a\tb' AS x, NULL AS y", format: 'tsv', nulls: 'empty' });
  t = await text(r);
  check(t === 'x\ty\na\\tb\t\n' && /tab-separated/.test(r.headers.get('content-type')) && /\.tsv"/.test(r.headers.get('content-disposition')), 'TSV: tab escaped, .tsv name', JSON.stringify(t));
  r = await post(admin, { sql: 'SELECT id, kind FROM events WHERE id < 5000', gzip: '1' });
  const gz = Buffer.from(await r.arrayBuffer());
  const unz = zlib.gunzipSync(gz).toString();
  check(/\.csv\.gz"/.test(r.headers.get('content-disposition')) && lines(unz).length === 5001 && gz.length < unz.length / 2, 'gzip: valid .csv.gz, smaller', { rows: lines(unz).length - 1, gz: gz.length, plain: unz.length });
  r = await post(admin, { sql: 'SELECT id, raw FROM events WHERE id = 1' });
  t = await text(r);
  check(/^id,raw\r\n1,AAAAAAAAAAE=\r\n$/.test(t.replace('\uFEFF', '')), 'binary values as Base64', JSON.stringify(t));
  r = await post(admin, { sql: 'SELECT payload FROM events WHERE id = 1' });
  check((await text(r)).includes('"{""n"": 1, ""s"": ""x\\""y""}"') || (await text(r)).includes('{""n"": 1'), 'JSON written exactly as stored');
  r = await post(admin, { sql: 'SHOW TABLES' });
  check(r.status === 200 && lines(await text(r)).length >= 3, 'SHOW works');
  r = await post(admin, { sql: 'EXPLAIN SELECT * FROM events WHERE id = 1' });
  check(r.status === 200 && /select_type/i.test(await text(r)), 'EXPLAIN works');
  r = await post(admin, { sql: 'WITH x AS (SELECT 1 AS n UNION SELECT 2) SELECT * FROM x' });
  check(lines(await text(r)).length === 3, 'WITH works');
  r = await post(admin, { sql: 'SELECT id FROM events', maxRows: '1000', stripLimit: '1' });
  check(lines(await text(r)).length === 1001, 'stop after N rows: exactly 1,000');
  await new Promise((rs) => setTimeout(rs, 800));
  check(mysql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND INFO LIKE '%FROM events%' AND INFO NOT LIKE '%PROCESSLIST%'") === '0', '…and the query was stopped on the server');

  // ---- errors come back as JSON before any file starts
  for (const [label, q, re] of [['DELETE', 'DELETE FROM customers', /return rows/], ['UPDATE', 'UPDATE customers SET name=1', /return rows/], ['DROP', 'DROP TABLE x', /return rows/], ['CALL', 'CALL p()', /return rows/], ['two statements', 'SELECT 1; SELECT 2', /one statement/], ['empty', '', /one statement/], ['syntax error', 'SELECT FROM WHERE', /syntax/i], ['missing table', 'SELECT * FROM no_such_table', /doesn't exist/], ['INTO OUTFILE', "SELECT 1 INTO OUTFILE '/tmp/x'", /OUTFILE/], ['USE', 'USE shop', /return rows/]]) {
    r = await post(admin, { sql: q });
    const d = await r.json().catch(() => ({}));
    check(r.status === 400 && re.test(d.error || ''), `refused: ${label}`, d.error);
  }
  check(mysql('SELECT COUNT(*) FROM diag.customers') !== '0', 'refused statements ran nothing');
  r = await fetch(B + '/api/query/export', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: 'shop', sql: 'SELECT 1' }) });
  check(r.status === 401, 'not signed in → 401', r.status);
  r = await post(admin, { key: 'nope', sql: 'SELECT 1' });
  check(r.status === 404, 'unknown connection → 404');

  // ---- the database a statement ran in (after a USE)
  r = await fetch(B + '/api/query', { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ dbKeys: ['shop'], sql: 'SELECT DATABASE() AS d; USE diag; SELECT DATABASE() AS d; SELECT * FROM customers', databases: { shop: 'big' } }) });
  const st = (await r.json()).results[0].statements;
  check(st[0].database === 'big' && st[1].database === 'big' && st[2].database === 'diag' && st[3].database === 'diag', 'each statement reports the database it ran in', st.map((s) => s.database));
  r = await post(admin, { sql: 'SELECT name FROM customers', database: 'diag' });
  check(/ann/.test(await text(r)), 'download runs in that database');

  // ---- access
  for (const u of ['dlviewer', 'dlnone']) await fetch(B + '/api/users', { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: u + '-pass-1', role: 'user', displayName: u }) });
  await fetch(B + '/api/connections/shop/sharing', { method: 'PUT', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedWith: ['dlviewer'], permissions: { dlviewer: [] } }) });
  const viewer = await login('dlviewer', 'dlviewer-pass-1');
  r = await post(viewer, { sql: 'SELECT id FROM events WHERE id < 10', maxRows: '5' });
  check(r.status === 200 && lines(await text(r)).length === 6, 'a read-only user can download SELECT results');
  r = await post(viewer, { sql: "SELECT * FROM events INTO OUTFILE '/tmp/zz'" });
  check(r.status === 400, 'read-only user: INTO OUTFILE refused');
  r = await post(viewer, { sql: 'SELECT sneaky()', database: 'diag' });
  check(r.status === 400 || (r.status === 200 && !(await text(r)).includes('1\r\n')) , 'a writing function cannot run in a download');
  mysql("CREATE DATABASE IF NOT EXISTS diag; DROP FUNCTION IF EXISTS diag.sneaky_w;\nDELIMITER ;;\nCREATE FUNCTION diag.sneaky_w() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO diag.notes VALUES (777,'w'); RETURN 1; END;;\nDELIMITER ;\n");
  r = await post(admin, { sql: 'SELECT diag.sneaky_w() AS v', database: 'diag' });
  const body = r.status === 400 ? (await r.json()).error : await text(r);
  check(mysql('SELECT COUNT(*) FROM diag.notes WHERE id = 777') === '0', 'downloads run in a READ ONLY transaction: a writing function fails', String(body).slice(0, 80));
  const dlnone = await login('dlnone', 'dlnone-pass-1');
  r = await post(dlnone, { sql: 'SELECT 1' });
  check(r.status === 404, 'a user without access to the connection → 404');
  await fetch(B + '/api/connections/shop/sharing', { method: 'PUT', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedWith: [] }) });

  // ---- cancel
  await new Promise((resolve) => {
    const body = new URLSearchParams({ key: 'shop', database: 'big', sql: 'SELECT * FROM events', stripLimit: '1' }).toString();
    const req = http.request({ host: 'localhost', port: srv.port, path: '/api/query/export', method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let got = 0;
      res.on('data', (c) => { got += c.length; if (got > 2e6) { req.destroy(); resolve(); } });
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.end(body);
  });
  await new Promise((rs) => setTimeout(rs, 1500));
  check(mysql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND INFO LIKE '%FROM events%' AND INFO NOT LIKE '%PROCESSLIST%'") === '0', 'cancelling a download stops its query');
  r = await post(admin, { sql: 'SELECT 1 AS ok' });
  check(r.status === 200, 'server still answers');

  // ---- query log
  const log = await (await fetch(B + '/api/logs?source=export&limit=200', { headers: { cookie: admin } })).json();
  const entries = log.entries || log;
  check(Array.isArray(entries) && entries.some((e) => e.source === 'export' && e.rowCount === N), 'downloads are written to the query log with their row count', Array.isArray(entries) && entries.slice(0, 2).map((e) => e.rowCount));
  mysql('DROP FUNCTION IF EXISTS diag.sneaky_w');
  } finally {
    await srv.stop();
  }
  T.finish();
});
