const { test } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../api/approvals');

test('which statements need approval', () => {
  assert.deepStrictEqual(classify('SELECT * FROM t'), []);
  assert.deepStrictEqual(classify('DELETE FROM t WHERE id = 1'), []);
  assert.deepStrictEqual(classify('UPDATE t SET a = 1 WHERE id = 2'), []);
  assert.deepStrictEqual(classify('DROP TABLE t'), ['DROP TABLE T']);
  assert.deepStrictEqual(classify('truncate table orders'), ['TRUNCATE orders']);
  assert.deepStrictEqual(classify('DELETE FROM t'), ['DELETE without WHERE']);
  assert.deepStrictEqual(classify('update t set a = 1'), ['UPDATE without WHERE']);
  assert.deepStrictEqual(classify("SELECT 'DROP TABLE x'; -- DROP TABLE y\n/* delete from z */ SELECT 1"), [], 'strings and comments are ignored');
  assert.deepStrictEqual(classify('SELECT 1; DROP DATABASE d; DELETE FROM t; DELETE FROM u'), ['DROP DATABASE D', 'DELETE without WHERE']);
  assert.deepStrictEqual(classify('UPDATE t SET note = \'where\''), ['UPDATE without WHERE'], 'the word where inside a string is not a WHERE clause');
});
