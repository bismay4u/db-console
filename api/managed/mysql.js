// Ready-made queries for MySQL / MariaDB. They only read; the ones that look at "the current database" use
// DATABASE(), i.e. whichever database the connection is using in the Query Runner (USE name). {{name}} / {{name=default}}
// are query parameters (see api/params.js): the Runner asks for the values before running.
const SYS = "('information_schema', 'mysql', 'performance_schema', 'sys')";

module.exports = [
  // ---------- Server & health
  { id: 'my-overview', category: 'Server & health', title: 'Server overview', description: 'Version, host, port, time zone and the current time on the server.',
    sql: "SELECT VERSION() AS version, @@hostname AS host, @@port AS port, @@version_comment AS flavour, @@global.time_zone AS time_zone, @@global.sql_mode AS sql_mode, NOW() AS server_time" },
  { id: 'my-uptime', category: 'Server & health', title: 'Uptime and key counters', description: 'How long the server has been up and the counters worth glancing at: threads, questions, slow queries, aborted connections, temporary tables on disk.',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Threads_running', 'Questions', 'Slow_queries', 'Aborted_connects', 'Aborted_clients', 'Created_tmp_tables', 'Created_tmp_disk_tables', 'Max_used_connections', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Innodb_row_lock_waits')" },
  { id: 'my-running', category: 'Server & health', title: 'Queries running right now', description: 'Every connection that is doing something, longest first. Use the Stop button in Server → Processes to end one.',
    sql: "SELECT ID, USER, HOST, DB, COMMAND, TIME AS seconds, STATE, LEFT(INFO, 300) AS query\nFROM information_schema.PROCESSLIST\nWHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID()\nORDER BY TIME DESC" },
  { id: 'my-long-running', category: 'Server & health', title: 'Queries running longer than…', description: 'Connections that have been busy for at least the given number of seconds.',
    sql: "SELECT ID, USER, HOST, DB, TIME AS seconds, STATE, LEFT(INFO, 300) AS query\nFROM information_schema.PROCESSLIST\nWHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID() AND TIME >= {{seconds=5}}\nORDER BY TIME DESC" },
  { id: 'my-connections-by-user', category: 'Server & health', title: 'Connections by user and host', description: 'Who is connected, from where, and how many of their connections are actually busy. Good for spotting a leaking application.',
    sql: "SELECT USER, SUBSTRING_INDEX(HOST, ':', 1) AS client, COUNT(*) AS connections, SUM(COMMAND <> 'Sleep') AS busy, MAX(TIME) AS longest_seconds\nFROM information_schema.PROCESSLIST\nGROUP BY USER, SUBSTRING_INDEX(HOST, ':', 1)\nORDER BY connections DESC" },
  { id: 'my-connection-limit', category: 'Server & health', title: 'Connection limit and usage', description: 'The maximum number of connections against what is in use now and the most ever used.',
    sql: "SELECT @@max_connections AS max_connections,\n       (SELECT COUNT(*) FROM information_schema.PROCESSLIST) AS in_use_now,\n       @@max_user_connections AS max_per_user,\n       @@wait_timeout AS wait_timeout_seconds" },
  { id: 'my-open-transactions', category: 'Server & health', title: 'Open transactions', description: 'Transactions that have been open a while hold locks and stop old versions of rows from being cleaned up.',
    sql: "SELECT trx_id, trx_state, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS open_seconds, trx_mysql_thread_id AS connection_id, trx_rows_modified, trx_rows_locked, LEFT(trx_query, 300) AS query\nFROM information_schema.INNODB_TRX\nORDER BY trx_started" },
  { id: 'my-innodb-status', category: 'Server & health', title: 'InnoDB status (locks, deadlocks)', description: 'The full InnoDB monitor output: the latest deadlock, lock waits, buffer pool and I/O figures.',
    sql: 'SHOW ENGINE INNODB STATUS' },
  { id: 'my-important-variables', category: 'Server & health', title: 'Important settings', description: 'The settings that most often explain behaviour: buffer pool, connections, logging, character set, binary log.',
    sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size', 'max_connections', 'max_allowed_packet', 'tmp_table_size', 'max_heap_table_size', 'innodb_flush_log_at_trx_commit', 'sync_binlog', 'log_bin', 'binlog_format', 'slow_query_log', 'long_query_time', 'character_set_server', 'collation_server', 'default_storage_engine', 'transaction_isolation', 'innodb_file_per_table', 'read_only')" },
  { id: 'my-slow-log', category: 'Server & health', title: 'Slow query log settings', description: 'Whether slow queries are being logged, where, and what counts as slow.',
    sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log', 'slow_query_log_file', 'long_query_time', 'log_queries_not_using_indexes', 'log_output')" },
  { id: 'my-replication', category: 'Server & health', title: 'Replication status', description: 'On a replica: whether it is running and how far behind it is. Empty on a server that does not replicate.',
    sql: 'SHOW SLAVE STATUS' },

  // ---------- Size & storage
  { id: 'my-database-sizes', category: 'Size & storage', title: 'Size of every database', description: 'Tables, rows (estimated) and megabytes per database, biggest first.',
    sql: `SELECT table_schema AS db, COUNT(*) AS tables, SUM(table_rows) AS approx_rows,\n       ROUND(SUM(data_length) / 1048576, 1) AS data_mb, ROUND(SUM(index_length) / 1048576, 1) AS index_mb,\n       ROUND(SUM(data_length + index_length) / 1048576, 1) AS total_mb\nFROM information_schema.TABLES\nWHERE table_schema NOT IN ${SYS}\nGROUP BY table_schema\nORDER BY total_mb DESC` },
  { id: 'my-largest-tables', category: 'Size & storage', title: 'Largest tables on the server', description: 'The 25 biggest tables across every database.',
    sql: `SELECT table_schema AS db, table_name AS tbl, engine, table_rows AS approx_rows,\n       ROUND(data_length / 1048576, 1) AS data_mb, ROUND(index_length / 1048576, 1) AS index_mb,\n       ROUND((data_length + index_length) / 1048576, 1) AS total_mb\nFROM information_schema.TABLES\nWHERE table_schema NOT IN ${SYS} AND table_type = 'BASE TABLE'\nORDER BY data_length + index_length DESC\nLIMIT 25` },
  { id: 'my-tables-here', category: 'Size & storage', title: 'Tables in this database', description: 'Every table of the current database with engine, estimated rows, size and when it was last changed.',
    sql: "SELECT table_name AS tbl, table_type AS type, engine, table_rows AS approx_rows,\n       ROUND(data_length / 1048576, 2) AS data_mb, ROUND(index_length / 1048576, 2) AS index_mb, auto_increment, update_time, table_collation\nFROM information_schema.TABLES\nWHERE table_schema = DATABASE()\nORDER BY data_length + index_length DESC" },
  { id: 'my-fragmented', category: 'Size & storage', title: 'Tables with reclaimable space', description: 'Free space inside table files (after many deletes or updates). OPTIMIZE TABLE gives it back.',
    sql: `SELECT table_schema AS db, table_name AS tbl, engine, ROUND(data_free / 1048576, 1) AS free_mb,\n       ROUND(data_length / 1048576, 1) AS data_mb, ROUND(100 * data_free / NULLIF(data_length + data_free, 0), 1) AS pct_free\nFROM information_schema.TABLES\nWHERE table_schema NOT IN ${SYS} AND table_type = 'BASE TABLE' AND data_free > 10 * 1048576\nORDER BY data_free DESC\nLIMIT 50` },
  { id: 'my-autoinc', category: 'Size & storage', title: 'Auto-increment headroom', description: 'How much of its number range each auto-increment column has used. Anything near 100% is about to start failing.',
    sql: "SELECT c.table_name AS tbl, c.column_name AS col, c.column_type, t.auto_increment AS next_value,\n       ROUND(100 * t.auto_increment / (CASE\n         WHEN c.column_type LIKE 'tinyint%unsigned%' THEN 255 WHEN c.column_type LIKE 'tinyint%' THEN 127\n         WHEN c.column_type LIKE 'smallint%unsigned%' THEN 65535 WHEN c.column_type LIKE 'smallint%' THEN 32767\n         WHEN c.column_type LIKE 'mediumint%unsigned%' THEN 16777215 WHEN c.column_type LIKE 'mediumint%' THEN 8388607\n         WHEN c.column_type LIKE 'int%unsigned%' THEN 4294967295 WHEN c.column_type LIKE 'int%' THEN 2147483647\n         WHEN c.column_type LIKE 'bigint%unsigned%' THEN 18446744073709551615 ELSE 9223372036854775807 END), 2) AS pct_used\nFROM information_schema.COLUMNS c\nJOIN information_schema.TABLES t ON t.table_schema = c.table_schema AND t.table_name = c.table_name\nWHERE c.table_schema = DATABASE() AND c.extra LIKE '%auto_increment%'\nORDER BY pct_used DESC" },

  // ---------- Schema
  { id: 'my-columns', category: 'Schema', title: 'Columns of a table', description: 'Name, type, nullability, default, key and comment of every column.',
    sql: "SELECT ordinal_position AS pos, column_name AS col, column_type, is_nullable AS nullable, column_default AS default_value, column_key AS `key`, extra, column_comment AS comment\nFROM information_schema.COLUMNS\nWHERE table_schema = DATABASE() AND table_name = {{table}}\nORDER BY ordinal_position" },
  { id: 'my-indexes-of-table', category: 'Schema', title: 'Indexes of a table', description: 'Every index with its columns in order, uniqueness and estimated cardinality.',
    sql: "SELECT index_name, non_unique = 0 AS is_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_in_order, MAX(cardinality) AS cardinality, index_type\nFROM information_schema.STATISTICS\nWHERE table_schema = DATABASE() AND table_name = {{table}}\nGROUP BY index_name, non_unique, index_type\nORDER BY index_name = 'PRIMARY' DESC, index_name" },
  { id: 'my-find-column', category: 'Schema', title: 'Find a column by name', description: 'Every table in the current database that has a column whose name contains the text.',
    sql: "SELECT table_name AS tbl, column_name AS col, column_type, is_nullable AS nullable\nFROM information_schema.COLUMNS\nWHERE table_schema = DATABASE() AND column_name LIKE '%{{text}}%'\nORDER BY table_name, ordinal_position" },
  { id: 'my-foreign-keys', category: 'Schema', title: 'Foreign keys', description: 'Which table points at which, with the delete and update rules.',
    sql: "SELECT k.table_name AS tbl, k.column_name AS col, k.referenced_table_name AS refers_to, k.referenced_column_name AS ref_col, r.update_rule, r.delete_rule, k.constraint_name\nFROM information_schema.KEY_COLUMN_USAGE k\nJOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name\nWHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL\nORDER BY k.table_name, k.constraint_name, k.ordinal_position" },
  { id: 'my-no-primary-key', category: 'Schema', title: 'Tables without a primary key', description: 'Tables with no primary key replicate badly, are hard to edit safely and slow down many tools.',
    sql: "SELECT t.table_name AS tbl, t.engine, t.table_rows AS approx_rows\nFROM information_schema.TABLES t\nLEFT JOIN information_schema.TABLE_CONSTRAINTS c ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY'\nWHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE' AND c.constraint_name IS NULL\nORDER BY t.table_rows DESC" },
  { id: 'my-redundant-indexes', category: 'Schema', title: 'Duplicate and redundant indexes', description: 'Indexes that are the same as, or only a prefix of, another index on the table. They cost space and slow writes for no benefit.',
    sql: "SELECT a.table_name AS tbl, a.index_name AS redundant_index, a.cols AS its_columns, b.index_name AS covered_by, b.cols AS other_columns\nFROM (SELECT table_name, index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND index_type = 'BTREE' GROUP BY table_name, index_name, non_unique) a\nJOIN (SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND index_type = 'BTREE' GROUP BY table_name, index_name) b\n  ON a.table_name = b.table_name AND a.index_name <> b.index_name AND (b.cols = a.cols OR b.cols LIKE CONCAT(a.cols, ',%'))\nWHERE a.index_name <> 'PRIMARY' AND a.non_unique = 1 AND (b.cols <> a.cols OR a.index_name > b.index_name)\nORDER BY a.table_name, a.index_name" },
  { id: 'my-not-utf8mb4', category: 'Schema', title: 'Tables not in utf8mb4', description: 'Tables whose collation is not utf8mb4 (they cannot store emoji, and mixing collations breaks joins).',
    sql: "SELECT table_name AS tbl, table_collation, engine, table_rows AS approx_rows\nFROM information_schema.TABLES\nWHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_collation NOT LIKE 'utf8mb4%'\nORDER BY table_name" },
  { id: 'my-not-innodb', category: 'Schema', title: 'Tables not using InnoDB', description: 'MyISAM and other engines have no transactions and no crash safety.',
    sql: `SELECT table_schema AS db, table_name AS tbl, engine, table_rows AS approx_rows\nFROM information_schema.TABLES\nWHERE table_schema NOT IN ${SYS} AND table_type = 'BASE TABLE' AND engine <> 'InnoDB'\nORDER BY table_schema, table_name` },
  { id: 'my-views', category: 'Schema', title: 'Views', description: 'Views of the current database and the SQL behind them.',
    sql: "SELECT table_name AS view_name, definer, security_type, is_updatable, view_definition\nFROM information_schema.VIEWS\nWHERE table_schema = DATABASE()\nORDER BY table_name" },
  { id: 'my-routines', category: 'Schema', title: 'Stored procedures and functions', description: 'What the current database has, who defined it and when it was last changed.',
    sql: "SELECT routine_type AS type, routine_name AS name, definer, created, last_altered\nFROM information_schema.ROUTINES\nWHERE routine_schema = DATABASE()\nORDER BY routine_type, routine_name" },
  { id: 'my-triggers', category: 'Schema', title: 'Triggers', description: 'Triggers of the current database, the table and event they fire on.',
    sql: "SELECT trigger_name, event_object_table AS tbl, action_timing AS timing, event_manipulation AS event, definer\nFROM information_schema.TRIGGERS\nWHERE trigger_schema = DATABASE()\nORDER BY event_object_table, trigger_name" },
  { id: 'my-events', category: 'Schema', title: 'Scheduled events', description: 'Server-side scheduled events of the current database and whether they are enabled.',
    sql: "SELECT event_name, status, event_type, execute_at, interval_value, interval_field, last_executed, definer\nFROM information_schema.EVENTS\nWHERE event_schema = DATABASE()\nORDER BY event_name" },

  // ---------- Performance
  { id: 'my-buffer-pool', category: 'Performance', title: 'Buffer pool hit rate', description: 'The share of reads served from memory. Well below 99% on a busy server usually means the buffer pool is too small.',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_free', 'Innodb_buffer_pool_pages_dirty')" },
  { id: 'my-lock-waits', category: 'Performance', title: 'Who is blocking whom', description: 'Waiting transactions, the transactions blocking them and what each is running. (MariaDB and MySQL 5.7; on MySQL 8 use the Server → Health page.)',
    sql: "SELECT w.requesting_trx_id AS waiting_trx, r.trx_mysql_thread_id AS waiting_connection, LEFT(r.trx_query, 200) AS waiting_query,\n       w.blocking_trx_id AS blocking_trx, b.trx_mysql_thread_id AS blocking_connection, LEFT(b.trx_query, 200) AS blocking_query,\n       TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS waited_seconds\nFROM information_schema.INNODB_LOCK_WAITS w\nJOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id\nJOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id", servers: ['mariadb', 'mysql5'] },
  { id: 'my-tmp-tables', category: 'Performance', title: 'Temporary table and sort pressure', description: 'How often queries needed temporary tables, how many spilled to disk, and how many sorts needed a merge pass.',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Created_tmp_tables', 'Created_tmp_disk_tables', 'Sort_merge_passes', 'Sort_rows', 'Select_full_join', 'Select_scan')" },
  { id: 'my-table-cache', category: 'Performance', title: 'Open tables and table cache', description: 'Whether the table cache is big enough: many opened tables per second means it is not.',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Open_tables', 'Opened_tables', 'Table_open_cache_hits', 'Table_open_cache_misses', 'Uptime')" },

  // ---------- Security & users
  { id: 'my-whoami', category: 'Security & users', title: 'Who am I, and what may I do', description: 'The account this connection signs in as and the privileges it has.',
    sql: "SELECT CURRENT_USER() AS account, USER() AS connected_as, DATABASE() AS current_database;\nSHOW GRANTS FOR CURRENT_USER()" },
  { id: 'my-accounts', category: 'Security & users', title: 'Database accounts', description: 'Every account on the server (needs access to the mysql system database).',
    sql: "SELECT User, Host FROM mysql.user ORDER BY User, Host" },
  { id: 'my-anonymous-users', category: 'Security & users', title: 'Anonymous and any-host accounts', description: 'Accounts with an empty name, or that can sign in from any address. Worth a look on a server that faces a network.',
    sql: "SELECT User, Host FROM mysql.user WHERE User = '' OR Host = '%' ORDER BY User, Host" },

  // ---------- Data checks (templates: replace the names in capitals)
  { id: 'my-t-duplicates', category: 'Data checks', title: 'Find duplicate values', description: 'Template: shows the values that appear more than once in a column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COLUMN_NAME, COUNT(*) AS n\nFROM TABLE_NAME\nGROUP BY COLUMN_NAME\nHAVING COUNT(*) > 1\nORDER BY n DESC\nLIMIT 100" },
  { id: 'my-t-orphans', category: 'Data checks', title: 'Find rows that point at nothing', description: 'Template: rows of a child table whose parent is missing. Replace CHILD, PARENT and the key columns.', template: true,
    sql: "SELECT c.*\nFROM CHILD c\nLEFT JOIN PARENT p ON p.ID = c.PARENT_ID\nWHERE c.PARENT_ID IS NOT NULL AND p.ID IS NULL\nLIMIT 100" },
  { id: 'my-t-per-day', category: 'Data checks', title: 'Rows per day', description: 'Template: how many rows were created each day, newest first. Replace TABLE_NAME and CREATED_AT.', template: true,
    sql: "SELECT DATE(CREATED_AT) AS day, COUNT(*) AS rows_created\nFROM TABLE_NAME\nGROUP BY DATE(CREATED_AT)\nORDER BY day DESC\nLIMIT 60" },
  { id: 'my-t-nulls', category: 'Data checks', title: 'How empty is a column', description: 'Template: total rows, NULLs, empty strings and distinct values of one column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COUNT(*) AS total_rows, SUM(COLUMN_NAME IS NULL) AS nulls, SUM(COLUMN_NAME = '') AS empty_strings, COUNT(DISTINCT COLUMN_NAME) AS distinct_values\nFROM TABLE_NAME" },
  { id: 'my-t-top-values', category: 'Data checks', title: 'Most common values', description: 'Template: the 20 most frequent values of a column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COLUMN_NAME, COUNT(*) AS n, ROUND(100 * COUNT(*) / (SELECT COUNT(*) FROM TABLE_NAME), 1) AS pct\nFROM TABLE_NAME\nGROUP BY COLUMN_NAME\nORDER BY n DESC\nLIMIT 20" }
];
