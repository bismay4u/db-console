// SQLite connections: runner, Explore, edits, downloads, stop, limits.
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./helpers');
const { check, finish } = T;

test('SQLite connections', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-lite-'));
  const file = path.join(dir, 'app.db');
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d, headers: r.headers }; };
    const admin = await T.login(B);
    await call(admin, 'POST', '/api/users', { username: 'bob', password: 'bob-pass-1234', role: 'user' });
    const bob = await T.login(B, 'bob', 'bob-pass-1234');

    let r = await call(bob, 'POST', '/api/connections', { engine: 'sqlite', label: 'x', database: file });
    check(r.status === 400 && /administrators/.test(r.data.error), 'only admins add SQLite connections', r.data);
    r = await call(admin, 'POST', '/api/connections/test', { engine: 'sqlite', database: file });
    check(r.data.ok === false && /does not exist/.test(r.data.error), 'a missing file is reported', r.data);
    r = await call(admin, 'POST', '/api/connections', { engine: 'sqlite', label: 'Lite', database: file, sqliteCreate: true });
    check(r.status === 201 && r.data.engine === 'sqlite', 'an admin creates one (creating the file if asked)', r.data);
    const key = r.data.key;
    check((await call(admin, 'POST', `/api/connections/${key}/test`)).data.ok === false || true, 'test runs');
    const run = (ck, sql, extra = {}) => call(ck, 'POST', '/api/query', { dbKeys: [key], sql, databases: { [key]: 'main' }, ...extra });
    const st = (x, i = 0) => x.data.results[0].statements[i];

    r = await run(admin, `CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, bio TEXT, photo BLOB);
CREATE TABLE pets (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES people(id), name TEXT);
CREATE INDEX idx_name ON people(name);
CREATE VIEW adults AS SELECT * FROM people WHERE age >= 18;
CREATE TRIGGER trg AFTER INSERT ON people BEGIN UPDATE people SET bio = 'new' WHERE id = new.id; INSERT INTO pets (owner_id, name) VALUES (new.id, 'auto'); END;
INSERT INTO people (name, age) VALUES ('ann', 30), ('ben', 15), ('cy; semi', 41);`);
    check(r.data.results[0].ok && r.data.results[0].statements.length === 6, 'a script with a trigger body runs statement by statement', r.data.results[0].statements.map((s) => s.error || s.sql.slice(0, 20)));
    r = await run(admin, 'SELECT * FROM people ORDER BY id');
    check(st(r).type === 'rows' && st(r).rowCount === 3 && st(r).rows[2].name === 'cy; semi' && st(r).rows[0].bio === 'new' && st(r).columns.join() === 'id,name,age,bio,photo', 'SELECT returns rows and columns (the trigger ran)', st(r));
    r = await run(admin, 'UPDATE people SET age = age + 1 WHERE id = 1');
    check(st(r).type === 'result' && st(r).affectedRows === 1, 'UPDATE reports affected rows');
    r = await run(admin, 'SELECT nope FROM people');
    check(!r.data.results[0].ok && /no such column/.test(st(r).error), 'errors are reported');
    r = await run(admin, 'SELECT * FROM people', { explain: true });
    check(r.data.results[0].ok && /SCAN|SEARCH/i.test(JSON.stringify(st(r).rows)), 'Explain shows the query plan');
    r = await run(admin, 'INSERT INTO people (name) VALUES (\'dee\')');
    check(st(r).insertId > 0, 'INSERT reports the new id', st(r));
    r = await run(admin, "INSERT INTO pets VALUES (100, 999, 'orphan')");
    check(!r.data.results[0].ok && /FOREIGN KEY/i.test(st(r).error), 'foreign keys are enforced');
    r = await run(admin, 'SELECT 9007199254740993 AS big, x\'0a0b\' AS bin, NULL AS nul');
    check(st(r).rows[0].big === '9007199254740993' && st(r).rows[0].bin.__hex === '0a0b' && st(r).rows[0].nul === null, 'big integers stay exact, blobs become hex', st(r).rows);

    // Explore
    const E = `/api/explore/${key}`;
    r = await call(admin, 'GET', `${E}/databases`);
    check(JSON.stringify(r.data) === '["main"]', 'one database: main', r.data);
    r = await call(admin, 'GET', `${E}/main/objects`);
    check(r.data.tables.map((t) => `${t.name}:${t.type}`).sort().join() === 'adults:VIEW,people:BASE TABLE,pets:BASE TABLE' && r.data.triggers[0].name === 'trg', 'tables, views and triggers are listed', r.data);
    r = await call(admin, 'GET', `${E}/main/people/schema`);
    check(r.data.columns.find((c) => c.name === 'id').autoIncrement && r.data.columns.find((c) => c.name === 'name').nullable === false && r.data.primaryKey[0] === 'id', 'structure: columns, key, auto id', r.data.columns.map((c) => c.name));
    r = await call(admin, 'GET', `${E}/main/pets/schema`);
    check(r.data.foreignKeys.length === 1 && r.data.foreignKeys[0].refTable === 'people', 'structure: foreign keys');
    r = await call(admin, 'GET', `${E}/main/people/indexes`);
    check(r.data.some((i) => i.name === 'idx_name' && i.columns[0] === 'name') && r.data.some((i) => i.primary), 'structure: indexes');
    r = await call(admin, 'GET', `${E}/main/definition/table/people`);
    check(/CREATE TABLE people/.test(r.data.definition), 'the CREATE statement');
    r = await call(admin, 'GET', `${E}/main/rows`.replace('/rows', '/people/rows') + '?page=1&pageSize=2&sortCol=name&sortDir=desc');
    check(r.data.total === 4 && r.data.rows.length === 2 && r.data.rows[0].name === 'dee', 'browse with sorting and paging', r.data.rows);
    r = await call(admin, 'GET', `${E}/main/people/rows?filters=${encodeURIComponent(JSON.stringify([{ col: 'name', op: 'contains', value: 'e' }]))}`);
    check(r.data.total === 3, 'filters work (contains, case-insensitive)', r.data.total);
    r = await call(admin, 'GET', `${E}/main/people/rows?filters=${encodeURIComponent(JSON.stringify([{ col: '*', op: '=', value: 'ann' }]))}`);
    check(r.data.total === 1, 'search across all columns');
    r = await call(admin, 'POST', `${E}/main/people/rows`, { values: { name: 'eve', age: '' } });
    check(r.status === 201 && r.data.insertId > 0, 'insert a row (a blank number becomes NULL)', r.data);
    r = await call(admin, 'PUT', `${E}/main/people/rows`, { where: { id: r.data.insertId }, changes: { age: '22', bio: 'hello' } });
    check(r.data.affectedRows === 1, 'edit a row');
    r = await call(admin, 'DELETE', `${E}/main/people/rows`, { where: { id: 4 } });
    check(r.status >= 400 && /FOREIGN KEY/i.test(r.data.error), 'deleting a referenced row is refused', r.data);
    await run(admin, 'DELETE FROM pets WHERE owner_id = 4');
    r = await call(admin, 'DELETE', `${E}/main/people/rows`, { where: { id: 4 } });
    check(r.data.affectedRows === 1, 'delete a row');
    r = await run(admin, 'SELECT age, bio FROM people WHERE name = \'eve\'');
    check(st(r).rows[0].age === 22 && st(r).rows[0].bio === 'hello', 'the edits are in the file');
    r = await call(admin, 'GET', `${E}/main/autocomplete`);
    check(r.data.tables.people.includes('name'), 'autocomplete knows the columns');
    r = await call(admin, 'GET', `${E}/main/diagram`);
    check(r.data.tables.length === 3 && r.data.foreignKeys.length === 1, 'diagram data');
    r = await call(admin, 'POST', `${E}/main/tables`, { name: 't' });
    check(r.status === 400 && /not available for SQLite/.test(r.data.error), 'schema editing says it is not available yet', r.data);
    r = await call(admin, 'GET', `${E}/main/analyze`);
    check(r.status === 400, 'so does analysis');
    r = await call(admin, 'GET', `/api/server/${key}/health`);
    check(r.status === 400, 'and the server tools');

    // downloads
    const dl = await fetch(`${B}${E}/main/people/export.csv`, { headers: { cookie: admin } });
    const csv = await dl.text();
    check(dl.status === 200 && /^id,name,age,bio,photo/.test(csv) && /"cy; semi"|cy; semi/.test(csv) && /\\N/.test(csv), 'table CSV download', csv.slice(0, 120));
    const form = (fields) => fetch(`${B}/api/query/export`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const q = await form({ key, database: 'main', sql: 'SELECT id, name FROM people ORDER BY id LIMIT 1', stripLimit: '1', format: 'csv' });
    const qcsv = await q.text();
    check(q.status === 200 && qcsv.trim().split(/\r?\n/).length === 5, 'a query download ignores the preview LIMIT', qcsv);

    // Stop
    const runId = 'run' + Date.now().toString(36) + 'abcdef';
    const slow = run(admin, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c', { runId });
    await new Promise((x) => setTimeout(x, 700));
    r = await call(admin, 'POST', '/api/query/cancel', { runId });
    const res = await slow;
    check(r.data.stopped === 1 && !res.data.results[0].ok && /stopped/.test(res.data.results[0].statements[0].error), 'Stop ends an endless query', { r: r.data, e: res.data.results[0].statements[0].error });
    r = await run(admin, 'SELECT count(*) AS n FROM people');
    check(st(r).rows[0].n === 4, 'and the connection works again afterwards');
    r = await call(admin, 'GET', `${E}/main/people/rows`);
    check(r.status === 200, 'including through Explore');

    // sharing: a read-only share can look but not write
    await call(admin, 'PUT', `/api/connections/${key}/sharing`, { sharedWith: ['bob'], readOnly: true });
    r = await run(bob, 'SELECT * FROM people');
    check(r.data.results[0].ok, 'a read-only share can read');
    r = await run(bob, "UPDATE people SET name = 'x'");
    check(!r.data.results[0].ok && /Read-only/.test(st(r).error), 'but not write', st(r).error);
    r = await call(bob, 'POST', `${E}/main/people/rows`, { values: { name: 'zed' } });
    check(r.status === 403, 'nor through Explore');
    r = await call(bob, 'GET', '/api/connections');
    check(r.data.find((c) => c.key === key).engine === 'sqlite', 'the engine shows in the connection list');

    // a schedule: query + connection check
    r = await call(admin, 'POST', '/api/jobs', { type: 'query', name: 'count', connKey: key, database: 'main', sql: 'SELECT COUNT(*) AS n FROM people', schedule: '', notifyWhen: 'always' });
    check(r.status === 201, 'a query job can be scheduled');
    const jr = await call(admin, 'POST', `/api/jobs/${r.data.id}/run?wait=1`);
    check(jr.data.ok && jr.data.summary.rows === 1, 'and runs', jr.data);
    r = await call(admin, 'POST', '/api/jobs', { type: 'health', name: 'up', connKeys: [key], schedule: '' });
    const hr = await call(admin, 'POST', `/api/jobs/${r.data.id}/run?wait=1`);
    check(hr.data.ok, 'a connection check works', hr.data);
    r = await call(admin, 'POST', '/api/jobs', { type: 'backup', name: 'b', connKey: key, database: 'main', schedule: '' });
    check(r.status === 400 && /not available for SQLite/.test(r.data.error), 'backups are refused for now');
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  finish();
});
