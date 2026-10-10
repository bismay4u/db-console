// Database / table limits on shared connections, enforced across Explore, the Query Runner, compare and jobs.
const { test } = require('node:test');
const T = require('./helpers');
const { check, finish } = T;

test('scoped shares', { timeout: 60000 }, async () => {
  T.mysql(`DROP DATABASE IF EXISTS sch; DROP DATABASE IF EXISTS other; CREATE DATABASE sch; CREATE DATABASE other;
CREATE TABLE sch.people (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO sch.people VALUES (1,'ann');
CREATE TABLE sch.secret (id INT PRIMARY KEY, token VARCHAR(20)); INSERT INTO sch.secret VALUES (1,'t0ps3cret');
CREATE TABLE sch.notes (id INT PRIMARY KEY, person_id INT, FOREIGN KEY (person_id) REFERENCES sch.secret(id));
CREATE TABLE other.stuff (id INT PRIMARY KEY); INSERT INTO other.stuff VALUES (7);`);
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
    const admin = await T.login(B);
    for (const u of ['sam', 'free']) await call(admin, 'POST', '/api/users', { username: u, password: `${u}-pass-1234`, role: 'user' });
    let r = await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['sam', 'free'], scopes: { sam: { databases: ['sch'], hideTables: ['secret'] } } });
    check(r.status === 200 && r.data.shareScopes.sam.databases[0] === 'sch' && r.data.shareScopes.sam.hideTables[0] === 'secret' && !r.data.shareScopes.free, 'the owner saves the limits', r.data.shareScopes);
    const sam = await T.login(B, 'sam', 'sam-pass-1234'); const free = await T.login(B, 'free', 'free-pass-1234');
    r = await call(sam, 'GET', '/api/connections');
    check(r.data.find((c) => c.key === 'shop').limited === true && r.data.find((c) => c.key === 'shop').shareScopes === undefined, 'sam is told his access is limited but not how');
    const E = '/api/explore/shop';

    r = await call(sam, 'GET', `${E}/databases`);
    check(JSON.stringify(r.data) === '["sch"]', 'only the allowed database is listed', r.data);
    r = await call(free, 'GET', `${E}/databases`);
    check(r.data.includes('other') && r.data.includes('sch'), 'an unlimited share sees them all');
    r = await call(sam, 'GET', `${E}/other/objects`);
    check(r.status === 403, 'another database is refused');
    r = await call(sam, 'GET', `${E}/sch/objects`);
    check(r.data.tables.map((t) => t.name).sort().join() === 'notes,people', 'hidden tables are not listed', r.data.tables.map((t) => t.name));
    check((await call(sam, 'GET', `${E}/sch/people/rows?page=1&pageSize=10`)).status === 200, 'visible tables work');
    r = await call(sam, 'GET', `${E}/sch/secret/rows?page=1&pageSize=10`);
    check(r.status === 404, 'a hidden table is not found');
    check((await call(sam, 'GET', `${E}/sch/secret/profile?column=token`)).status === 404 && (await call(sam, 'GET', `${E}/sch/secret/indexes`)).status === 404, 'nor are its other pages');
    check((await call(sam, 'GET', `${E}/sch/definition/table/secret`)).status === 404, 'nor its definition');
    r = await call(sam, 'GET', `${E}/sch/autocomplete`);
    check(!('secret' in r.data.tables) && 'people' in r.data.tables, 'autocomplete leaves it out');
    r = await call(sam, 'GET', `${E}/sch/diagram`);
    check(!r.data.tables.some((t) => t.name === 'secret') && r.data.foreignKeys.length === 0, 'the diagram too, with the foreign keys that touch it');
    r = await call(sam, 'GET', `${E}/sch/search?q=t0ps3cret`);
    check(r.data.results.length === 0, 'and a search cannot find what is in it');
    for (const [what, p, m, body] of [['export', `${E}/sch/export?options=%7B%22format%22%3A%22sql%22%7D`, 'GET'], ['analysis', `${E}/sch/analyze`, 'GET'], ['search & replace', `${E}/sch/search-replace`, 'POST', { find: 'a', replace: 'b' }]]) {
      r = await call(sam, m || 'GET', p, body);
      check(r.status === 403, `${what} is off while tables are hidden`, r.status);
    }
    r = await call(sam, 'POST', `${E}/sch/table-actions`, { action: 'drop', tables: ['secret'] });
    check(r.status === 403, 'table actions on a hidden table are refused');
    r = await call(sam, 'POST', `${E}/databases`, { name: 'mine' });
    check(r.status === 403, 'and he cannot create databases');

    // Query Runner
    const run = (ck, sql, db = 'sch') => call(ck, 'POST', '/api/query', { dbKeys: ['shop'], sql, databases: { shop: db } });
    const err = (x) => x.data.results[0].statements[0].error || '';
    r = await run(sam, 'SELECT * FROM people');
    check(r.data.results[0].ok, 'allowed SQL runs');
    r = await run(sam, 'SELECT * FROM secret');
    check(!r.data.results[0].ok && /secret/.test(err(r)), 'a hidden table in SQL is refused', err(r));
    r = await run(sam, 'SELECT * FROM `SECRET`');
    check(!r.data.results[0].ok, 'whatever the case or quoting');
    r = await run(sam, 'SELECT * FROM other.stuff');
    check(!r.data.results[0].ok && /database other/.test(err(r)), 'a database outside the limit is refused', err(r));
    r = await run(sam, 'SELECT * FROM people', 'other');
    check(!r.data.results[0].ok && /only work in/.test(err(r)), 'so is running in one');
    r = await run(sam, 'USE other');
    check(!r.data.results[0].ok, 'and switching to one');
    r = await run(sam, 'SHOW DATABASES');
    check(!r.data.results[0].ok, 'SHOW DATABASES is not available');
    r = await run(sam, "SELECT 'secret' AS label");
    check(r.data.results[0].ok, 'the word inside a string is just text');
    r = await run(free, 'SELECT * FROM secret');
    check(r.data.results[0].ok, 'the other share is not limited');
    r = await run(admin, 'SELECT * FROM secret');
    check(r.data.results[0].ok, 'neither is the owner');
    // downloads
    const form = (ck, fields) => fetch(B + '/api/query/export', { method: 'POST', headers: { cookie: ck, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    check((await form(sam, { key: 'shop', database: 'sch', sql: 'SELECT * FROM secret' })).status === 403, 'a download cannot get around it');
    check((await form(sam, { key: 'shop', database: 'sch', sql: 'SELECT * FROM people' })).status === 200, 'but a normal one works');

    // compare + jobs
    r = await call(sam, 'POST', '/api/diff/schema', { source: { key: 'shop', database: 'sch' }, target: { key: 'shop', database: 'sch' } });
    check(r.status === 403, 'structure compare is off while tables are hidden');
    r = await call(sam, 'POST', '/api/diff/data', { source: { key: 'shop', database: 'sch', table: 'secret' }, target: { key: 'shop', database: 'sch', table: 'people' } });
    check(r.status === 403, 'data compare refuses a hidden table');
    r = await call(sam, 'POST', '/api/jobs', { type: 'query', name: 'peek', connKey: 'shop', database: 'sch', sql: 'SELECT * FROM secret', schedule: '' });
    check(r.status === 400 && /secret/.test(r.data.error), 'a job cannot read a hidden table', r.data);
    r = await call(sam, 'POST', '/api/jobs', { type: 'query', name: 'peek', connKey: 'shop', database: 'other', sql: 'SELECT 1', schedule: '' });
    check(r.status === 400 && /other/.test(r.data.error), 'or use another database', r.data);
    r = await call(sam, 'POST', '/api/jobs', { type: 'query', name: 'ok', connKey: 'shop', database: 'sch', sql: 'SELECT * FROM people', schedule: '' });
    check(r.status === 201, 'an allowed job is fine');

    // removing the limit
    r = await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['sam', 'free'], scopes: {} });
    check(!r.data.shareScopes && (await run(sam, 'SELECT * FROM secret')).data.results[0].ok, 'clearing the limits lifts them');
  } finally { await srv.stop(); T.mysql('DROP DATABASE IF EXISTS sch; DROP DATABASE IF EXISTS other'); }
  finish();
});
