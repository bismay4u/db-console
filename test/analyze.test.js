// Ported from the original ad-hoc scripts: database analysis and rules.
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

test('database analysis and rules', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.anom();
  try {
  const admin = await login('admin', 'admin123!');
  const req = async (cookie, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t.slice(0, 80); } return { status: r.status, data: d }; };
  const run = async (cookie = admin) => (await req(cookie, 'GET', '/api/explore/shop/anom/analyze')).data;
  const has = (res, rule, object) => res.findings.some((f) => f.rule === rule && (!object || f.object === object));
  const get = (res, rule, object) => res.findings.find((f) => f.rule === rule && (!object || f.object === object));

  // clean slate: rule settings
  const rulesFile = path.join(S, 'sc/data/analyzer_rules.json');
  fs.rmSync(rulesFile, { force: true });

  let res = await run();
  check(res.tables === 13 && res.views === 2 && res.rulesRun >= 20, 'analysis ran', { tables: res.tables, views: res.views, rulesRun: res.rulesRun, ms: res.durationMs });
  console.log('   summary', JSON.stringify(res.summary), 'skipped', JSON.stringify(res.skipped));
  check(res.skipped.length === 0, 'no rule failed');

  check(has(res, 'no-primary-key', 'logs') && get(res, 'no-primary-key', 'logs').severity === 'error' && /ADD COLUMN `id`/.test(get(res, 'no-primary-key', 'logs').fix), 'table without primary key (error), fix adds an id');
  check(/uq_code/.test(get(res, 'no-primary-key', 'codes').message) && /ADD PRIMARY KEY \(`code`\)/.test(get(res, 'no-primary-key', 'codes').fix), 'suggests promoting a unique NOT NULL index');
  check(!has(res, 'no-primary-key', 'clean_t') && !has(res, 'no-primary-key', 'customers'), 'tables with a primary key are not flagged');
  check(has(res, 'no-secondary-index', 'logs') && !has(res, 'no-secondary-index', 'codes'), 'large table with no secondary index; tiny table not');
  check(has(res, 'unindexed-id-column', 'orders.customer_id') && /ADD INDEX `idx_customer_id`/.test(get(res, 'unindexed-id-column', 'orders.customer_id').fix), 'unindexed customer_id');
  check(!has(res, 'unindexed-id-column', 'child_int.pid') && !has(res, 'unindexed-id-column', 'customers.id'), 'indexed / primary id columns not flagged');
  check(has(res, 'duplicate-index', 'idx.dup2') && !has(res, 'duplicate-index', 'idx.dup1') && /DROP INDEX `dup2`/.test(get(res, 'duplicate-index', 'idx.dup2').fix), 'duplicate index: the later one is flagged');
  check(has(res, 'redundant-index', 'idx.ab') && has(res, 'redundant-index', 'idx.dup1') && !has(res, 'redundant-index', 'idx.abc'), 'redundant prefix indexes; the covering one is kept');
  check(has(res, 'possible-missing-fk', 'orders.customer_id') && /FOREIGN KEY \(`customer_id`\) REFERENCES `customers` \(`id`\)/.test(get(res, 'possible-missing-fk', 'orders.customer_id').fix), 'column that looks like a missing foreign key');
  check(!has(res, 'possible-missing-fk', 'child_int.pid'), 'existing foreign key not suggested again');
  check(has(res, 'non-innodb', 'old_myisam') && !has(res, 'non-innodb', 'logs'), 'MyISAM table');
  const ai = get(res, 'autoinc-overflow', 'tiny.id');
  check(ai && ai.severity === 'error' && /97\.\d%|96\.\d%/.test(ai.message), 'auto-increment nearly exhausted (error)', ai && ai.message);
  check(has(res, 'float-money', 'orders.total') && has(res, 'float-money', 'orders.price_usd') && !has(res, 'float-money', 'orders.note'), 'money in FLOAT/DOUBLE');
  check(has(res, 'legacy-charset', 'legacy') && !has(res, 'legacy-charset', 'logs'), 'latin1 table');
  check(has(res, 'collation-mismatch', 'binary_coll') && !has(res, 'collation-mismatch', 'logs'), 'table collation differs from the database default');
  check(has(res, 'invalid-view', 'broken_view') && !has(res, 'invalid-view', 'fine_view'), 'broken view found, good view not', get(res, 'invalid-view', 'broken_view') && get(res, 'invalid-view', 'broken_view').message);
  check(has(res, 'disabled-event', 'ev_off'), 'disabled event');
  check(!res.findings.some((f) => f.table === 'clean_t'), 'a clean table has no findings');
  check(!has(res, 'sensitive-columns') && !has(res, 'empty-table') && !has(res, 'stale-table') && !has(res, 'low-cardinality-index'), 'noisy rules are off by default');
  check(res.findings.every((f) => ['error', 'warning', 'info'].includes(f.severity)) && res.findings.map((f) => ['error', 'warning', 'info'].indexOf(f.severity)).every((v, i, a) => i === 0 || a[i - 1] <= v), 'sorted: errors first');
  console.log('   findings by rule:', JSON.stringify(res.findings.reduce((a, f) => { a[f.rule] = (a[f.rule] || 0) + 1; return a; }, {})));

  // ---- rules: list and admin management
  let r = await req(admin, 'GET', '/api/analyzer/rules');
  check(r.data.builtin.length >= 20 && r.data.builtin.every((x) => x.id && x.title && x.description && 'enabled' in x), 'rule list for admin', r.data.builtin.length);
  const devPass = 'rulesuser-pass-1';
  await req(admin, 'POST', '/api/users', { username: 'rulesuser', password: devPass, role: 'user', displayName: 'Rules' });
  await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['rulesuser'], permissions: { rulesuser: [] } });
  const user = await login('rulesuser', devPass);
  r = await req(user, 'GET', '/api/analyzer/rules');
  check(r.status === 200 && r.data.custom.every((c) => c.sql === undefined), 'non-admin can read the rules (without custom SQL)');
  check((await req(user, 'PUT', '/api/analyzer/rules/no-primary-key', { enabled: false })).status === 403, 'non-admin cannot change rules');
  check((await req(user, 'POST', '/api/analyzer/rules', { title: 'x', kind: 'pattern', pattern: 'x' })).status === 403, 'non-admin cannot add rules');
  check((await req(user, 'DELETE', '/api/analyzer/rules/custom-x')).status === 403, 'non-admin cannot delete rules');
  check((await req(user, 'POST', '/api/analyzer/test', {})).status === 403, 'non-admin cannot test rules');
  res = await run(user);
  check(res.findings && res.findings.length > 10, 'a read-only user can run the analysis');

  r = await req(admin, 'PUT', '/api/analyzer/rules/no-primary-key', { enabled: false });
  check(r.status === 200 && r.data.enabled === false, 'admin switches a rule off');
  res = await run();
  check(!has(res, 'no-primary-key'), '…and it no longer reports');
  await req(admin, 'PUT', '/api/analyzer/rules/no-primary-key', { enabled: true, severity: 'info' });
  res = await run();
  check(get(res, 'no-primary-key', 'logs').severity === 'info', 'severity override');
  await req(admin, 'PUT', '/api/analyzer/rules/no-primary-key', { severity: 'error', exclude: '^(logs|codes)$' });
  res = await run();
  check(!has(res, 'no-primary-key', 'logs') && !has(res, 'no-primary-key', 'codes') && has(res, 'no-primary-key', 'idx'), 'exclude pattern skips matching tables only');
  await req(admin, 'PUT', '/api/analyzer/rules/no-primary-key', { exclude: '' });
  r = await req(admin, 'PUT', '/api/analyzer/rules/unindexed-id-column', { params: { minRows: 5000 } });
  check(r.data.params[0].value === 5000, 'threshold saved');
  res = await run();
  check(!has(res, 'unindexed-id-column'), 'a higher threshold hides small tables');
  await req(admin, 'PUT', '/api/analyzer/rules/unindexed-id-column', { params: { minRows: 100 } });
  r = await req(admin, 'PUT', '/api/analyzer/rules/wide-table', { params: { max: 'abc' } });
  check(r.status === 400, 'invalid threshold rejected', r.data.error);
  r = await req(admin, 'PUT', '/api/analyzer/rules/wide-table', { severity: 'boom' });
  check(r.status === 400, 'invalid severity rejected');
  r = await req(admin, 'PUT', '/api/analyzer/rules/wide-table', { exclude: '(' });
  check(r.status === 400, 'invalid exclude regex rejected', r.data.error);
  check((await req(admin, 'PUT', '/api/analyzer/rules/nope', { enabled: false })).status === 404, 'unknown rule → 404');
  await req(admin, 'PUT', '/api/analyzer/rules/sensitive-columns', { enabled: true });
  await req(admin, 'PUT', '/api/analyzer/rules/empty-table', { enabled: true });
  res = await run();
  check(has(res, 'sensitive-columns', 'users_x.password') && get(res, 'sensitive-columns', 'users_x.password').severity === 'warning' && has(res, 'sensitive-columns', 'users_x.api_token'), 'sensitive columns (opt-in); short password column is a warning');
  check(has(res, 'empty-table', 'idx') && !has(res, 'empty-table', 'logs'), 'empty tables (opt-in), verified with a real query');
  await req(admin, 'PUT', '/api/analyzer/rules/sensitive-columns', { enabled: false });
  await req(admin, 'PUT', '/api/analyzer/rules/empty-table', { enabled: false });

  // ---- custom rules
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'Tables should have created_at', kind: 'pattern', target: 'table-needs-column', pattern: '^created(_at)?$', severity: 'info', category: 'Conventions' });
  const patternId = r.data.id;
  check(r.status === 201 && /^custom-/.test(patternId), 'add a naming rule', patternId);
  res = await run();
  check(has(res, patternId, 'logs') && has(res, patternId, 'customers') && get(res, patternId, 'logs').category === 'Conventions', 'naming rule: tables lacking a created_at column');
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'Indexes named idx_', kind: 'pattern', target: 'index', pattern: '^(idx_|PRIMARY)', mode: 'must-match', severity: 'info' });
  res = await run();
  check(has(res, r.data.id, 'idx.dup1') && !has(res, r.data.id, 'orders.PRIMARY'), 'naming rule on indexes');
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'No password-ish columns', kind: 'pattern', target: 'column', pattern: 'pass', mode: 'must-not-match', typePattern: '^varchar', severity: 'warning' });
  res = await run();
  check(has(res, r.data.id, 'users_x.password') && !has(res, r.data.id, 'users_x.id'), 'column rule with a data type filter');

  r = await req(admin, 'POST', '/api/analyzer/rules', {
    title: 'Large unmodified tables', kind: 'sql', severity: 'warning',
    sql: "SELECT table_name AS `table`, CONCAT('table has ', table_rows, ' rows') AS message, CONCAT('OPTIMIZE TABLE `', table_name, '`') AS fix FROM information_schema.tables WHERE table_schema = @db AND table_rows > 1000"
  });
  const sqlId = r.data.id;
  check(r.status === 201, 'add a SQL rule', r.data.error || sqlId);
  res = await run();
  const sf = res.findings.filter((f) => f.rule === sqlId);
  check(sf.length === 2 && sf.every((f) => f.table && /rows/.test(f.message) && /^OPTIMIZE/.test(f.fix)) && sf[0].severity === 'warning', 'SQL rule: each row is a finding, using @db and the message/fix columns', sf.map((f) => f.object));
  r = await req(admin, 'GET', '/api/analyzer/rules');
  check(r.data.custom.find((c) => c.id === sqlId).sql.includes('@db'), 'admin sees the SQL');
  r = await req(admin, 'PUT', `/api/analyzer/rules/${sqlId}`, { title: 'Large tables (edited)', kind: 'sql', severity: 'info', sql: 'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_rows > 1000', enabled: true });
  check(r.status === 200 && r.data.title === 'Large tables (edited)', 'edit a custom rule');
  res = await run();
  check(res.findings.filter((f) => f.rule === sqlId).length === 2 && res.findings.find((f) => f.rule === sqlId).message === 'Large tables (edited)', 'first column is the object; the title is the default message');
  r = await req(admin, 'PUT', `/api/analyzer/rules/${sqlId}`, { title: 'Large tables (edited)', kind: 'sql', sql: 'SELECT 1', enabled: false });
  res = await run();
  check(!res.findings.some((f) => f.rule === sqlId), 'a disabled custom rule does not run');

  for (const [label, sql] of [['DROP', 'DROP TABLE logs'], ['UPDATE', 'UPDATE logs SET msg = 1'], ['two statements', 'SELECT 1; DROP TABLE logs'], ['INTO OUTFILE', "SELECT * FROM logs INTO OUTFILE '/tmp/x'"], ['empty', ''], ['CALL', 'CALL p()']]) {
    r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'bad', kind: 'sql', sql });
    check(r.status === 400, `SQL rule refused: ${label}`, r.data.error);
  }
  check(mysql('SELECT COUNT(*) FROM anom.logs') === '1500', 'refused rules ran nothing');
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: '', kind: 'pattern', pattern: 'x' });
  check(r.status === 400, 'title required');
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'bad re', kind: 'pattern', pattern: '(' });
  check(r.status === 400, 'invalid pattern rejected', r.data.error);

  // a rule that fails at run time doesn't stop the others
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'Broken rule', kind: 'sql', sql: 'SELECT nope FROM nowhere' });
  res = await run();
  check(res.skipped.length === 1 && res.skipped[0].rule === 'Broken rule' && res.summary.total > 10, 'a failing rule is reported as skipped, the rest still run', res.skipped);
  await req(admin, 'DELETE', `/api/analyzer/rules/${r.data.id}`);
  r = await req(admin, 'POST', '/api/analyzer/rules', { title: 'Writes?', kind: 'sql', sql: 'SELECT sneaky_write()' });
  // a read-only transaction stops a function that writes
  mysql("DROP FUNCTION IF EXISTS anom.sneaky_write;\nDELIMITER ;;\nCREATE FUNCTION anom.sneaky_write() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO anom.clean_t VALUES (999, 1); RETURN 1; END;;\nDELIMITER ;\n");
  res = await run();
  check(res.skipped.some((s) => s.rule === 'Writes?') && mysql('SELECT COUNT(*) FROM anom.clean_t') === '0', 'custom SQL runs in a READ ONLY transaction: a writing function fails');
  await req(admin, 'DELETE', `/api/analyzer/rules/${r.data.id}`);

  // test endpoint
  r = await req(admin, 'POST', '/api/analyzer/test', { key: 'shop', database: 'anom', rule: { title: 't', kind: 'pattern', target: 'table', pattern: '^old_', mode: 'must-match' } });
  check(r.status === 200 && r.data.findings.length > 5 && r.data.tables === 13, 'test endpoint tries an unsaved rule', r.data.findings && r.data.findings.length);
  r = await req(admin, 'POST', '/api/analyzer/test', { key: 'nope', rule: {} });
  check(r.status === 404, 'test endpoint checks the connection');

  // delete
  check((await req(admin, 'DELETE', `/api/analyzer/rules/${patternId}`)).status === 200, 'delete a custom rule');
  check((await req(admin, 'DELETE', '/api/analyzer/rules/no-primary-key')).status === 404, 'built-in rules cannot be deleted');
  const left = (await req(admin, 'GET', '/api/analyzer/rules')).data.custom;
  for (const c of left) await req(admin, 'DELETE', `/api/analyzer/rules/${c.id}`);

  // access: unknown connection / database
  check((await req(admin, 'GET', '/api/explore/nope/anom/analyze')).status === 404, 'unknown connection → 404');
  r = await req(admin, 'GET', '/api/explore/shop/no_such_db/analyze');
  check(r.status === 400 || (r.status === 200 && r.data.tables === 0), 'unknown database handled', r.status);
  await req(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: [] });
  check((await req(user, 'GET', '/api/explore/shop/anom/analyze')).status === 404, 'a user without access to the connection is refused');

  // ---- rules over synthetic models (cases real MySQL refuses to create)
  const analyzer = require('/home/user/db-console/api/analyzer');
  const rule = (id) => analyzer.BUILTIN.find((x) => x.id === id);
  const col = (name, dataType, extra = {}) => ({ name, dataType, type: dataType, unsigned: false, nullable: false, ...extra });
  const parent = { name: 'p', columns: [col('id', 'bigint', { unsigned: true, type: 'bigint(20) unsigned' })], indexes: [], fks: [] };
  const child = { name: 'c', rows: 5, columns: [col('pid', 'int', { type: 'int(11)' }), col('sid', 'varchar', { charset: 'latin1', collation: 'latin1_swedish_ci' })], indexes: [], fks: [{ name: 'fk', columns: ['pid'], refDb: 'd', refTable: 'p', refColumns: ['id'] }, { name: 'fk2', columns: ['sid'], refDb: 'd', refTable: 'p2', refColumns: ['code'] }] };
  const parent2 = { name: 'p2', columns: [col('code', 'varchar', { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' })], indexes: [], fks: [] };
  const model = { database: 'd', byName: new Map([['p', parent], ['c', child], ['p2', parent2]]), tables: [parent, child, parent2], views: [], events: [] };
  let out = rule('fk-type-mismatch').run(model, {});
  check(out.length === 2 && /int\(11\) vs bigint/.test(out[0].message) && /character set latin1 vs utf8mb4/.test(out[1].message), 'fk-type-mismatch: type and character set differences', out.map((o) => o.message));
  out = rule('fk-without-index').run(model, {});
  check(out.length === 2 && /ADD INDEX `idx_pid`/.test(out[0].fix), 'fk-without-index: foreign keys with no index');
  child.indexes = [{ name: 'i', cols: [{ name: 'pid' }, { name: 'sid' }], sig: ['pid', 'sid'], special: false }];
  out = rule('fk-without-index').run(model, {});
  check(out.length === 1 && /sid/.test(out[0].message), 'fk-without-index: a longer index that starts with the columns counts');
  const big = { name: 'b', rows: 20000000, dataLength: 100 * 1048576, indexLength: 900 * 1048576, dataFree: 300 * 1048576, columns: Array.from({ length: 60 }, (_, i) => col('c' + i, 'int')), indexes: [], fks: [] };
  const m2 = { database: 'd', byName: new Map(), tables: [big], views: [], events: [] };
  check(rule('large-table').run(m2, { rows: 10000000 }).length === 1 && rule('index-heavy').run(m2, { ratio: 2, minMb: 50 }).length === 1 && rule('fragmented').run(m2, { minMb: 100, pct: 20 }).length === 1 && rule('wide-table').run(m2, { max: 50 }).length === 1, 'storage rules: large, index-heavy, fragmented, wide');
  const bi = { name: 'bi', autoIncrement: '9223372036854775000', columns: [col('id', 'bigint', { extra: 'auto_increment', unsigned: false, type: 'bigint(20)' })], indexes: [], fks: [] };
  out = rule('autoinc-overflow').run({ database: 'd', byName: new Map(), tables: [bi], views: [], events: [] }, { warnPct: 70, errorPct: 90 });
  check(out.length === 1 && out[0].severity === 'error' && !out[0].fix, 'autoinc-overflow: BIGINT handled exactly (no fix offered)', out[0] && out[0].message);

  
  } finally {
    await srv.stop();
  }
  T.finish();
});
