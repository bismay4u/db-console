// test/fixtures.js — the databases the tests work on. Every test file seeds
// what it needs before it starts, so files don't depend on each other.
const { mysql } = require('./helpers');

const seed = {
  shop() {
    mysql(`
DROP DATABASE IF EXISTS shop; CREATE DATABASE shop CHARACTER SET utf8mb4; USE shop;
CREATE TABLE people (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40));
INSERT INTO people (name) VALUES ('ann'), ('ben');
CREATE TABLE gadgets (
  id BINARY(16) PRIMARY KEY, name VARCHAR(50) NOT NULL, kind ENUM('tool','toy','it''s') NOT NULL DEFAULT 'tool',
  doc JSON NULL, photo BLOB NULL, made DATE NULL, updated DATETIME NULL, notes TEXT NULL) CHARACTER SET utf8mb4;
INSERT INTO gadgets VALUES
 (UNHEX('00112233445566778899aabbccddeeff'),'Hammer','tool','{"w":2}',REPEAT('x',500),'2024-05-01','2024-05-01 10:00:00', CONCAT(REPEAT('long ', 60), '\\nsecond line')),
 (UNHEX('ffeeddccbbaa99887766554433221100'),'Ball','toy',NULL,NULL,NULL,NULL,'short'),
 (UNHEX('0f0e0d0c0b0a09080706050403020100'),'Apple','toy',NULL,NULL,NULL,NULL,NULL);`);
  },

  diag() {
    mysql(`
DROP DATABASE IF EXISTS diag; CREATE DATABASE diag CHARACTER SET utf8mb4; USE diag;
CREATE TABLE customers (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), referred_by INT, FOREIGN KEY (referred_by) REFERENCES customers(id));
CREATE TABLE products (id INT PRIMARY KEY, title VARCHAR(80), price DECIMAL(10,2));
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, created DATETIME, FOREIGN KEY (customer_id) REFERENCES customers(id));
CREATE TABLE order_items (order_id INT, product_id INT, qty INT, PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id));
CREATE TABLE notes (id INT PRIMARY KEY, body TEXT);
CREATE TABLE keep (id INT);
CREATE VIEW big_orders AS SELECT id FROM orders;
INSERT INTO customers (name) VALUES ('ann'),('ben');
DELIMITER ;;
CREATE FUNCTION sneaky() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO notes VALUES (99,'x'); RETURN 1; END;;
DELIMITER ;`);
  },

  objt() {
    mysql(`DROP DATABASE IF EXISTS objt; CREATE DATABASE objt;
CREATE TABLE objt.items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), created DATETIME NULL);
CREATE TABLE objt.log (msg VARCHAR(100));`);
  },

  bulk() {
    mysql(`DROP DATABASE IF EXISTS bulk; CREATE DATABASE bulk; USE bulk;
CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(8,2) NOT NULL DEFAULT 1.00, note VARCHAR(50) NULL, updated DATETIME NULL, qty INT NULL);
INSERT INTO items VALUES (1,'apple',1.50,'red',NULL,5),(2,'banana',0.25,'yellow',NULL,10),(3,'cherry',3.00,NULL,NULL,0),(4,'date',2.00,'brown',NULL,7),(5,'elder',4.00,'black',NULL,1);
CREATE TABLE nopk (a INT, b VARCHAR(10)); INSERT INTO nopk VALUES (1,'x'),(2,'y');`);
  },

  // events: a table with every awkward kind of value (NULLs, empty strings, quotes,
  // newlines, tabs, JSON, binary, TIMESTAMP, generated column) and a foreign key.
  big(rows = Number(process.env.TEST_BIG_ROWS || 200000)) {
    mysql(`
DROP DATABASE IF EXISTS big; CREATE DATABASE big CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE big;
CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL, country CHAR(2));
CREATE TABLE events (
  id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NULL, kind ENUM('view','buy','refund') NOT NULL, amount DECIMAL(12,2) NULL,
  note VARCHAR(200) NULL, payload JSON NULL, raw VARBINARY(32) NULL, ts TIMESTAMP NULL, dt DATETIME(3) NULL,
  amount_x2 DECIMAL(13,2) AS (amount * 2) VIRTUAL, KEY (customer_id),
  CONSTRAINT fk_cust FOREIGN KEY (customer_id) REFERENCES customers(id));
INSERT INTO customers SELECT seq, CONCAT('Cust ', seq, IF(seq % 7 = 0, ' "quoted", comma', ''), IF(seq % 11 = 0, ' ünïcødé 😀', '')), ELT(1 + seq % 3, 'US', 'IN', 'DE') FROM seq_1_to_1000;
SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';
INSERT INTO events (id, customer_id, kind, amount, note, payload, raw, ts, dt)
SELECT seq, IF(seq % 13 = 0, NULL, 1 + seq % 1000), ELT(1 + seq % 3, 'view', 'buy', 'refund'), IF(seq % 5 = 0, NULL, (seq % 100000) / 100),
  CASE seq % 6 WHEN 0 THEN NULL WHEN 1 THEN '' WHEN 2 THEN CONCAT('line1\\nline2 "q" \\\\ back', seq) WHEN 3 THEN 'tab\\there,comma' WHEN 4 THEN '\\\\N' ELSE CONCAT('note ', seq) END,
  IF(seq % 4 = 0, NULL, JSON_OBJECT('n', seq, 's', 'x"y')), IF(seq % 3 = 0, NULL, UNHEX(LPAD(HEX(seq), 16, '0'))),
  FROM_UNIXTIME(1600000000 + seq), '2024-01-02 03:04:05.678'
FROM seq_0_to_${rows - 1};`);
    return rows;
  },

  // a database with one of each problem the analyzer looks for
  anom() {
    mysql(`
DROP DATABASE IF EXISTS anom; CREATE DATABASE anom CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; USE anom;
CREATE TABLE logs (msg VARCHAR(50), at DATETIME);
INSERT INTO logs SELECT CONCAT('m', seq), NOW() FROM seq_1_to_1500;
CREATE TABLE codes (code VARCHAR(10) NOT NULL, label VARCHAR(30), UNIQUE KEY uq_code (code));
CREATE TABLE customers (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40));
CREATE TABLE orders (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, customer_id INT UNSIGNED NOT NULL, total FLOAT, price_usd DOUBLE, note VARCHAR(20));
INSERT INTO customers SELECT seq, CONCAT('c', seq) FROM seq_1_to_200;
INSERT INTO orders (customer_id, total, price_usd) SELECT 1 + seq % 200, seq / 3, seq / 7 FROM seq_1_to_1500;
CREATE TABLE idx (a INT, b INT, c INT, KEY dup1 (a), KEY dup2 (a), KEY ab (a, b), KEY abc (a, b, c));
CREATE TABLE old_myisam (id INT PRIMARY KEY, v INT) ENGINE=MyISAM;
CREATE TABLE tiny (id TINYINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, v INT) AUTO_INCREMENT = 245;
CREATE TABLE legacy (id INT PRIMARY KEY, name VARCHAR(20)) CHARACTER SET latin1;
CREATE TABLE binary_coll (id INT PRIMARY KEY, name VARCHAR(20)) COLLATE utf8mb4_bin;
CREATE TABLE users_x (id INT PRIMARY KEY, password VARCHAR(30), api_token VARCHAR(80));
CREATE TABLE gone (id INT); CREATE VIEW broken_view AS SELECT id FROM gone; DROP TABLE gone;
CREATE VIEW fine_view AS SELECT id FROM customers;
CREATE TABLE child_int (id INT PRIMARY KEY, pid INT UNSIGNED NOT NULL, KEY (pid), CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES customers (id));
CREATE TABLE parent_big (id BIGINT UNSIGNED NOT NULL PRIMARY KEY);
CREATE EVENT ev_off ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1;
CREATE TABLE clean_t (id INT PRIMARY KEY, k INT, KEY (k));
ANALYZE TABLE logs, orders, customers;`);
  },

  // tables, a generated column, a view, a procedure, a function, a trigger and an event
  expSrc() {
    mysql(`
DROP DATABASE IF EXISTS exp_src; CREATE DATABASE exp_src CHARACTER SET utf8mb4; USE exp_src;
CREATE TABLE prod (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), price DECIMAL(8,2), price_tax DECIMAL(8,2) AS (price * 1.2) STORED, note TEXT) CHARACTER SET utf8mb4;
CREATE TABLE audit (id INT PRIMARY KEY AUTO_INCREMENT, msg VARCHAR(100)) CHARACTER SET utf8mb4;
INSERT INTO prod (name, price, note) VALUES ('Café ☕', 3.50, 'line1\nline2\ttab'), ('Tea', 2.00, NULL), ('Semi;colon', 1.00, "it's");
CREATE VIEW cheap AS SELECT id, name FROM prod WHERE price < 3;
DELIMITER ;;
CREATE PROCEDURE add_prod(IN n VARCHAR(50)) BEGIN INSERT INTO prod (name, price) VALUES (n, 9.99); SELECT COUNT(*) AS c FROM prod; END;;
CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC BEGIN DECLARE y INT; SET y = x * 2; RETURN y; END;;
CREATE TRIGGER prod_ai AFTER INSERT ON prod FOR EACH ROW BEGIN INSERT INTO audit (msg) VALUES (CONCAT('added ', NEW.name)); END;;
CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DISABLE DO BEGIN DELETE FROM audit WHERE id < 0; END;;
DELIMITER ;`);
  },

  dropAll() {
    for (const d of ['diag', 'objt', 'bulk', 'big', 'anom', 'sch', 'sch2', 'sch_renamed', 'exp_src', 'exp_r1', 'exp_r2', 'exp_r3', 'exp_r4', 'other', 'archive', 'restored', 'big_c', 'big_c2', 'big_e', 'big_i', 'big_r']) {
      mysql(`DROP DATABASE IF EXISTS ${d}`);
    }
  }
};

module.exports = seed;
