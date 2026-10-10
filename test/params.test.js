const { test } = require('node:test');
const assert = require('node:assert');
const params = require('../api/params');

test('extract lists parameters once, with defaults', () => {
  assert.deepStrictEqual(params.extract('SELECT {{a}}, {{ b = 5 }}, {{a}} -- {{ignored}}\n /* {{nope}} */'), [{ name: 'a', default: undefined }, { name: 'b', default: '5' }]);
  assert.deepStrictEqual(params.extract('SELECT 1'), []);
});

test('apply makes escaped literals', () => {
  assert.strictEqual(params.apply('SELECT * FROM t WHERE id = {{id}}', { id: '42' }), 'SELECT * FROM t WHERE id = 42');
  assert.strictEqual(params.apply('WHERE zip = {{z}}', { z: '00123' }), "WHERE zip = '00123'");
  assert.strictEqual(params.apply('WHERE n = {{n}}', { n: "O'Brien" }), "WHERE n = 'O\\'Brien'");
  assert.strictEqual(params.apply('SET a = {{x}}', { x: 'null' }), 'SET a = NULL');
  assert.strictEqual(params.apply("WHERE n LIKE '%{{q}}%'", { q: "a'b" }), "WHERE n LIKE '%a\\'b%'");
  assert.strictEqual(params.apply('WHERE a = {{x=7}} AND b = {{x}}', {}), 'WHERE a = 7 AND b = 7');
  assert.strictEqual(params.apply('WHERE a = {{x=7}}', { x: '9' }), 'WHERE a = 9');
});

test('a value cannot add statements or escape its quotes', () => {
  const out = params.apply("SELECT {{v}}; SELECT '{{w}}'", { v: "1; DROP TABLE t", w: "x'; DROP TABLE t; --" });
  assert.strictEqual(out, "SELECT '1; DROP TABLE t'; SELECT 'x\\'; DROP TABLE t; --'");
});

test('comments and backtick names are left alone; missing values are reported', () => {
  assert.strictEqual(params.apply('SELECT 1 -- {{a}}\n, {{b}}', { b: '2' }), 'SELECT 1 -- {{a}}\n, 2');
  assert.throws(() => params.apply('SELECT {{a}}, {{b}}', { a: '1' }), /\{\{b\}\}/);
  assert.strictEqual(params.apply('SELECT 1', {}), 'SELECT 1');
});

// --- through the API ---
const T = require('./helpers');
const { check, finish } = T;
test('the runner substitutes parameters server-side', { timeout: 60000 }, async () => {
  const srv = await T.startServer();
  try {
    const cookie = await T.login(srv.B);
    const run = async (body) => {
      const r = await fetch(srv.B + '/api/query', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ dbKeys: ['shop'], databases: { shop: 'shop' }, ...body }) });
      return { status: r.status, data: await r.json() };
    };
    let r = await run({ sql: 'SELECT {{n}} + 1 AS v, {{s}} AS s', params: { n: '41', s: "x'; DROP TABLE t; --" } });
    const st = r.data.results[0].statements;
    check(st.length === 1 && st[0].rows[0].v == 42 && st[0].rows[0].s === "x'; DROP TABLE t; --", 'values arrive as data, not SQL', st[0].rows || st[0]);
    check(/^SELECT 41 \+ 1 AS v/.test(st[0].sql) && !/\{\{/.test(st[0].sql), 'the result and log show the SQL that ran', st[0].sql);
    r = await run({ sql: 'SELECT {{missing}}', params: {} });
    check(r.status === 400 && /missing/.test(r.data.error), 'a missing value is a 400', r.data);
    r = await run({ sql: 'SELECT {{a=3}} AS a' });
    check(r.data.results[0].statements[0].rows[0].a == 3, 'defaults apply');
  } finally { await srv.stop(); }
  finish();
});
