// Column profile, related rows, search & replace.
const { test } = require('node:test');
const T = require('./helpers');
const { check, finish } = T;

test('profile, related rows, search & replace', { timeout: 120000 }, async () => {
  T.mysql(`DROP DATABASE IF EXISTS sch; CREATE DATABASE sch CHARACTER SET utf8mb4; USE sch;
CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(40), age INT, bio TEXT, token BLOB);
INSERT INTO people VALUES (1,'Ann Smith',30,'likes tea',X'0102'),(2,'Ben Smith',40,'Likes tea and tea',NULL),(3,'Cy',NULL,'',NULL),(4,'Di Smith',30,NULL,NULL);
CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, name VARCHAR(20), note VARCHAR(30), CONSTRAINT fk_owner FOREIGN KEY (owner_id) REFERENCES people(id));
INSERT INTO pets VALUES (1,1,'Rex','Smith family dog'),(2,1,'Tom',NULL),(3,NULL,'Stray','no owner');
CREATE TABLE legacy (id INT PRIMARY KEY, note VARCHAR(30)) ENGINE=MyISAM; INSERT INTO legacy VALUES (1,'Smith');`);
  const srv = await T.startServer();
  try {
    const cookie = await T.login(srv.B);
    const A = async (method, p, body) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    const E = '/api/explore/shop/sch';

    // ---- profile
    let r = await A('GET', `${E}/people/profile?column=age`);
    check(r.status === 200 && r.data.total === 4 && r.data.nulls === 1 && r.data.distinct === 2 && r.data.min === '30' && r.data.max === '40' && Math.abs(r.data.avg - 33.33) < 0.1, 'numeric profile', r.data);
    check(r.data.top[0].value === '30' && r.data.top[0].count === 2 && r.data.top.some((t) => t.isNull), 'most common values include NULL', r.data.top);
    check(r.data.histogram && r.data.histogram.reduce((a, h) => a + h.count, 0) === 3, 'histogram covers the non-null rows');
    r = await A('GET', `${E}/people/profile?column=bio`);
    check(r.data.emptyStrings === 1 && r.data.maxLength === 17 && r.data.nulls === 1, 'text profile: empty strings and lengths', r.data);
    r = await A('GET', `${E}/people/profile?column=token`);
    check(r.status === 200 && r.data.nulls === 3 && r.data.top === undefined, 'binary columns get counts only', r.data);
    r = await A('GET', `${E}/people/profile?column=nope`);
    check(r.status === 400, 'unknown column is an error');

    // ---- related rows
    r = await A('GET', `${E}/pets/related?where=${encodeURIComponent(JSON.stringify({ id: 1 }))}`);
    check(r.data.parents.length === 1 && r.data.parents[0].row.name === 'Ann Smith' && r.data.parents[0].filter[0].col === 'id', 'a row shows the row it points to', r.data);
    r = await A('GET', `${E}/pets/related?where=${encodeURIComponent(JSON.stringify({ id: 3 }))}`);
    check(r.data.parents[0].row === null && r.data.parents[0].reason === 'null', 'a NULL foreign key points at nothing');
    r = await A('GET', `${E}/people/related?where=${encodeURIComponent(JSON.stringify({ id: 1 }))}`);
    check(r.data.children.length === 1 && r.data.children[0].table === 'pets' && r.data.children[0].count === 2 && r.data.children[0].filter[0].col === 'owner_id', 'and the rows that point at it, with a count', r.data);
    r = await A('GET', `${E}/people/related?where=${encodeURIComponent(JSON.stringify({ id: 99 }))}`);
    check(r.status === 400, 'missing row is an error');

    // ---- search & replace
    r = await A('POST', `${E}/search-replace`, { find: 'Smith', replace: 'Jones' });
    check(r.data.preview === true && r.data.rows === 5 && r.data.columns === 3 && r.data.occurrences === 5, 'preview counts rows, columns and occurrences (case-sensitive)', r.data);
    check(r.data.found.find((f) => f.table === 'people' && f.column === 'name').sample[0].after.includes('Jones'), 'with before/after samples');
    check(T.mysql("SELECT COUNT(*) FROM people WHERE name LIKE '%Smith%'", 'sch') === '3', 'a preview changes nothing');
    r = await A('POST', `${E}/search-replace`, { find: 'Smith', replace: 'Jones', tables: ['people'] });
    check(r.data.rows === 3 && r.data.found.every((f) => f.table === 'people'), 'limited to chosen tables');
    r = await A('POST', `${E}/search-replace`, { find: 'tea', replace: '', preview: false });
    check(r.status === 200 && r.data.rowsChanged === 2 && T.mysql("SELECT bio FROM people WHERE id=2", 'sch') === 'Likes  and', 'replace with nothing deletes the text', r.data);
    r = await A('POST', `${E}/search-replace`, { find: 'Smith', replace: 'Jones', preview: false });
    check(r.data.rowsChanged === 5 - 1 && r.data.skipped.length === 1 && /legacy\.note \(MyISAM\)/.test(r.data.skipped[0]), 'MyISAM tables are left alone and reported', r.data);
    check(T.mysql("SELECT GROUP_CONCAT(name ORDER BY id) FROM people", 'sch') === 'Ann Jones,Ben Jones,Cy,Di Jones' && T.mysql('SELECT note FROM legacy', 'sch') === 'Smith', 'only the right data changed');
    r = await A('POST', `${E}/search-replace`, { find: 'Jones', replace: 'xx', tables: ['pets'], preview: false });
    check(r.status === 200 && r.data.rowsChanged === 1, 'a normal replacement inside pets works');
    T.mysql("UPDATE people SET name = 'Ann Jones'", 'sch');
    r = await A('POST', `${E}/search-replace`, { find: 'Jones', replace: 'y'.repeat(100), tables: ['people', 'pets'], preview: false });
    check(r.status === 400 && /Nothing was changed/.test(r.data.error) && T.mysql("SELECT COUNT(*) FROM people WHERE name = 'Ann Jones'", 'sch') === '4', 'a failure rolls everything back', r.data);

    // ---- permissions
    await A('POST', '/api/users', { username: 'ro', password: 'ro-pass-1234', role: 'user' });
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ro'], readOnly: true });
    const rc = await T.login(srv.B, 'ro', 'ro-pass-1234');
    const RO = async (body) => { const x = await fetch(`${srv.B}${E}/search-replace`, { method: 'POST', headers: { cookie: rc, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return x.status; };
    check((await RO({ find: 'Jones', replace: 'z' })) === 200 && (await RO({ find: 'Jones', replace: 'z', preview: false })) === 403, 'a read-only user can preview but not replace');
  } finally { await srv.stop(); T.mysql('DROP DATABASE IF EXISTS sch'); }
  finish();
});
