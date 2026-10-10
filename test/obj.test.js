// Ported from the original ad-hoc scripts: views, procedures, functions, triggers and events.
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
const mysql = (sql) => T.mysql(sql, 'objt');
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('views, procedures, functions, triggers and events', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.objt();
  try {
  const cookie = (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).headers.get('set-cookie').split(';')[0];
  const call = async (path, body) => { const r = await fetch(B + '/api/explore/shop/objt' + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  let r = await call('/objects/save', { kind: 'procedure', sql: 'CREATE PROCEDURE add_item(IN n VARCHAR(50))\nBEGIN\n  INSERT INTO items (name) VALUES (n);\n  SELECT COUNT(*) AS c FROM items;\nEND;' });
  check(r.status === 200 && r.data.name === 'add_item', 'create procedure with ; in body', r.data);
  mysql("CALL add_item('a')");
  check(mysql('SELECT COUNT(*) FROM items') === '1', 'procedure works');
  r = await call('/objects/save', { kind: 'procedure', name: 'add_item', sql: 'CREATE PROCEDURE add_item(IN n VARCHAR(50))\nBEGIN\n  INSERT INTO no_such_table VALUES (n) oops;\nEND' });
  check(r.status === 400 && mysql("SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='objt' AND ROUTINE_NAME='add_item'") === '1', 'broken edit fails and the original procedure is put back', r.data.error);
  mysql("CALL add_item('b')");
  check(mysql('SELECT COUNT(*) FROM items') === '2', 'restored procedure still works');
  r = await call('/objects/save', { kind: 'procedure', name: 'add_item', sql: "CREATE PROCEDURE add_item(IN n VARCHAR(50))\nBEGIN\n  INSERT INTO items (name) VALUES (CONCAT('v2-', n));\nEND", preview: true });
  check(r.data.sql.startsWith('DROP PROCEDURE IF EXISTS `add_item`;\nCREATE PROCEDURE'), 'edit preview: drop + create', r.data.sql.split('\n')[0]);
  await call('/objects/save', { kind: 'procedure', name: 'add_item', sql: "CREATE PROCEDURE add_item(IN n VARCHAR(50))\nBEGIN\n  INSERT INTO items (name) VALUES (CONCAT('v2-', n));\nEND" });
  mysql("CALL add_item('c')");
  check(mysql('SELECT name FROM items ORDER BY id DESC LIMIT 1') === 'v2-c', 'edited procedure applied');
  r = await call('/objects/save', { kind: 'function', sql: 'CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC BEGIN DECLARE y INT; SET y = x * 2; RETURN y; END' });
  check(r.status === 200 && mysql('SELECT twice(4)') === '8', 'function');
  r = await call('/objects/save', { kind: 'trigger', sql: "CREATE TRIGGER items_bi BEFORE INSERT ON items FOR EACH ROW BEGIN SET NEW.created = NOW(); INSERT INTO log VALUES (CONCAT('new ', NEW.name)); END" });
  mysql("INSERT INTO items (name) VALUES ('t')");
  check(r.status === 200 && mysql("SELECT msg FROM log ORDER BY msg DESC LIMIT 1") === 'new t' && mysql("SELECT created IS NOT NULL FROM items WHERE name='t'") === '1', 'trigger');
  r = await call('/objects/save', { kind: 'view', sql: 'CREATE VIEW recent AS SELECT id, name FROM items ORDER BY id DESC' });
  check(r.status === 200 && mysql('SELECT COUNT(*) FROM recent') === '4', 'view');
  r = await call('/objects/save', { kind: 'view', name: 'recent', sql: 'CREATE VIEW recent AS SELECT id FROM items WHERE id > 2' });
  check(r.status === 200 && mysql('SELECT COUNT(*) FROM recent') === '2', 'edit view');
  r = await call('/objects/save', { kind: 'event', sql: 'CREATE EVENT cleanup ON SCHEDULE EVERY 1 DAY DISABLE DO BEGIN DELETE FROM log WHERE msg IS NULL; END' });
  check(r.status === 200 && mysql("SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='objt'") === '1', 'event');
  r = await call('/objects/save', { kind: 'view', sql: 'DROP TABLE items' });
  check(r.status === 400, 'non-CREATE rejected', r.data.error);
  r = await call('/objects/save', { kind: 'view', sql: 'CREATE PROCEDURE x() BEGIN END' });
  check(r.status === 400, 'kind mismatch rejected', r.data.error);
  r = await call('/objects/save', { kind: 'procedure', sql: 'DELIMITER ;;\nCREATE PROCEDURE x() BEGIN END;;' });
  check(r.status === 400, 'DELIMITER rejected (statement must be whole)', r.data.error);
  for (const [kind, name] of [['view', 'recent'], ['trigger', 'items_bi'], ['event', 'cleanup'], ['function', 'twice'], ['procedure', 'add_item']]) await call('/objects/drop', { kind, name });
  check(mysql("SELECT (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='objt') + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='objt') + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='objt') + (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='objt')") === '0', 'drop all five kinds');
  } finally {
    await srv.stop();
  }
  T.finish();
});
