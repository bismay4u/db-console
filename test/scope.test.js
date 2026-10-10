const { test } = require('node:test');
const assert = require('node:assert');
const scope = require('../api/scope');

const s = scope.forUser({ shareScopes: { ann: { databases: ['Shop', 'crm'], hideTables: ['users', 'shop.payments'] } } }, 'ann');

test('scopes come from the user\'s entry, then the everyone entry', () => {
  assert.strictEqual(scope.forUser({}, 'ann'), null);
  assert.strictEqual(scope.forUser({ shareScopes: { '*': { databases: [], hideTables: [] } } }, 'ann'), null);
  assert.deepStrictEqual(scope.forUser({ shareScopes: { '*': { databases: ['a'], hideTables: [] } } }, 'bob'), { databases: ['a'], hideTables: [] });
  assert.deepStrictEqual(scope.clean({ ann: { databases: 'a, b ,`c`', hideTables: ['x', 'x'] }, nobody: { databases: ['z'] } }, ['ann']), { ann: { databases: ['a', 'b', 'c'], hideTables: ['x'] } });
  assert.ok(scope.dbAllowed(s, 'SHOP') && !scope.dbAllowed(s, 'hr'));
  assert.ok(scope.tableHidden(s, 'crm', 'Users') && scope.tableHidden(s, 'shop', 'payments') && !scope.tableHidden(s, 'crm', 'payments'));
});

test('statements are read for databases and tables', () => {
  const known = ['shop', 'crm', 'hr'];
  const ok = (sql, db = 'shop') => assert.strictEqual(scope.checkSql(s, sql, db, known), null, sql);
  const no = (sql, re, db = 'shop') => assert.match(scope.checkSql(s, sql, db, known) || '', re, sql);
  ok('SELECT * FROM orders o JOIN items i ON i.order_id = o.id');
  ok('SELECT * FROM crm.contacts');
  ok('USE crm');
  ok("SELECT 'users' AS label, 'hr.secrets' FROM orders -- users");
  ok('SELECT o.id, o.total FROM orders o');
  no('SELECT 1', /only work in/, 'hr');
  no('SELECT * FROM hr.salaries', /database hr/);
  no('SELECT * FROM `hr`.`salaries`', /database hr/);
  no('USE hr', /database hr/);
  no('SHOW DATABASES', /SHOW DATABASES/);
  no('SELECT * FROM information_schema.tables', /database information_schema|system schemas/);
  no('SELECT * FROM users', /table users/);
  no('SELECT * FROM `Users`', /table users/);
  no('SELECT * FROM crm.users', /table users/);
  no('SELECT * FROM payments', /table payments/);
  no('UPDATE shop.payments SET a = 1', /table payments/);
  assert.strictEqual(scope.checkSql(null, 'SELECT * FROM anything', 'x'), null);
  const onlyTables = scope.forUser({ shareScopes: { ann: { hideTables: ['secret'] } } }, 'ann');
  assert.strictEqual(scope.checkSql(onlyTables, 'SELECT * FROM other.t', 'whatever'), null);
  assert.match(scope.checkSql(onlyTables, 'SELECT * FROM secret', 'whatever'), /secret/);
});
