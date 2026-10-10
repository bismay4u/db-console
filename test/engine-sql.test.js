const { test } = require('node:test');
const assert = require('node:assert');
const sql = require('../api/engines/sql');

test('PostgreSQL splitting: dollar quotes, E strings, nested comments', () => {
  const s = (t) => sql.splitSql(t, 'postgres');
  assert.deepStrictEqual(s('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
  assert.deepStrictEqual(s("SELECT 'a;b'; SELECT \"x;y\" FROM t"), ["SELECT 'a;b'", 'SELECT "x;y" FROM t']);
  assert.deepStrictEqual(s('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1'), ['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql', 'SELECT 1']);
  assert.deepStrictEqual(s('DO $tag$ BEGIN PERFORM 1; END $tag$; SELECT 2'), ['DO $tag$ BEGIN PERFORM 1; END $tag$', 'SELECT 2']);
  assert.deepStrictEqual(s("SELECT E'a\\'b;c'; SELECT 2"), ["SELECT E'a\\'b;c'", 'SELECT 2']);
  assert.deepStrictEqual(s('/* a /* nested ; */ still */ SELECT 1; -- c; d\nSELECT 2'), ['/* a /* nested ; */ still */ SELECT 1', '-- c; d\nSELECT 2']);
  assert.deepStrictEqual(s('SELECT $1, price$2; SELECT 2'), ['SELECT $1, price$2', 'SELECT 2'], 'a $ that is not a quote is just a character');
  assert.deepStrictEqual(s('  ; ; -- nothing\n'), []);
});

test('SQLite splitting: trigger bodies, brackets, backticks', () => {
  const s = (t) => sql.splitSql(t, 'sqlite');
  assert.deepStrictEqual(s('CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; DELETE FROM c; END; SELECT 1'), ['CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; DELETE FROM c; END', 'SELECT 1']);
  assert.deepStrictEqual(s('BEGIN; INSERT INTO a VALUES (1); COMMIT'), ['BEGIN', 'INSERT INTO a VALUES (1)', 'COMMIT']);
  assert.deepStrictEqual(s('SELECT [a;b] FROM `c;d`; SELECT 2'), ['SELECT [a;b] FROM `c;d`', 'SELECT 2']);
  assert.deepStrictEqual(s('SELECT 1 # not a comment'), ['SELECT 1 # not a comment']);
});

test('filters become parameterised SQL for each dialect', () => {
  const f = [{ col: 'name', op: 'contains', value: '50%' }, { col: 'id', op: 'IN', value: '1, 2' }, { col: 'x', op: 'IS NULL' }];
  const pg = sql.buildWhere(f, ['name', 'id', 'x'], 'postgres');
  assert.strictEqual(pg.sql, 'WHERE "name"::text ILIKE $1 AND "id"::text IN ($2, $3) AND "x" IS NULL');
  assert.deepStrictEqual(pg.params, ['%50\\%%', '1', '2']);
  const lite = sql.buildWhere(f, ['name', 'id', 'x'], 'sqlite');
  assert.strictEqual(lite.sql, "WHERE \"name\" LIKE ? ESCAPE '\\' AND \"id\" IN (?, ?) AND \"x\" IS NULL");
  const any = sql.buildWhere([{ col: '*', op: '=', value: 'a' }], ['p', 'q'], 'sqlite');
  assert.strictEqual(any.sql, 'WHERE ("p" = ? OR "q" = ?)');
  assert.throws(() => sql.buildWhere([{ col: 'zz', op: '=', value: 1 }], ['a'], 'sqlite'), /Unknown column/);
  assert.throws(() => sql.buildWhere([{ col: 'a', op: 'DROP', value: 1 }], ['a'], 'sqlite'), /Unsupported/);
  assert.strictEqual(sql.orderBy(['a', 'b'], [{ col: 'b', dir: 'desc' }, { col: 'nope' }]), 'ORDER BY "b" DESC');
});
