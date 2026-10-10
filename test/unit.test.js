// Pure-logic tests: no server and no database needed.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'dbc-unit-' + process.pid);
const db = require('../api/db');
const { CsvParser, TsvParser } = require('../api/importer');
const perms = require('../api/permissions');

const split = (text, chunk) => {
  const s = new db.SqlStatementStream();
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.feed(text.slice(i, i + chunk)));
  out.push(...s.flush());
  return out;
};

test('SQL splitter: same result however the text is chunked', () => {
  const sql = `-- comment; with semicolon
SELECT 'a;b', "c;d", \`e;f\`;/* block; */ SELECT 2 /* x */;
DELIMITER ;;
CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 'it''s;'; END;;
DELIMITER ;
INSERT INTO t VALUES ('back\\\\slash;', 3);
SELECT '--not a comment';
# hash comment; here
SELECT 9`;
  const whole = split(sql, sql.length);
  assert.strictEqual(whole.length, 6, JSON.stringify(whole));
  for (const n of [1, 2, 3, 5, 7, 11, 64]) assert.deepStrictEqual(split(sql, n), whole, `chunk size ${n}`);
  assert.ok(whole.some((s) => /CREATE PROCEDURE p\(\) BEGIN SELECT 1; SELECT 'it''s;'; END/.test(s)));
  // "--" needs a space after it to be a comment; "#" is a comment to the end of the line
  assert.deepStrictEqual(split('SELECT 5--3; SELECT 1 -- c; x\n; SELECT 2 # c; y\n;', 1), ['SELECT 5--3', 'SELECT 1 -- c; x', 'SELECT 2 # c; y']);
});

test('CSV parser: quotes, newlines in fields, NULL, CRLF, BOM-less header, chunk boundaries', () => {
  const text = 'id,name,note\r\n1,"A, ""one""",\\N\r\n2,"multi\nline",""\r\n3,plain,x';
  const expect = [
    ['id', 'name', 'note'], ['1', 'A, "one"', null], ['2', 'multi\nline', ''], ['3', 'plain', 'x']
  ];
  for (const size of [text.length, 1, 2, 3, 5, 8]) {
    const p = new CsvParser();
    const rows = [];
    for (let i = 0; i < text.length; i += size) p.feed(text.slice(i, i + size), rows);
    p.flush(rows);
    assert.deepStrictEqual(rows.map((r) => r.fields), expect, `chunk size ${size}`);
  }
  const p = new CsvParser();
  const rows = p.feed('a,b\n1,2\n\n3,4\n');
  assert.deepStrictEqual(rows.map((r) => r.line), [1, 2, 4], 'blank lines skipped, line numbers kept');
  assert.throws(() => { const q = new CsvParser(); q.feed('a\n"open'); q.flush(); }, /never closed/);
  assert.throws(() => new CsvParser('"'), /single character/);
  assert.deepStrictEqual(new CsvParser(';').feed('a;b\n1;"x;y"\n').map((r) => r.fields), [['a', 'b'], ['1', 'x;y']]);
});

test('TSV parser: escapes and NULL', () => {
  const rows = new TsvParser().feed('a\tb\n1\\t2\t\\N\nx\\\\y\t\n');
  assert.deepStrictEqual(rows.map((r) => r.fields), [['a', 'b'], ['1\t2', null], ['x\\y', '']]);
});

test('stripTrailingLimit', () => {
  const f = db.stripTrailingLimit;
  assert.strictEqual(f('SELECT 1 FROM t LIMIT 10'), 'SELECT 1 FROM t');
  assert.strictEqual(f('select 1 from t limit 5 offset 2;'), 'select 1 from t');
  assert.strictEqual(f('SELECT 1 FROM t LIMIT 5, 10'), 'SELECT 1 FROM t');
  assert.strictEqual(f('SELECT * FROM (SELECT 1 LIMIT 2) x'), 'SELECT * FROM (SELECT 1 LIMIT 2) x');
  assert.strictEqual(f("SELECT 'a limit 5' FROM t"), "SELECT 'a limit 5' FROM t");
  assert.strictEqual(f('SELECT 1 /* limit 3 */'), 'SELECT 1 /* limit 3 */');
});

test('permissions: what a statement needs', () => {
  const n = perms.statementNeeds;
  assert.strictEqual(n('SELECT 1'), 'read');
  assert.strictEqual(n('  /* c */ show tables'), 'read');
  assert.deepStrictEqual(n('INSERT INTO t VALUES (1)'), ['insert']);
  assert.deepStrictEqual(n('INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1'), ['insert', 'update']);
  assert.deepStrictEqual(n('REPLACE INTO t VALUES (1)'), ['insert', 'delete']);
  assert.deepStrictEqual(n('CREATE INDEX i ON t (a)'), ['index']);
  assert.deepStrictEqual(n('DROP INDEX i ON t'), ['index']);
  assert.deepStrictEqual(n('DROP TABLE t'), ['drop']);
  assert.deepStrictEqual(n('TRUNCATE t'), ['truncate']);
  assert.deepStrictEqual(n('ALTER TABLE t ADD c INT'), ['alter']);
  assert.deepStrictEqual(n('CALL p()'), ['sql']);
  assert.deepStrictEqual(n('SET @a = 1'), ['sql']);
});

test('permissions: denied statements and routes', () => {
  const allowed = new Set(['insert', 'update']);
  assert.strictEqual(perms.statementDenied('INSERT INTO t VALUES (1)', allowed), null);
  assert.match(perms.statementDenied('DELETE FROM t', allowed), /Delete rows/);
  assert.match(perms.statementDenied('DELETE FROM t', new Set()), /Read-only/);
  assert.match(perms.statementDenied("SELECT 1 INTO OUTFILE '/tmp/x'", allowed), /OUTFILE/);
  assert.strictEqual(perms.statementDenied('DROP TABLE t', null), null, 'null = unrestricted');
  const r = perms.exploreRequirement;
  assert.deepStrictEqual(r('GET', ['db', 't', 'rows']), []);
  assert.deepStrictEqual(r('POST', ['db', 't', 'rows']), ['insert']);
  assert.deepStrictEqual(r('PUT', ['db', 't', 'rows']), ['update']);
  assert.deepStrictEqual(r('DELETE', ['db', 't', 'rows']), ['delete']);
  assert.deepStrictEqual(r('POST', ['db', 'table-actions'], { action: 'truncate' }), ['truncate']);
  assert.deepStrictEqual(r('POST', ['db', 't', 'import-file'], {}, { options: JSON.stringify({ truncate: true, onDuplicate: 'update' }) }), ['insert', 'update', 'truncate']);
  assert.deepStrictEqual(r('POST', ['db', 'something-new', 'x', 'y']), perms.ALL, 'unknown write routes need everything');
  assert.deepStrictEqual(perms.sharedPermissions({ readOnlyShare: true }, 'u'), []);
  assert.deepStrictEqual(perms.sharedPermissions({}, 'u'), perms.ALL);
  assert.deepStrictEqual(perms.sharedPermissions({ sharePermissions: { u: ['insert', 'bogus'], '*': ['drop'] } }, 'u'), ['insert']);
  assert.deepStrictEqual(perms.sharedPermissions({ sharePermissions: { '*': ['drop'] } }, 'v'), ['drop']);
});
