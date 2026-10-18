// Managed queries: the API, and every built-in query run against a real MariaDB / PostgreSQL / SQLite.
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const T = require('./helpers');
const managed = require('../api/managed-queries');
const params = require('../api/params');
const { check, finish } = T;

const PG = { host: process.env.TEST_PG_HOST || '127.0.0.1', port: Number(process.env.TEST_PG_PORT || 5432), user: process.env.TEST_PG_USER || 'dbc', password: process.env.TEST_PG_PASS || 'dbcpass', database: process.env.TEST_PG_DB || 'dbc_pg' };
const pgUp = () => new Promise((resolve) => { const s = net.connect(PG.port, PG.host); s.setTimeout(1500); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });

test('the catalog is well formed', () => {
  const ids = managed.BUILTIN.map((q) => q.id);
  check(new Set(ids).size === ids.length, 'ids are unique');
  for (const q of managed.BUILTIN) {
    check(q.title && q.description && q.sql && q.category && managed.ENGINES.includes(q.engine), `${q.id} has all its fields`);
    check(!/\b(insert|update|delete|drop|truncate|alter|create|grant)\b/i.test(q.sql.replace(/'[^']*'/g, '')) || q.id === 'x', `${q.id} only reads`, q.sql.slice(0, 60));
    check(!q.template || /TABLE_NAME|CHILD/.test(q.sql), `${q.id} is a template with names to replace`);
    check(!params.extract(q.sql).some((p) => p.default === undefined && !['table', 'text'].includes(p.name)), `${q.id} parameters have defaults, apart from table and text`);
  }
  finish();
});

test('managed queries: API and running every built-in', { timeout: 170000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-mq-'));
  const file = path.join(dir, 'app.db');
  const srv = await T.startServer();
  const B = srv.B;
  const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
  try {
    const admin = await T.login(B);
    await call(admin, 'POST', '/api/users', { username: 'bob', password: 'bob-pass-1234', role: 'user' });
    const bob = await T.login(B, 'bob', 'bob-pass-1234');

    // ---- API
    let r = await call(bob, 'GET', '/api/managed-queries');
    check(r.status === 200 && r.data.length === managed.BUILTIN.length, 'a user lists the built-in queries', r.data.length);
    r = await call(bob, 'GET', '/api/managed-queries?engine=sqlite');
    check(r.data.length > 0 && r.data.every((q) => q.engine === 'sqlite'), 'filtered by database type');
    r = await call(bob, 'POST', '/api/managed-queries', { title: 'x', sql: 'SELECT 1' });
    check(r.status === 403, 'a user cannot add one');
    r = await call(admin, 'POST', '/api/managed-queries', { title: 'Orders today', category: 'Reports', description: 'Our daily check', sql: 'SELECT COUNT(*) FROM orders', engine: 'mysql' });
    check(r.status === 201 && r.data.id.startsWith('custom-') && !r.data.builtin, 'an admin adds one', r.data);
    const cid = r.data.id;
    r = await call(admin, 'POST', '/api/managed-queries', { title: '', sql: 'SELECT 1' });
    check(r.status === 400, 'a title is required');
    r = await call(admin, 'POST', '/api/managed-queries', { title: 'x', sql: 'SELECT 1', engine: 'oracle' });
    check(r.status === 400, 'and a known database type');
    r = await call(bob, 'GET', '/api/managed-queries?engine=mysql');
    check(r.data.some((q) => q.id === cid && q.category === 'Reports'), 'everyone sees it');
    r = await call(admin, 'PUT', `/api/managed-queries/${cid}`, { title: 'Orders today (v2)', sql: 'SELECT 2' });
    check(r.status === 200 && r.data.title === 'Orders today (v2)' && r.data.sql === 'SELECT 2' && r.data.category === 'Reports', 'an admin edits it (other fields stay)', r.data);
    r = await call(admin, 'PUT', '/api/managed-queries/my-overview', { title: 'x' });
    check(r.status === 400, 'a built-in cannot be edited');
    r = await call(admin, 'DELETE', '/api/managed-queries/my-overview');
    check(r.status === 400, 'nor deleted');
    r = await call(admin, 'PUT', '/api/managed-queries/my-overview/hidden', { hidden: true });
    check(r.data.hidden === true, 'but it can be hidden');
    r = await call(bob, 'GET', '/api/managed-queries?engine=mysql');
    check(!r.data.some((q) => q.id === 'my-overview'), 'hidden queries disappear for users');
    r = await call(admin, 'GET', '/api/managed-queries?engine=mysql');
    check(r.data.find((q) => q.id === 'my-overview').hidden === true, 'admins still see them, marked hidden');
    await call(admin, 'PUT', '/api/managed-queries/my-overview/hidden', { hidden: false });
    r = await call(bob, 'GET', '/api/managed-queries?engine=mysql');
    check(r.data.some((q) => q.id === 'my-overview'), 'and can show them again');
    r = await call(bob, 'DELETE', `/api/managed-queries/${cid}`);
    check(r.status === 403, 'a user cannot delete one');
    r = await call(admin, 'DELETE', `/api/managed-queries/${cid}`);
    check(r.data.ok, 'an admin deletes a custom one');
    r = await call(admin, 'DELETE', `/api/managed-queries/${cid}`);
    check(r.status === 404, 'once');

    // ---- run every built-in on a real database
    const withValues = (q) => {
      const values = {};
      for (const p of params.extract(q.sql)) if (p.default === undefined) values[p.name] = p.name === 'table' ? { mysql: 'people', postgres: 'people', sqlite: 'people' }[q.engine] : 'id';
      return values;
    };
    const runAll = async (engine, key, database, skip = []) => {
      const list = managed.BUILTIN.filter((q) => q.engine === engine && !q.template && !skip.includes(q.id));
      for (const q of list) {
        const res = await call(admin, 'POST', '/api/query', { dbKeys: [key], sql: q.sql, databases: { [key]: database }, params: withValues(q) });
        const first = res.data.results && res.data.results[0];
        const bad = !first || !first.ok ? (first ? first.statements.find((s) => !s.ok) : res.data) : null;
        check(res.status === 200 && first && first.ok, `${q.id} runs on ${engine}`, bad && (bad.error || bad));
      }
      return list.length;
    };

    const n1 = await runAll('mysql', 'shop', 'shop');
    check(n1 > 25, 'MariaDB: ran the MySQL queries', n1);
    // queries that return something on the sample database
    const shape = async (id, test, what) => {
      const q = managed.BUILTIN.find((x) => x.id === id);
      const res = await call(admin, 'POST', '/api/query', { dbKeys: ['shop'], sql: q.sql, databases: { shop: 'shop' }, params: withValues(q) });
      const st = res.data.results[0].statements;
      check(test(st[st.length - 1]), what, st[st.length - 1] && st[st.length - 1].rows && st[st.length - 1].rows.slice(0, 2));
    };
    await shape('my-tables-here', (s) => s.rows.some((x) => x.tbl === 'people'), 'Tables in this database lists the people table');
    await shape('my-columns', (s) => s.rows.some((x) => x.col === 'name'), 'Columns of a table finds the name column of people');
    await shape('my-database-sizes', (s) => s.rows.some((x) => x.db === 'shop'), 'Size of every database includes shop');
    await shape('my-no-primary-key', (s) => Array.isArray(s.rows), 'Tables without a primary key answers');
    await shape('my-find-column', (s) => s.rows.some((x) => x.tbl === 'people' && x.col === 'id'), 'Find a column by name finds id');
    await shape('my-whoami', (s) => s.type === 'result' || Array.isArray(s.rows), 'Who am I answers');

    // SQLite
    r = await call(admin, 'POST', '/api/connections', { engine: 'sqlite', label: 'Lite', database: file, sqliteCreate: true });
    const lk = r.data.key;
    await call(admin, 'POST', '/api/query', { dbKeys: [lk], databases: { [lk]: 'main' }, sql: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE logs (msg TEXT); CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES people(id)); CREATE INDEX idx_n ON people(name)' });
    const n2 = await runAll('sqlite', lk, 'main');
    check(n2 >= 9, 'SQLite: ran the SQLite queries', n2);
    r = await call(admin, 'POST', '/api/query', { dbKeys: [lk], databases: { [lk]: 'main' }, sql: managed.BUILTIN.find((q) => q.id === 'lite-no-pk').sql });
    check(r.data.results[0].statements[0].rows.map((x) => x.tbl).join() === 'logs', 'SQLite: finds the table without a primary key', r.data.results[0].statements[0]);
    r = await call(admin, 'POST', '/api/query', { dbKeys: [lk], databases: { [lk]: 'main' }, sql: managed.BUILTIN.find((q) => q.id === 'lite-columns').sql, params: { table: 'people' } });
    check(r.data.results[0].statements[0].rows.map((x) => x.col).join() === 'id,name', 'SQLite: columns of a table', r.data.results[0].statements[0].rows);

    // PostgreSQL
    if (await pgUp()) {
      r = await call(admin, 'POST', '/api/connections', { engine: 'postgres', label: 'PG', ...PG });
      const pk = r.data.key;
      await call(admin, 'POST', '/api/query', { dbKeys: [pk], databases: { [pk]: 'public' }, sql: 'DROP TABLE IF EXISTS people CASCADE; CREATE TABLE people (id SERIAL PRIMARY KEY, name TEXT); CREATE INDEX idx_n ON people(name)' });
      const n3 = await runAll('postgres', pk, 'public', ['pg-slowest-statements']);
      check(n3 >= 20, 'PostgreSQL: ran the PostgreSQL queries', n3);
      r = await call(admin, 'POST', '/api/query', { dbKeys: [pk], databases: { [pk]: 'public' }, sql: managed.BUILTIN.find((q) => q.id === 'pg-columns').sql, params: { table: 'people' } });
      check(r.data.results[0].statements[0].rows.map((x) => x.col).join() === 'id,name', 'PostgreSQL: columns of a table', r.data.results[0].statements[0].rows);
      await call(admin, 'POST', '/api/query', { dbKeys: [pk], databases: { [pk]: 'public' }, sql: 'DROP TABLE people' });
    } else console.log('(no PostgreSQL server: its managed queries were not run)');
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  finish();
});
