// Schema diff + migration script, and data compare.
const { test } = require('node:test');
const T = require('./helpers');
const { check, finish } = T;

test('schema and data compare', { timeout: 120000 }, async () => {
  T.mysql(`DROP DATABASE IF EXISTS sch; DROP DATABASE IF EXISTS sch2; CREATE DATABASE sch CHARACTER SET utf8mb4; CREATE DATABASE sch2 CHARACTER SET utf8mb4;
USE sch;
CREATE TABLE customers (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(60) NOT NULL, email VARCHAR(80) NULL, tier TINYINT NOT NULL DEFAULT 1, UNIQUE KEY uq_email (email), KEY idx_name (name)) ENGINE=InnoDB COMMENT='people';
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2) NOT NULL, note TEXT, KEY idx_c (customer_id), CONSTRAINT fk_oc FOREIGN KEY (customer_id) REFERENCES customers(id)) ENGINE=InnoDB;
CREATE TABLE only_in_source (id INT PRIMARY KEY, v VARCHAR(10));
CREATE VIEW v_big AS SELECT id FROM orders WHERE total > 100;
CREATE VIEW v_same AS SELECT id FROM customers;
DELIMITER ;;
CREATE PROCEDURE p_hello() BEGIN SELECT 1; SELECT 2; END;;
DELIMITER ;
USE sch2;
CREATE TABLE customers (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40) NOT NULL, phone VARCHAR(20), tier TINYINT NOT NULL DEFAULT 1, KEY idx_name (name(10))) ENGINE=InnoDB;
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(10,2) NOT NULL, note TEXT, KEY idx_c (customer_id)) ENGINE=InnoDB;
CREATE TABLE only_in_target (id INT PRIMARY KEY);
CREATE VIEW v_same AS SELECT id FROM customers;
CREATE VIEW v_old AS SELECT 1 AS x;`);
  const srv = await T.startServer();
  try {
    const cookie = await T.login(srv.B);
    const A = async (method, p, body, ck = cookie) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    const src = { key: 'shop', database: 'sch' }; const tgt = { key: 'shop', database: 'sch2' };

    // ---- schema
    let r = await A('POST', '/api/diff/schema', { source: src, target: tgt });
    const items = r.data.items;
    const has = (kind, action, name) => items.find((i) => i.kind === kind && i.action === action && i.name === name);
    check(r.status === 200 && has('table', 'create', 'only_in_source') && has('table', 'drop', 'only_in_target') && has('table', 'drop', 'only_in_target').destructive, 'tables to create and drop (drop is destructive)');
    check(has('column', 'create', 'email') && has('column', 'alter', 'name') && has('column', 'drop', 'phone') && has('column', 'drop', 'phone').destructive, 'columns to add, change and drop');
    check(has('index', 'create', 'uq_email') && has('index', 'drop', 'idx_name') && has('index', 'create', 'idx_name'), 'a changed index is rebuilt; a missing one is added');
    check(has('foreign-key', 'create', 'fk_oc'), 'foreign key to add');
    check(has('option', 'alter', 'options') && /COMMENT='people'/.test(has('option', 'alter', 'options').clause), 'table comment');
    check(has('view', 'create', 'v_big') && has('view', 'drop', 'v_old') && !items.some((i) => i.name === 'v_same'), 'views: new, removed, identical ones ignored');
    check(has('procedure', 'create', 'p_hello') && has('procedure', 'create', 'p_hello').compound, 'procedure to create');
    check(!/DROP TABLE|DROP COLUMN/.test(r.data.script) && /DROP TABLE/.test(r.data.fullScript), 'the default script leaves out the destructive changes');
    check(/ALTER TABLE `customers`/.test(r.data.script) && /DELIMITER ;;/.test(r.data.script) && r.data.script.startsWith('SET FOREIGN_KEY_CHECKS=0;'), 'script merges clauses per table and uses DELIMITER for procedures', r.data.script.slice(0, 300));
    r = await A('POST', '/api/diff/schema', { source: src, target: tgt, drops: false });
    check(!r.data.items.some((i) => i.destructive && i.action === 'drop' && ['table', 'view'].includes(i.kind)), 'drops can be switched off');

    // ---- apply everything (including destructive) and compare again
    r = await A('POST', '/api/diff/schema', { source: src, target: tgt });
    const all = r.data.items.filter((i) => !i.manual).map((i) => i.id);
    let ap = await A('POST', '/api/diff/schema/apply', { source: src, target: tgt, ids: all });
    check(ap.status === 200 && ap.data.executed > 5, 'apply runs the script on the target', ap.data);
    r = await A('POST', '/api/diff/schema', { source: src, target: tgt });
    check(r.data.items.length === 0, 'afterwards the two databases have no differences', r.data.items.map((i) => i.description));
    check(T.mysql("SELECT GROUP_CONCAT(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='sch2'") === 'customers,only_in_source,orders,v_big,v_same', 'target tables and views match');
    ap = await A('POST', '/api/diff/schema/apply', { source: src, target: tgt, ids: ['nope'] });
    check(ap.status === 400, 'unknown ids are refused', ap.data);

    // ---- permissions
    await A('POST', '/api/users', { username: 'ro', password: 'ro-pass-1234', role: 'user' });
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ro'], readOnly: true });
    T.mysql('ALTER TABLE sch2.customers ADD COLUMN extra INT');
    const roCookie = await T.login(srv.B, 'ro', 'ro-pass-1234');
    r = await A('POST', '/api/diff/schema', { source: src, target: tgt }, roCookie);
    check(r.status === 200 && r.data.items.length === 1, 'a read-only user can compare');
    ap = await A('POST', '/api/diff/schema/apply', { source: src, target: tgt, ids: r.data.items.map((i) => i.id) }, roCookie);
    check(ap.status === 400 && /Read-only|permission/i.test(ap.data.error) && T.mysql("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='sch2' AND column_name='extra'") === '1', 'but not apply', ap.data);
    T.mysql('ALTER TABLE sch2.customers DROP COLUMN extra');

    // ---- data
    T.mysql(`INSERT INTO sch.customers (id, name, email, tier) VALUES (1,'Ann','a@x',1),(2,'Ben','b@x',2),(3,'Cy','c@x',1),(4,'Di',NULL,3);
INSERT INTO sch2.customers (id, name, email, tier) VALUES (1,'Ann','a@x',1),(2,'Ben','b@x',5),(4,'Di','d@x',3),(9,'Zed','z@x',1);`);
    const dsrc = { ...src, table: 'customers' }; const dtgt = { ...tgt, table: 'customers' };
    r = await A('POST', '/api/diff/data', { source: dsrc, target: dtgt });
    check(r.status === 200 && r.data.counts.same === 1 && r.data.counts.onlySource === 1 && r.data.counts.onlyTarget === 1 && r.data.counts.changed === 2, 'data counts', r.data.counts);
    check(r.data.onlySource[0].name === 'Cy' && r.data.onlyTarget[0].name === 'Zed', 'rows only on one side');
    const ch = Object.fromEntries(r.data.changed.map((c) => [c.key.id, c.columns]));
    check(ch[2].join() === 'tier' && ch[4].join() === 'email', 'changed rows name the columns that differ', ch);
    check(/INSERT INTO `sch2`.`customers`/.test(r.data.script) && /UPDATE `sch2`.`customers` SET `tier` = 2 WHERE `id` = 2/.test(r.data.script) && /DELETE FROM/.test(r.data.script), 'sync script', r.data.script);
    ap = await A('POST', '/api/diff/data/apply', { source: dsrc, target: dtgt, actions: { insert: true, update: true } });
    check(ap.status === 200 && ap.data.executed === 3, 'apply inserts and updates (not deletes)', ap.data);
    r = await A('POST', '/api/diff/data', { source: dsrc, target: dtgt });
    check(r.data.counts.same === 4 && r.data.counts.onlyTarget === 1 && r.data.counts.changed === 0, 'only the extra target row is left', r.data.counts);
    ap = await A('POST', '/api/diff/data/apply', { source: dsrc, target: dtgt, actions: { delete: true } });
    r = await A('POST', '/api/diff/data', { source: dsrc, target: dtgt });
    check(ap.status === 200 && r.data.counts.same === 4 && r.data.counts.onlyTarget === 0, 'and then deleted on request');
    r = await A('POST', '/api/diff/data', { source: dsrc, target: dtgt, where: 'id <= 2' });
    check(r.data.counts.source === 2 && r.data.counts.target === 2, 'a WHERE limits both sides');
    r = await A('POST', '/api/diff/data', { source: { ...src, table: 'only_in_source' }, target: dtgt });
    check(r.status === 200 && r.data.keyColumns[0] === 'id', 'different tables can be compared on their shared columns');
    r = await A('POST', '/api/diff/data', { source: dsrc, target: { key: 'nope', database: 'x', table: 'y' } });
    check(r.status === 404, 'unknown connection');
  } finally { await srv.stop(); T.mysql('DROP DATABASE IF EXISTS sch; DROP DATABASE IF EXISTS sch2'); }
  finish();
});
