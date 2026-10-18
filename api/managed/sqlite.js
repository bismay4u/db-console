// Ready-made queries for SQLite. They only read.
module.exports = [
  { id: 'lite-overview', category: 'Database', title: 'Database overview', description: 'SQLite version, file size, page size, encoding and journal mode.',
    sql: "SELECT sqlite_version() AS sqlite_version,\n       (SELECT page_count FROM pragma_page_count) AS pages, (SELECT page_size FROM pragma_page_size) AS page_size,\n       (SELECT page_count * page_size FROM pragma_page_count, pragma_page_size) AS bytes,\n       (SELECT freelist_count FROM pragma_freelist_count) AS free_pages,\n       (SELECT encoding FROM pragma_encoding) AS encoding, (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,\n       (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys" },
  { id: 'lite-objects', category: 'Database', title: 'Everything in this database', description: 'Tables, views, indexes and triggers with the SQL that created them.',
    sql: "SELECT type, name, tbl_name AS on_table, sql\nFROM sqlite_master\nWHERE name NOT LIKE 'sqlite!_%' ESCAPE '!'\nORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name" },
  { id: 'lite-integrity', category: 'Database', title: 'Integrity check', description: 'Checks the file for corruption. A healthy database answers "ok".',
    sql: 'PRAGMA integrity_check' },
  { id: 'lite-fk-check', category: 'Database', title: 'Foreign key violations', description: 'Rows that point at a parent row that does not exist. Empty when everything is consistent.',
    sql: 'PRAGMA foreign_key_check' },
  { id: 'lite-no-pk', category: 'Schema', title: 'Tables without a primary key', description: 'Tables that have no primary key column.',
    sql: "SELECT m.name AS tbl\nFROM sqlite_master m\nWHERE m.type = 'table' AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!'\n  AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE pk > 0)\nORDER BY m.name" },
  { id: 'lite-columns', category: 'Schema', title: 'Columns of a table', description: 'Name, type, nullability, default and primary key position of every column.',
    sql: "SELECT cid AS pos, name AS col, type, \"notnull\" = 0 AS nullable, dflt_value AS default_value, pk AS primary_key_position\nFROM pragma_table_info({{table}})\nORDER BY cid" },
  { id: 'lite-indexes-of-table', category: 'Schema', title: 'Indexes of a table', description: 'Every index of a table, whether it is unique and where it came from.',
    sql: "SELECT name AS index_name, \"unique\" AS is_unique, origin, partial\nFROM pragma_index_list({{table}})\nORDER BY name" },
  { id: 'lite-foreign-keys', category: 'Schema', title: 'Foreign keys of a table', description: 'Which table and column each foreign key points at, and the delete and update rules.',
    sql: "SELECT \"from\" AS col, \"table\" AS refers_to, \"to\" AS ref_col, on_update, on_delete\nFROM pragma_foreign_key_list({{table}})" },
  { id: 'lite-find-column', category: 'Schema', title: 'Find a column by name', description: 'Every table that has a column whose name contains the text.',
    sql: "SELECT m.name AS tbl, c.name AS col, c.type\nFROM sqlite_master m, pragma_table_info(m.name) c\nWHERE m.type = 'table' AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!' AND c.name LIKE '%{{text}}%'\nORDER BY m.name, c.cid" },

  { id: 'lite-t-duplicates', category: 'Data checks', title: 'Find duplicate values', description: 'Template: shows the values that appear more than once in a column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COLUMN_NAME, COUNT(*) AS n\nFROM TABLE_NAME\nGROUP BY COLUMN_NAME\nHAVING COUNT(*) > 1\nORDER BY n DESC\nLIMIT 100" },
  { id: 'lite-t-nulls', category: 'Data checks', title: 'How empty is a column', description: 'Template: total rows, NULLs, empty strings and distinct values of one column. Replace TABLE_NAME and COLUMN_NAME.', template: true,
    sql: "SELECT COUNT(*) AS total_rows, SUM(COLUMN_NAME IS NULL) AS nulls, SUM(COLUMN_NAME = '') AS empty_strings, COUNT(DISTINCT COLUMN_NAME) AS distinct_values\nFROM TABLE_NAME" }
];
