# DB Console

A small internal admin tool: log in with one fixed username/password, manage
a set of MySQL database connections, run SQL commands against one or many of
them at once, and save frequently-used queries for later.

## Stack
- Backend: Node.js, Express, mysql2 (pooled per connection), express-session
- Storage: JSON files on disk (`data/connections.json`, `data/queries.json`) — no extra database required for the tool itself
- Frontend: Alpine.js + Bootstrap 5 + Bootstrap Icons, plain HTML, no build step

## Setup

```bash
npm install
node server.js
```

Open http://localhost:3000 and log in.

## Configuration

Edit `config.js` (or set the matching environment variables):

- `APP_USER` / `APP_PASS` — the single fixed login for this tool.
- `SESSION_SECRET` — random string used to sign session cookies.
- `databases` — optional **seed data**, only used the very first time the
  app runs, to populate `data/connections.json`. After that, manage
  connections from the "Connections" tab in the UI instead.

## Features

- **Explore** — pick a connection, browse every database on that server, click a
  table to see its data in a paginated, sortable grid (click a column header
  to sort), view its structure (columns/types/keys), and edit, add, or delete
  rows with plain clicks. No SQL required for normal browsing — a "Structure"
  view and row actions cover the common Adminer-style workflows. Tables
  without a detected primary key are shown read-only, since editing/deleting
  a specific row safely requires one. Selecting a table shows its indexes
  right away (chips above the grid) and in full on the Structure tab, along
  with its DDL. **Views** get their own icon and are read-only; the left
  panel also lists **routines, triggers and events** (tabs appear only when
  the database has some) — click one to read its definition.
- **CSV export** — export a full table (server-streamed, works for large
  tables without buffering them in memory) or export the rows returned by
  any query in the Query Runner (client-side, from what's already loaded).
- **CSV import** — upload a CSV into a table with a click-driven column
  mapping step. The file is parsed and sent to the server in batches on the
  client side (via PapaParse's streaming file API), so large CSVs don't need
  to fit in memory or in a single request. Optionally truncates the table
  first.
- **Backup / Restore** — download a **tar.gz** backup of a database: a
  `SHOW CREATE TABLE`-based structure dump plus batched `INSERT`s for data,
  written to a temp file first (so its exact size is known, which the tar
  format requires), then streamed into a single-entry tar archive and
  gzipped straight to the download — the dump itself is never held fully in
  memory. Restore accepts **either** a plain `.sql` file **or** a `.tar.gz`
  made by the Backup button: the upload is read as a stream (gunzipped and
  un-tar'd on the fly for `.tar.gz`), split into statements with a
  quote/comment-aware parser, and executed one at a time with live progress
  and per-statement error reporting — so a large dump is never buffered
  whole either. No `mysqldump`/`tar` binary dependency; the tar/gzip
  handling is built on Node's built-in `zlib` plus a small hand-rolled
  USTAR reader/writer, verified against the real `tar` command.
- **Query Runner** — pick one or more saved connections, write SQL, run it
  against all selected databases in parallel, and see per-database results
  (rows, affected-row counts, or errors) in separate cards.
- **Connections** — add, edit, delete, and test MySQL connections from the
  UI. Settings are persisted to `data/connections.json`. Passwords are never
  sent back to the browser after saving (the edit form shows a blank
  password field — leave it blank to keep the existing password).
- **Clone to edit** (Connections tab) opens the connection form pre-filled as
  a new connection — nothing is saved until you click Save, and leaving the
  password blank reuses the original's (the browser never sees stored
  passwords; the server resolves it via `passwordFrom`).
- **Saved Queries** — save a SQL snippet with a name, edit or delete it
  later, and load it straight into the Query Runner with one click.
  Persisted to `data/queries.json`.

## How it works

- `POST /api/login` checks credentials against `config.js` and starts a session.
- `/api/connections` (GET/POST), `/api/connections/:key` (PUT/DELETE),
  `/api/connections/:key/test` and `/api/connections/test` manage and test
  connections.
- `/api/queries` (GET/POST) and `/api/queries/:id` (PUT/DELETE) manage saved queries.
- `/api/explore/:key/databases` lists every database on that connection's
  server; `/api/explore/:key/:database/tables` lists its tables;
  `/api/explore/:key/:database/:table/columns` returns structure + primary
  key; `/api/explore/:key/:database/:table/rows` (GET, with `page`,
  `pageSize`, `sortCol`, `sortDir`) returns paginated/sorted data, and
  (PUT/POST/DELETE) updates, inserts, or deletes a single row identified by
  its primary key.
- `/api/explore/:key/:database/objects` returns tables+views, routines,
  triggers and events in one call (routines/triggers/events degrade to an
  empty list if the user lacks privileges); `/:table/indexes` returns a
  table's indexes; `/definition/:kind/:name` returns `SHOW CREATE` output for
  a table, view, procedure, function, trigger or event.
- `/api/explore/:key/:database/:table/export.csv` (GET) streams a full table
  as CSV; `/api/explore/:key/:database/:table/import` (POST, JSON body
  `{columns, rows, truncate}`) inserts one already-parsed batch of CSV rows
  (the browser does the parsing/batching, so large files never arrive as one
  giant request).
- `/api/explore/:key/:database/backup.tar.gz` (GET) streams a tar.gz backup
  of a database; `/api/explore/:key/:database/restore?format=sql|targz`
  (POST, raw file as the request body — not JSON) executes it
  statement-by-statement as it streams in and responds with
  newline-delimited JSON progress events. `format` defaults to `sql` if
  omitted; the frontend sets it automatically from the picked file's name.
- `POST /api/query` takes `{ dbKeys: [...], sql: "..." }`, runs the SQL
  against each selected connection's pool in parallel, and returns a
  per-database result.
- `db.js` caches one mysql2 pool per connection and automatically rebuilds
  it if that connection's settings change.
- All `/api/*` routes except `/api/login` require an authenticated session.

## Notes / things to harden before production use

- This tool runs arbitrary SQL supplied by the logged-in user — treat it as
  an admin-only tool, keep it off the public internet, and put it behind a
  VPN or an additional reverse-proxy auth layer.
- Connection passwords are stored **in plaintext** in `data/connections.json`.
  Restrict filesystem access to that directory, or swap in a secrets
  manager / encrypted store if this will hold production credentials.
- Cookies are `httpOnly` but not marked `secure` — set `cookie.secure = true`
  in `server.js` once you serve this over HTTPS.
- Consider using a read-only DB user for exploratory querying, and a
  separate write-capable one only where actually needed.
- `multipleStatements` is disabled in `db.js` by default; only enable it if
  you understand the SQL-injection implications.
- The JSON-file store has no locking — fine for a single admin user, but if
  several people will edit connections/queries at once, move to a real
  table.
- Backups include tables (structure + data) and views, but **not** routines,
  triggers or events: their bodies contain `;` and need `DELIMITER`
  handling, which the restore parser doesn't do. Views are dumped as
  `SHOW CREATE VIEW` returns them, so restoring into a *differently named*
  database may need the schema qualifiers edited.
- Backup/restore run purely through `mysql2` (no `mysqldump`/`mysql` CLI
  dependency), streaming table-by-table so memory stays bounded regardless
  of database size — but restore executes statements sequentially over one
  connection, so a very large restore can still take a long time. If you
  put this behind a reverse proxy, make sure its request/response timeouts
  are generous enough (or disabled) for large backup downloads and restores.
