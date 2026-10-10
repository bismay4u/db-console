// PostgreSQL connections (needs a server; set TEST_PG_* or use the defaults, skipped when unreachable).
const { test } = require('node:test');
const net = require('net');
const T = require('./helpers');
const { check, finish } = T;

const PG = { host: process.env.TEST_PG_HOST || '127.0.0.1', port: Number(process.env.TEST_PG_PORT || 5432), user: process.env.TEST_PG_USER || 'dbc', password: process.env.TEST_PG_PASS || 'dbcpass', database: process.env.TEST_PG_DB || 'dbc_pg' };
const reachable = () => new Promise((resolve) => { const s = net.connect(PG.port, PG.host); s.setTimeout(1500); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });

test('PostgreSQL connections', { timeout: 90000 }, async (t) => {
  if (!(await reachable())) return t.skip('no PostgreSQL server reachable');
  const srv = await T.startServer();
  const B = srv.B;
  const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const tx = await r.text(); let d; try { d = JSON.parse(tx); } catch { d = tx; } return { status: r.status, data: d }; };
  try {
    const admin = await T.login(B);
    let r = await call(admin, 'POST', '/api/connections/test', { engine: 'postgres', ...PG, password: 'wrong' });
    check(r.data.ok === false, 'a wrong password is reported', r.data);
    r = await call(admin, 'POST', '/api/connections/test', { engine: 'postgres', ...PG });
    check(r.data.ok === true, 'the test passes with the right details', r.data);
    r = await call(admin, 'POST', '/api/connections', { engine: 'postgres', label: 'PG', ...PG });
    check(r.status === 201 && r.data.engine === 'postgres', 'a PostgreSQL connection is saved', r.data);
    const key = r.data.key;
    const run = (sql, extra = {}) => call(admin, 'POST', '/api/query', { dbKeys: [key], sql, databases: { [key]: 'public' }, ...extra });
    const st = (x, i = 0) => x.data.results[0].statements[i];
    await run('DROP SCHEMA IF EXISTS dbc_t CASCADE');

    r = await run(`CREATE SCHEMA dbc_t;
CREATE TABLE dbc_t.people (id SERIAL PRIMARY KEY, name TEXT NOT NULL, age INT, bio TEXT, photo BYTEA, meta JSONB, born DATE);
CREATE TABLE dbc_t.pets (id SERIAL PRIMARY KEY, owner_id INT REFERENCES dbc_t.people(id), name TEXT);
CREATE INDEX idx_name ON dbc_t.people(name);
CREATE VIEW dbc_t.adults AS SELECT * FROM dbc_t.people WHERE age >= 18;
CREATE FUNCTION dbc_t.bump() RETURNS trigger AS $body$ BEGIN NEW.bio := 'new; ok'; RETURN NEW; END; $body$ LANGUAGE plpgsql;
CREATE TRIGGER trg BEFORE INSERT ON dbc_t.people FOR EACH ROW EXECUTE FUNCTION dbc_t.bump();
INSERT INTO dbc_t.people (name, age, born) VALUES ('ann', 30, '2000-01-02'), ('ben', 15, NULL), ('cy; semi', 41, NULL);`);
    check(r.data.results[0].ok && r.data.results[0].statements.length === 8, 'a script with a function body runs statement by statement', r.data.results[0].statements.map((s) => s.error || s.sql.slice(0, 20)));
    r = await run('SELECT * FROM dbc_t.people ORDER BY id');
    check(st(r).rowCount === 3 && st(r).rows[2].name === 'cy; semi' && st(r).rows[0].bio === 'new; ok' && st(r).rows[0].born === '2000-01-02', 'SELECT returns rows (dates stay strings, trigger ran)', st(r).rows && st(r).rows[0]);
    r = await run('UPDATE dbc_t.people SET age = age + 1 WHERE id = 1');
    check(st(r).type === 'result' && st(r).affectedRows === 1, 'UPDATE reports affected rows', st(r));
    r = await run('SELECT nope FROM dbc_t.people');
    check(!r.data.results[0].ok && /nope/.test(st(r).error), 'errors are reported', st(r).error);
    r = await run('SELECT * FROM dbc_t.people', { explain: true });
    check(r.data.results[0].ok && /Scan|Seq/i.test(JSON.stringify(st(r).rows)), 'Explain shows the plan', st(r).error);
    r = await run("INSERT INTO dbc_t.pets (owner_id, name) VALUES (999, 'orphan')");
    check(!r.data.results[0].ok && /foreign key/i.test(st(r).error), 'foreign keys are enforced');
    r = await run("SELECT 9007199254740993::bigint AS big, '\\x0a0b'::bytea AS bin, NULL AS nul, '{\"a\":1}'::jsonb AS j");
    check(st(r).rows[0].big === '9007199254740993' && st(r).rows[0].bin.__hex === '0a0b' && st(r).rows[0].nul === null, 'big integers stay exact, bytea becomes hex', st(r).rows);

    const E = `/api/explore/${key}`;
    r = await call(admin, 'GET', `${E}/databases`);
    check(Array.isArray(r.data) && r.data.includes('dbc_t') && r.data.includes('public') && !r.data.includes('pg_catalog'), 'schemas are listed as databases', r.data);
    r = await call(admin, 'GET', `${E}/dbc_t/objects`);
    check(r.data.tables.map((x) => `${x.name}:${x.type}`).sort().join() === 'adults:VIEW,people:BASE TABLE,pets:BASE TABLE', 'tables and views are listed', r.data.tables);
    check(Array.isArray(r.data.triggers) && r.data.triggers.some((x) => x.name === 'trg') && r.data.routines.some((x) => x.name === 'bump'), 'triggers and routines are listed', { t: r.data.triggers, r: r.data.routines });
    r = await call(admin, 'GET', `${E}/dbc_t/people/schema`);
    check(r.data.primaryKey[0] === 'id' && r.data.columns.find((c) => c.name === 'id').autoIncrement && r.data.columns.find((c) => c.name === 'name').nullable === false, 'structure: columns, key, serial', r.data);
    r = await call(admin, 'GET', `${E}/dbc_t/pets/schema`);
    check(r.data.foreignKeys.length === 1 && r.data.foreignKeys[0].refTable === 'people', 'structure: foreign keys', r.data.foreignKeys);
    r = await call(admin, 'GET', `${E}/dbc_t/people/indexes`);
    check(r.data.some((i) => i.name === 'idx_name' && i.columns[0] === 'name') && r.data.some((i) => i.primary), 'structure: indexes', r.data);
    r = await call(admin, 'GET', `${E}/dbc_t/definition/function/bump`);
    check(/plpgsql/i.test(r.data.definition || ''), 'a function definition', r.data);
    r = await call(admin, 'GET', `${E}/dbc_t/people/rows?page=1&pageSize=2&sortCol=name&sortDir=desc`);
    check(r.data.total === 3 && r.data.rows.length === 2 && r.data.rows[0].name === 'cy; semi', 'browse with sorting and paging', r.data.rows);
    r = await call(admin, 'GET', `${E}/dbc_t/people/rows?filters=${encodeURIComponent(JSON.stringify([{ col: 'name', op: 'contains', value: 'N' }]))}`);
    check(r.data.total === 2, 'filters work (contains, case-insensitive)', r.data.total);
    r = await call(admin, 'GET', `${E}/dbc_t/people/rows?filters=${encodeURIComponent(JSON.stringify([{ col: '*', op: '=', value: 'ann' }]))}`);
    check(r.data.total === 1, 'search across all columns');
    r = await call(admin, 'POST', `${E}/dbc_t/people/rows`, { values: { name: 'eve', age: '', meta: '{"x":1}' } });
    check(r.status === 201 && r.data.insertId > 0, 'insert a row (a blank number becomes NULL)', r.data);
    const eve = r.data.insertId;
    r = await call(admin, 'PUT', `${E}/dbc_t/people/rows`, { where: { id: eve }, changes: { age: '22', born: '1999-12-31' } });
    check(r.data.affectedRows === 1, 'edit a row', r.data);
    r = await run("SELECT age, born, meta->>'x' AS x FROM dbc_t.people WHERE name = 'eve'");
    check(st(r).rows[0].age === 22 && st(r).rows[0].born === '1999-12-31' && st(r).rows[0].x === '1', 'the edits are stored', st(r).rows);
    r = await call(admin, 'DELETE', `${E}/dbc_t/people/rows`, { where: { id: eve } });
    check(r.data.affectedRows === 1, 'delete a row', r.data);
    r = await call(admin, 'GET', `${E}/dbc_t/autocomplete`);
    check(r.data.tables.people.includes('name'), 'autocomplete knows the columns');
    r = await call(admin, 'GET', `${E}/dbc_t/diagram`);
    check(r.data.tables.length === 3 && r.data.foreignKeys.length === 1, 'diagram data');
    r = await call(admin, 'POST', `${E}/dbc_t/tables`, { name: 't' });
    check(r.status === 400 && /not available for PostgreSQL/.test(r.data.error), 'schema editing says it is not available yet', r.data);

    const dl = await fetch(`${B}${E}/dbc_t/people/export.csv`, { headers: { cookie: admin } });
    const csv = await dl.text();
    check(dl.status === 200 && /^id,name,age,bio,photo/.test(csv) && /cy; semi/.test(csv) && /\\N/.test(csv), 'table CSV download', csv.slice(0, 120));
    const q = await fetch(`${B}/api/query/export`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key, database: 'dbc_t', sql: 'SELECT id, name FROM dbc_t.people ORDER BY id LIMIT 1', stripLimit: '1', format: 'csv' }) });
    const qcsv = await q.text();
    check(q.status === 200 && qcsv.trim().split(/\r?\n/).length === 4, 'a query download ignores the preview LIMIT', qcsv);

    const runId = 'run' + Date.now().toString(36) + 'abcdef';
    const slow = run('SELECT pg_sleep(30)', { runId });
    await new Promise((x) => setTimeout(x, 700));
    r = await call(admin, 'POST', '/api/query/cancel', { runId });
    const res = await slow;
    check(r.data.stopped === 1 && !res.data.results[0].ok, 'Stop ends a long query', { r: r.data, e: res.data.results[0].statements[0].error });
    r = await run('SELECT 1 AS n');
    check(st(r).rows[0].n === 1, 'and the connection works again');

    r = await call(admin, 'POST', '/api/jobs', { type: 'query', name: 'count', connKey: key, database: 'dbc_t', sql: 'SELECT COUNT(*) AS n FROM dbc_t.people', schedule: '', notifyWhen: 'always' });
    check(r.status === 201, 'a query job can be scheduled', r.data);
    const jr = await call(admin, 'POST', `/api/jobs/${r.data.id}/run?wait=1`);
    check(jr.data.ok, 'and runs', jr.data);
    r = await call(admin, 'POST', '/api/jobs', { type: 'health', name: 'up', connKeys: [key], schedule: '' });
    const hr = await call(admin, 'POST', `/api/jobs/${r.data.id}/run?wait=1`);
    check(hr.data.ok, 'a connection check works', hr.data);

    await run('DROP SCHEMA dbc_t CASCADE');
  } finally { await srv.stop(); }
  finish();
});
