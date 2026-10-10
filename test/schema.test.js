// Ported from the original ad-hoc scripts: schema editing: databases, tables, columns, foreign keys.
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { execSync, spawn } = require('child_process');
const T = require('./helpers');
const seed = require('./fixtures');
const { check } = T;
let B, srv, S;
const mysql = (sql) => T.mysql(sql);
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('schema editing: databases, tables, columns, foreign keys', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.dropAll();
  try {
  const cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => { const r = await fetch(B + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const E = '/api/explore/shop';
  let r = await call('GET', E + '/meta');
  check(r.collations.length > 50 && r.engines.some((e) => e.name === 'InnoDB'), 'server meta: collations + engines', { collations: r.collations.length, engines: r.engines.map((e) => e.name) });
  r = await call('POST', E + '/databases', { name: 'sch', collation: 'utf8mb4_unicode_ci' });
  check(r.sql === 'CREATE DATABASE `sch` COLLATE utf8mb4_unicode_ci' && mysql("SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='sch'") === 'utf8mb4_unicode_ci', 'create database', r.sql);
  r = await call('POST', E + '/databases', { name: 'x', collation: 'utf8mb4_unicode_ci; DROP DATABASE shop' });
  check(r.status === 400 && /Invalid collation/.test(r.error), 'collation injection rejected', r.error);

  // create tables
  r = await call('POST', E + '/sch/tables', { name: 'customers', engine: 'InnoDB', comment: 'People who buy', columns: [
    { name: 'id', type: 'int unsigned', nullable: false, autoIncrement: true, primary: true },
    { name: 'email', type: 'varchar(190)', nullable: false, comment: "Customer's email" },
    { name: 'status', type: "enum('new','active','gone; really')", nullable: false, default: { mode: 'value', value: 'new' } },
    { name: 'created', type: 'datetime(3)', nullable: true, default: { mode: 'expression', value: 'CURRENT_TIMESTAMP(3)' }, onUpdate: true }
  ] });
  check(r.status === 200 && /AUTO_INCREMENT/.test(r.sql) && /PRIMARY KEY \(`id`\)/.test(r.sql), 'create table', r.sql);
  r = await call('POST', E + '/sch/tables', { name: 'orders', columns: [
    { name: 'id', type: 'int unsigned', nullable: false, autoIncrement: true, primary: true },
    { name: 'customer_id', type: 'int unsigned', nullable: true },
    { name: 'total', type: 'decimal(10,2)', nullable: false, default: { mode: 'value', value: '0.00' } }
  ] });
  check(r.status === 200, 'create orders table');
  r = await call('POST', E + '/sch/tables', { name: 'bad', columns: [{ name: 'a', type: 'int; DROP TABLE x', nullable: true }], preview: true });
  check(r.status === 400, 'type injection rejected', r.error);

  // schema details & defaults round-trip
  r = await call('GET', E + '/sch/customers/schema');
  const col = (n) => r.columns.find((c) => c.name === n);
  check(r.info.comment === 'People who buy' && col('id').autoIncrement && col('status').default.mode === 'value' && col('status').default.value === 'new'
    && col('created').default.mode === 'expression' && col('created').onUpdate && col('email').comment === "Customer's email", 'schema details parsed', r.columns.map((c) => [c.name, c.default]));

  // alter: change, add, drop, reorder, rename table, comment
  mysql("INSERT INTO sch.customers (email) VALUES ('a@x.com'),('b@y.org')");
  r = await call('POST', E + '/sch/customers/alter', { preview: true, rename: 'clients', comment: 'Clients', drop: ['created'], columns: [
    { action: 'add', def: { name: 'name', type: 'varchar(100)', nullable: true, default: { mode: 'null' } }, position: { after: 'id' } },
    { action: 'change', orig: 'email', def: { name: 'email_address', type: 'varchar(255)', nullable: false }, position: { after: 'name' } }
  ] });
  check(r.status === 200, 'alter preview', r.sql);
  delete r.sql;
  r = await call('POST', E + '/sch/customers/alter', { rename: 'clients', comment: 'Clients', drop: ['created'], columns: [
    { action: 'add', def: { name: 'name', type: 'varchar(100)', nullable: true, default: { mode: 'null' } }, position: { after: 'id' } },
    { action: 'change', orig: 'email', def: { name: 'email_address', type: 'varchar(255)', nullable: false }, position: { after: 'name' } }
  ] });
  check(r.table === 'clients' && mysql("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='sch' AND TABLE_NAME='clients'") === 'id,name,email_address,status'
    && mysql('SELECT GROUP_CONCAT(email_address) FROM sch.clients') === 'a@x.com,b@y.org', 'alter applied: rename, add, change+rename+move, drop; data kept');
  r = await call('POST', E + '/sch/clients/alter', { columns: [] });
  check(r.status === 400 && r.error === 'Nothing changed', 'empty alter rejected');
  r = await call('POST', E + '/sch/clients/alter', { columns: [{ action: 'change', orig: 'email_address', def: { name: 'email_address', type: 'int', nullable: false } }] });
  check(r.status === 400, 'failing alter reports the MySQL error', r.error);

  // foreign keys
  r = await call('POST', E + '/sch/orders/foreign-keys', { add: { name: 'fk_orders_client', columns: ['customer_id'], refTable: 'clients', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' } });
  check(r.status === 200, 'add foreign key', r.sql);
  r = await call('GET', E + '/sch/orders/schema');
  check(r.foreignKeys.length === 1 && r.foreignKeys[0].refTable === 'clients' && r.foreignKeys[0].onDelete === 'SET NULL', 'foreign key listed', r.foreignKeys);
  r = await call('POST', E + '/sch/orders/foreign-keys', { drop: 'fk_orders_client', add: { name: 'fk_orders_client', columns: ['customer_id'], refTable: 'clients', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' } });
  check(r.status === 200 && r.statements.length === 2, 'edit foreign key keeping its name (two statements)', r.statements);
  r = await call('POST', E + '/sch/orders/foreign-keys', { drop: 'fk_orders_client', add: { name: 'fk_orders_client', columns: ['total'], refTable: 'clients', refColumns: ['id'] } }).catch(() => ({}));
  check(r.status === 400 && (await call('GET', E + '/sch/orders/schema')).foreignKeys.length === 1, 'failed FK edit restores the original key', r.error);
  r = await call('GET', E + '/sch/foreign-keys');
  check(r['0'] && r['0'].table === 'orders' && !r['1'], 'database-level foreign keys', r['0']);
  mysql('ALTER TABLE sch.orders ADD COLUMN client2 INT UNSIGNED NULL');
  r = await call('POST', E + '/sch/orders/foreign-keys', { drop: 'fk_orders_client', add: { name: 'fk_orders_client', columns: ['client2'], refTable: 'clients', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' } });
  check(r.status === 200 && (await call('GET', E + '/sch/orders/schema')).foreignKeys[0].columns[0] === 'client2', 'edit FK columns keeping its name (leftover index handled)', r.statements);
  mysql('ALTER TABLE sch.orders DROP FOREIGN KEY fk_orders_client, DROP INDEX fk_orders_client, DROP COLUMN client2');
  mysql('ALTER TABLE sch.orders ADD CONSTRAINT fk_orders_client FOREIGN KEY (customer_id) REFERENCES sch.clients(id)');

  // table actions
  r = await call('POST', E + '/databases', { name: 'archive' });
  r = await call('POST', E + '/sch/table-actions', { action: 'copy', tables: ['clients'], target: 'archive' });
  check(mysql('SELECT COUNT(*) FROM archive.clients') === '2', 'copy table with data to another database');
  r = await call('POST', E + '/sch/table-actions', { action: 'copy', tables: ['clients'], newName: 'clients_backup', withData: false });
  check(mysql('SELECT COUNT(*) FROM sch.clients_backup') === '0', 'copy structure only under a new name');
  r = await call('POST', E + '/sch/table-actions', { action: 'optimize', tables: ['clients', 'orders'] });
  check(r.messages && r.messages.length >= 2, 'optimize returns per-table messages', r.messages && r.messages.map((m) => m.type + ':' + m.text));
  r = await call('POST', E + '/sch/table-actions', { action: 'truncate', tables: ['clients_backup'] });
  check(r.status === 200, 'truncate');
  r = await call('POST', E + '/sch/table-actions', { action: 'move', tables: ['clients_backup'], target: 'archive' });
  check(mysql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='archive' AND TABLE_NAME='clients_backup'") === '1', 'move table to another database');
  r = await call('POST', E + '/archive/table-actions', { action: 'drop', tables: ['clients_backup', 'clients'] });
  check(mysql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='archive'") === '0', 'drop tables');
  r = await call('POST', E + '/sch/table-actions', { action: 'drop', tables: ['nope'] });
  check(r.status === 400, 'unknown table rejected', r.error);

  // search
  r = await call('GET', E + '/sch/search?q=' + encodeURIComponent('@x.com'));
  check(r.results.length === 1 && r.results[0].table === 'clients' && r.results[0].count === 1, 'search whole database', r.results);

  // database alter / rename / drop
  r = await call('PUT', E + '/sch', { collation: 'utf8mb4_general_ci' });
  check(mysql("SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='sch'") === 'utf8mb4_general_ci', 'change database collation');
  r = await call('PUT', E + '/sch', { rename: 'sch_renamed' });
  check(r.status === 200 && mysql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='sch_renamed'") === '2' && mysql("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='sch'") === '0', 'rename database (tables moved, FK intact)', r.statements);
  check(mysql("SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='sch_renamed'") === '1', 'foreign key survived the rename');
  mysql('CREATE VIEW sch_renamed.v AS SELECT 1 AS x');
  r = await call('PUT', E + '/sch_renamed', { rename: 'sch2' });
  check(r.status === 400 && /1 views/.test(r.error), 'rename refused when the database has views', r.error);
  r = await call('DELETE', E + '/archive', {});
  check(mysql("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='archive'") === '0', 'drop database');
  const logs = await call('GET', '/api/logs?type=DDL&limit=50');
  check(logs.entries.some((e) => /RENAME TABLE/.test(e.sql)) && logs.entries.some((e) => !e.ok), 'schema changes in the query log', logs.total);
  } finally {
    await srv.stop();
  }
  T.finish();
});
