// Ready-made queries for PostgreSQL. They only read. "This schema" is whichever schema the Query Runner is using.
const SYS = "('pg_catalog', 'information_schema', 'pg_toast')";

module.exports = [
  // ---------- Server & health
  { id: 'pg-overview', category: 'Server & health', title: 'Server overview', description: 'Version, database, user, when the server started and the time now.',
    sql: "SELECT version() AS version, current_database() AS database, current_user AS connected_as, pg_postmaster_start_time() AS started, now() - pg_postmaster_start_time() AS uptime, now() AS server_time" },
  { id: 'pg-running', category: 'Server & health', title: 'Queries running right now', description: 'Every session that is doing something, longest first.',
    sql: "SELECT pid, usename AS user, datname AS db, application_name AS app, client_addr, state, now() - query_start AS running_for, wait_event_type, wait_event, left(query, 300) AS query\nFROM pg_stat_activity\nWHERE state <> 'idle' AND pid <> pg_backend_pid()\nORDER BY query_start" },
  { id: 'pg-long-running', category: 'Server & health', title: 'Queries running longer than…', description: 'Sessions that have been busy for at least the given number of seconds.',
    sql: "SELECT pid, usename AS user, datname AS db, state, now() - query_start AS running_for, left(query, 300) AS query\nFROM pg_stat_activity\nWHERE state <> 'idle' AND pid <> pg_backend_pid() AND now() - query_start >= make_interval(secs => {{seconds=5}})\nORDER BY query_start" },
  { id: 'pg-idle-in-transaction', category: 'Server & health', title: 'Sessions idle in a transaction', description: 'Sessions that started a transaction and are doing nothing. They hold locks and block cleanup (vacuum).',
    sql: "SELECT pid, usename AS user, datname AS db, application_name AS app, now() - xact_start AS transaction_open_for, now() - state_change AS idle_for, left(query, 300) AS last_query\nFROM pg_stat_activity\nWHERE state IN ('idle in transaction', 'idle in transaction (aborted)')\nORDER BY xact_start" },
  { id: 'pg-connections', category: 'Server & health', title: 'Connections by user and state', description: 'How many sessions each user has, and what they are doing, against the server limit.',
    sql: "SELECT usename AS user, datname AS db, state, count(*) AS sessions, current_setting('max_connections') AS max_connections\nFROM pg_stat_activity\nWHERE backend_type = 'client backend'\nGROUP BY usename, datname, state\nORDER BY sessions DESC" },
  { id: 'pg-blocking', category: 'Server & health', title: 'Who is blocking whom', description: 'Sessions waiting for a lock and the sessions holding it.',
    sql: "SELECT blocked.pid AS blocked_pid, blocked.usename AS blocked_user, left(blocked.query, 200) AS blocked_query,\n       blocking.pid AS blocking_pid, blocking.usename AS blocking_user, left(blocking.query, 200) AS blocking_query,\n       now() - blocked.query_start AS waiting_for\nFROM pg_stat_activity blocked\nJOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true\nJOIN pg_stat_activity blocking ON blocking.pid = b.pid\nORDER BY waiting_for DESC" },
  { id: 'pg-important-settings', category: 'Server & health', title: 'Important settings', description: 'The settings that most often explain behaviour: memory, connections, logging, autovacuum.',
    sql: "SELECT name, setting, unit, source\nFROM pg_settings\nWHERE name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_connections', 'wal_level', 'max_wal_size', 'checkpoint_timeout', 'autovacuum', 'log_min_duration_statement', 'statement_timeout', 'idle_in_transaction_session_timeout', 'timezone', 'server_encoding')\nORDER BY name" },
  { id: 'pg-replication', category: 'Server & health', title: 'Replication', description: 'Connected replicas and how far behind they are. Empty when nothing replicates from this server.',
    sql: "SELECT client_addr, state, sync_state, sent_lsn, replay_lsn, pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_behind, replay_lag\nFROM pg_stat_replication" },

  // ---------- Size & storage
  { id: 'pg-database-sizes', category: 'Size & storage', title: 'Size of every database', description: 'Each database on the server, biggest first.',
    sql: "SELECT datname AS db, pg_size_pretty(pg_database_size(datname)) AS size, pg_database_size(datname) AS bytes\nFROM pg_database\nWHERE NOT datistemplate\nORDER BY pg_database_size(datname) DESC" },
  { id: 'pg-largest-tables', category: 'Size & storage', title: 'Largest tables', description: 'The 25 biggest tables (with their indexes and TOAST data) in this database.',
    sql: `SELECT n.nspname AS schema, c.relname AS tbl, c.reltuples::bigint AS approx_rows,\n       pg_size_pretty(pg_table_size(c.oid)) AS table_size, pg_size_pretty(pg_indexes_size(c.oid)) AS index_size, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size\nFROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\nWHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ${SYS}\nORDER BY pg_total_relation_size(c.oid) DESC\nLIMIT 25` },
  { id: 'pg-tables-here', category: 'Size & storage', title: 'Tables in this schema', description: 'Every table of the current schema with estimated rows, size and when it was last vacuumed and analysed.',
    sql: "SELECT relname AS tbl, n_live_tup AS approx_rows, n_dead_tup AS dead_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size, last_autovacuum, last_autoanalyze\nFROM pg_stat_user_tables\nWHERE schemaname = current_schema()\nORDER BY pg_total_relation_size(relid) DESC" },
  { id: 'pg-bloat', category: 'Size & storage', title: 'Tables that need vacuuming', description: 'Tables with many dead rows (left by updates and deletes) that autovacuum has not cleaned yet.',
    sql: "SELECT schemaname AS schema, relname AS tbl, n_live_tup AS live_rows, n_dead_tup AS dead_rows, round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS pct_dead, last_autovacuum, last_vacuum\nFROM pg_stat_user_tables\nWHERE n_dead_tup > 1000\nORDER BY n_dead_tup DESC\nLIMIT 50" },

  // ---------- Schema
  { id: 'pg-columns', category: 'Schema', title: 'Columns of a table', description: 'Name, type, nullability and default of every column of a table in the current schema.',
    sql: "SELECT ordinal_position AS pos, column_name AS col, data_type, character_maximum_length AS max_length, is_nullable AS nullable, column_default AS default_value\nFROM information_schema.columns\nWHERE table_schema = current_schema() AND table_name = {{table}}\nORDER BY ordinal_position" },
  { id: 'pg-indexes-of-table', category: 'Schema', title: 'Indexes of a table', description: 'Every index of a table with its definition and size.',
    sql: "SELECT indexname AS index_name, pg_size_pretty(pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(indexname))) AS size, indexdef AS definition\nFROM pg_indexes\nWHERE schemaname = current_schema() AND tablename = {{table}}\nORDER BY indexname" },
  { id: 'pg-find-column', category: 'Schema', title: 'Find a column by name', description: 'Every table in the current schema that has a column whose name contains the text.',
    sql: "SELECT table_name AS tbl, column_name AS col, data_type, is_nullable AS nullable\nFROM information_schema.columns\nWHERE table_schema = current_schema() AND column_name ILIKE '%{{text}}%'\nORDER BY table_name, ordinal_position" },
  { id: 'pg-foreign-keys', category: 'Schema', title: 'Foreign keys', description: 'Which table points at which, with the full definition of each constraint.',
    sql: "SELECT conrelid::regclass AS tbl, conname AS constraint_name, confrelid::regclass AS refers_to, pg_get_constraintdef(oid) AS definition\nFROM pg_constraint\nWHERE contype = 'f' AND connamespace = current_schema()::regnamespace\nORDER BY conrelid::regclass::text, conname" },
  { id: 'pg-no-primary-key', category: 'Schema', title: 'Tables without a primary key', description: 'Tables with no primary key replicate badly and are hard to edit safely.',
    sql: "SELECT c.relname AS tbl, c.reltuples::bigint AS approx_rows\nFROM pg_class c\nWHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace\n  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)\nORDER BY c.reltuples DESC" },
  { id: 'pg-extensions', category: 'Schema', title: 'Installed extensions', description: 'Extensions installed in this database and their versions.',
    sql: "SELECT extname AS extension, extversion AS version, extnamespace::regnamespace AS schema FROM pg_extension ORDER BY extname" },

  // ---------- Performance
  { id: 'pg-unused-indexes', category: 'Performance', title: 'Indexes that are never used', description: 'Indexes no query has used since statistics were last reset. They cost space and slow writes. (Unique and primary key indexes are left out: they enforce rules.)',
    sql: "SELECT s.schemaname AS schema, s.relname AS tbl, s.indexrelname AS index_name, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size, s.idx_scan AS times_used\nFROM pg_stat_user_indexes s\nJOIN pg_index i ON i.indexrelid = s.indexrelid\nWHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary\nORDER BY pg_relation_size(s.indexrelid) DESC\nLIMIT 50" },
  { id: 'pg-seq-scans', category: 'Performance', title: 'Tables read mostly by full scans', description: 'Big tables where sequential scans far outnumber index scans: candidates for a missing index.',
    sql: "SELECT schemaname AS schema, relname AS tbl, seq_scan, idx_scan, seq_tup_read AS rows_read_by_scans, n_live_tup AS approx_rows\nFROM pg_stat_user_tables\nWHERE seq_scan > 0 AND n_live_tup > 10000\nORDER BY seq_tup_read DESC\nLIMIT 25" },
  { id: 'pg-cache-hit', category: 'Performance', title: 'Cache hit ratio', description: 'The share of table and index reads served from memory. Below about 99% on a busy database suggests too little memory.',
    sql: "SELECT 'tables' AS kind, round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS hit_pct FROM pg_statio_user_tables\nUNION ALL\nSELECT 'indexes', round(100.0 * sum(idx_blks_hit) / nullif(sum(idx_blks_hit) + sum(idx_blks_read), 0), 2) FROM pg_statio_user_indexes" },
  { id: 'pg-slowest-statements', category: 'Performance', title: 'Slowest statements (pg_stat_statements)', description: 'The statements that took the most total time. Needs the pg_stat_statements extension; it fails with a clear message when that is missing.',
    sql: "SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, rows, left(query, 300) AS query\nFROM pg_stat_statements\nORDER BY total_exec_time DESC\nLIMIT 25" },
  { id: 'pg-transaction-wraparound', category: 'Performance', title: 'Transaction ID age', description: 'How close each database is to transaction ID wraparound (autovacuum prevents it; a number near 2 billion is an emergency).',
    sql: "SELECT datname AS db, age(datfrozenxid) AS xid_age, round(100.0 * age(datfrozenxid) / 2147483647, 1) AS pct_of_limit\nFROM pg_database\nORDER BY age(datfrozenxid) DESC" },

  // ---------- Security & users
  { id: 'pg-whoami', category: 'Security & users', title: 'Who am I', description: 'The role this connection signs in as and whether it is a superuser.',
    sql: "SELECT current_user AS role, session_user AS session_role, current_database() AS database, current_schema() AS schema, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser" },
  { id: 'pg-roles', category: 'Security & users', title: 'Roles', description: 'Every role with the attributes that matter: login, superuser, create database, replication.',
    sql: "SELECT rolname AS role, rolcanlogin AS can_login, rolsuper AS superuser, rolcreatedb AS create_db, rolcreaterole AS create_roles, rolreplication AS replication, rolconnlimit AS connection_limit, rolvaliduntil AS password_expires\nFROM pg_roles\nWHERE rolname NOT LIKE 'pg\\_%'\nORDER BY rolname" },

  // ---------- Data checks
  { id: 'pg-t-duplicates', category: 'Data checks', title: 'Find duplicate values', description: 'Template: shows the values that appear more than once in a column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COLUMN_NAME, count(*) AS n\nFROM TABLE_NAME\nGROUP BY COLUMN_NAME\nHAVING count(*) > 1\nORDER BY n DESC\nLIMIT 100" },
  { id: 'pg-t-orphans', category: 'Data checks', title: 'Find rows that point at nothing', description: 'Template: rows of a child table whose parent is missing. Replace CHILD, PARENT and the key columns.', template: true,
    sql: "SELECT c.*\nFROM CHILD c\nLEFT JOIN PARENT p ON p.ID = c.PARENT_ID\nWHERE c.PARENT_ID IS NOT NULL AND p.ID IS NULL\nLIMIT 100" },
  { id: 'pg-t-per-day', category: 'Data checks', title: 'Rows per day', description: 'Template: how many rows were created each day, newest first. Replace TABLE_NAME and CREATED_AT.', template: true,
    sql: "SELECT CREATED_AT::date AS day, count(*) AS rows_created\nFROM TABLE_NAME\nGROUP BY 1\nORDER BY day DESC\nLIMIT 60" },
  { id: 'pg-t-nulls', category: 'Data checks', title: 'How empty is a column', description: 'Template: total rows, NULLs and distinct values of one column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT count(*) AS total_rows, count(*) - count(COLUMN_NAME) AS nulls, count(DISTINCT COLUMN_NAME) AS distinct_values\nFROM TABLE_NAME" }
];
