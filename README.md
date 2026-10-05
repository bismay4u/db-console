# DB Console

> **A small, portable database console that you can deploy almost anywhere.**

DB Console is a small, self-hosted SQL administration tool designed for environments where you need **simple database access without installing a large database management platform**.

It provides an easy-to-use web interface for exploring databases, viewing and editing tables, running SQL queries across multiple database connections, importing/exporting CSV files, and creating database backups.

It is especially useful for **client environments, small servers, support teams, development environments, field deployments, and troubleshooting scenarios** where a portable database console is more practical than a full-featured administration platform.

---

## Why DB Console?

Database administration tools are often either:

* Too large for a small deployment
* Dependent on a separate database or infrastructure
* Difficult to deploy inside a customer's environment
* Focused primarily on developers rather than support/operations teams
* Not convenient when you need a temporary, portable administration interface

DB Console takes a different approach:

**Download → Configure → Run → Connect to Database**

No separate database is required for DB Console itself.

The application stores its configuration in simple JSON files and can run as a single Node.js application.

### Typical use cases

* Deploy a database console on a customer's server
* Troubleshoot client databases remotely
* Provide a lightweight alternative to Adminer/phpMyAdmin
* Manage multiple Database environments from one interface
* Inspect production databases during support
* Run the same SQL against multiple databases
* Import/export CSV data
* Create and restore database backups
* Package the tool with an application or solution deployment
* Run as a temporary diagnostic/support utility

---

## Features

### 🗄️ Database Explorer

Browse Database servers through a structured interface.

When a database is open, the left menu slides away and is replaced by a full-height, compact list of its tables & views (plus routines, triggers and events), so the data grid gets the full width. **← Menu** brings the menu back; **Tables** shows the list again.

* Browse all databases on a connection
* Browse tables and views
* View table data (**Data** tab)
* Pagination
* Column sorting
* Search across all columns
* Adminer-style filters: column (or any column) + operator (`=`, `≠`, `<`, `>`, contains, starts/ends with, `LIKE`, `REGEXP`, `IN`, `IS NULL`...) + value, combined with AND; applied on the server, and used by CSV export too
* View table structure (**Structure** tab): columns, types, keys and the table DDL
* View `SHOW CREATE` definitions
* **Indexes** tab: list, create, edit and drop indexes (PRIMARY, UNIQUE, INDEX, FULLTEXT, SPATIAL; multiple columns, optional prefix lengths). The exact `ALTER TABLE` is shown before it runs; editing an index is a single `DROP` + `ADD` statement, so it either fully applies or not at all
* Add rows
* Edit and delete rows from the row's left-hand actions; delete always asks for confirmation
* Select rows and delete them in bulk
* Primary-key aware editing
* Read-only handling for tables without a primary key
* View definitions
* Stored procedure definitions
* Function definitions
* Trigger definitions
* Event definitions

Views are identified separately and treated as read-only objects.

---

### ⚡ SQL Query Runner

Run SQL directly against one or multiple database connections.

```text
Select databases
       ↓
Write SQL
       ↓
Execute
       ↓
┌───────────────┬───────────────┐
│ Database A    │ Database B    │
│ 125 rows      │ 125 rows      │
│ 12 ms         │ 18 ms         │
└───────────────┴───────────────┘
```

Features include:

* Execute SQL against multiple connections
* Parallel execution
* Per-database results
* Result rows
* Affected-row counts
* Error reporting
* Saved SQL queries
* Load saved queries directly into Query Runner
* `USE database_name` switches a connection's current database; it is shown in the connection list and kept for your next runs (per user, in your browser) until you run `USE` again or click the reset button next to it

This is particularly useful when the same query needs to be executed against multiple customer, branch, tenant, or environment databases.

---

### 🔌 Connection Manager

Manage Database connections directly from the web interface.

* Add connections
* Edit connections
* Delete connections
* Test connections
* Clone an existing connection
* Store multiple database environments
* Connection-specific settings
* Passwords are never returned to the browser after being saved
* Every connection has an owner
* Share a connection with specific users, or with everyone
* Shared users can use a connection but cannot see its password, edit, delete or re-share it

Example:

```text
Connections

├── Production
├── UAT
├── Development
├── Customer A
├── Customer B
└── Customer C
```

---

### 📊 CSV Export

Export table data directly to CSV.

The table export is **streamed from the database**, allowing large tables to be exported without loading the entire dataset into application memory.

`NULL` values are written as `\N` (the MySQL `LOAD DATA` / `SELECT … INTO OUTFILE` convention), so they stay distinct from empty strings and an exported table imports back exactly. JSON columns are written as JSON text.

Query results can also be exported from the Query Runner.

---

### 📥 CSV Import

Import CSV data into an existing table.

The import workflow provides:

1. Select CSV file
2. Preview data
3. Map CSV columns to table columns
4. Optionally truncate the table
5. Upload in batches
6. Insert into the database

CSV files are parsed using PapaParse's streaming file API, avoiding the need to load a large file entirely into memory or send it as one large HTTP request.

On import, `\N` becomes `NULL`. An empty value also becomes `NULL` for nullable non-text columns (numbers, dates, JSON...), where an empty string isn't a valid value; text columns keep empty strings.

---

### 💾 Backup & Restore

Create database backups without requiring the Database command-line tools.

DB Console can generate a:

```text
database-backup.tar.gz
```

containing database structure and data.

The backup process uses:

* `SHOW CREATE TABLE`
* Batched `INSERT` statements
* Temporary files
* Streaming
* Node.js built-in `zlib`
* Native Node.js implementation of the required TAR handling

No dependency on:

```text
Databasedump
Database
tar
```

is required.

### Restore

Restore either:

```text
.sql
```

or:

```text
.tar.gz
```

files.

Restore processing is streamed and executed statement-by-statement, with live progress and error reporting.

Large database dumps therefore do not need to be loaded completely into memory.

---

### 🔖 Saved Queries

Save frequently used SQL commands.

```text
Saved Queries

├── Find duplicate customers
├── Check pending transactions
├── Daily collection summary
├── Find failed jobs
└── Database health check
```

Saved queries can be:

* Created — from the editor, or from any entry in the Query Runner's **History** tab
* Edited
* Deleted
* Loaded directly into Query Runner
* Shared with specific users, or with everyone

Saved queries belong to the user who saved them. Shared queries appear in the other users' Saved Queries; they can load them or save their own copy, but only the owner can edit, delete or re-share them. Running a shared query still requires access to a connection.

---

### 👥 Users & Roles

DB Console supports multiple users, each with their own login.

| Role      | Can do                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------- |
| **admin** | Everything: all connections, every user's query log and analytics, user management, Update & Restart    |
| **user**  | Their own connections plus connections shared with them; only their own query log and analytics         |

* Passwords are stored as salted `scrypt` hashes
* Admins create, edit, disable and delete users
* Each user can change their own password
* Changing a user's password, role or status signs that user out everywhere
* Deleting a user transfers their connections and saved queries to the admin who deleted them
* The app always keeps at least one enabled admin

---

### 📜 Query Log

Everything run against a database is logged per user:

* Query Runner runs (one entry per connection)
* Row inserts, edits and deletes from Explore
* CSV imports and exports
* Backups and restores
* Update & Restart actions

Each entry records the user, time, connection, database, SQL, statement type, duration, rows returned or affected, and any error.

The log can be filtered by user, connection, source, statement type, status, date range and free text, and any Query Runner entry can be loaded back into the runner.

Users see their own entries; admins see everyone's.

---

### 📈 Analytics

Usage over the last 7, 30 or 90 days:

* Total queries, error rate, average duration, active users
* Queries per day
* Breakdown by user, connection, statement type and source
* Slowest queries

Admins can view all users or a single user; users see their own activity.

---

### 🔄 Update & Restart (admin)

Keep a deployment up to date from the browser:

* Shows the running branch, commit, local changes, PM2 process and uptime
* **Check for updates** fetches from git and lists incoming commits
* **Update & restart** runs `git pull --ff-only`, runs `npm install --omit=dev` only when `package.json` / `package-lock.json` changed, then restarts through PM2 (`pm2 reload` in cluster mode, `pm2 restart` otherwise)
* **Restart only** restarts the PM2 process without updating
* In cluster mode every instance is listed (PID, status, uptime, restarts, memory), and the restart is a rolling `pm2 reload` of all instances, one at a time
* Only one update can run at a time, across all instances

Requirements:

* The app directory is a git clone with an upstream branch configured
* The app runs under PM2 (see [Running with PM2](#running-with-pm2)) — without PM2 the update still pulls the code, but you restart manually
* The OS user running the app can run `git`, `npm` and `pm2`, and `git pull` works without prompting for credentials

Users stay signed in across updates and restarts (sessions are stored in the data directory).

---

## Lightweight by Design

DB Console deliberately keeps its architecture simple.

```text
             ┌─────────────────────┐
             │      Browser        │
             │ Bootstrap + Alpine  │
             └──────────┬──────────┘
                        │ HTTP
                        ▼
             ┌─────────────────────┐
             │    DB Console       │
             │ Node.js + Express   │
             └──────────┬──────────┘
                        │
               ┌────────┴────────┐
               │                 │
               ▼                 ▼
        JSON Configuration     Database
        connections.json      Databases
        queries.json
```

There is **no database required for DB Console itself**.

### Technology Stack

| Layer                 | Technology       |
| --------------------- | ---------------- |
| Runtime               | Node.js          |
| Backend               | Express          |
| Database Driver       | Database2           |
| Connection Pooling    | Database2 Pool      |
| Session               | express-session  |
| Frontend              | HTML + Alpine.js |
| UI                    | Bootstrap 5      |
| Icons                 | Bootstrap Icons  |
| CSV                   | PapaParse        |
| Configuration Storage | JSON             |
| Backup Compression    | Node.js zlib     |

There is also **no frontend build system required**.

---

# Quick Start

## Requirements

* Node.js 18+
* Database 5.7+ / Database 8+
* Network access to the Database server

Check Node.js:

```bash
node --version
```

---

## Installation

Clone the repository:

```bash
git clone https://github.com/<your-org>/db-console.git
cd db-console
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

Log in using the credentials configured in `config.js`.

On first start the app creates its `data/` directory (connections, saved queries, users, sessions, query log). Nothing in it is part of the repository.

---

## Running with PM2

```bash
npm install -g pm2
cp ecosystem_copy.config.js ecosystem.config.js   # adjust as needed
pm2 start ecosystem.config.js
pm2 save
```

**Cluster mode** (`exec_mode: "cluster"`) works with any number of instances (`instances: 2`, `4`, `'max'`...):

* Sessions are stored in the data directory, so any instance can serve any request, and restarts don't sign users out
* Data files are written atomically under a cross-process lock, so concurrent changes from different instances are never lost
* Login rate limiting and the "update running" lock are shared by all instances
* **Update & Restart** reloads every instance one at a time (`pm2 reload <name>`); `wait_ready` + `listen_timeout` in the ecosystem file make PM2 wait until each new instance is listening before stopping the old one

All instances must share the same data directory (the default `./data` does).

---

## Upgrading an existing installation

Older versions kept `data/connections.json` and `data/queries.json` in git. They are no longer tracked, so a plain `git pull` on a server that has changed them stops with *"Your local changes would be overwritten"*. Upgrade once with:

```bash
cp -a data /tmp/db-console-data-backup     # keep your connections and queries
git checkout -- data                        # drop the tracked copies' local changes
git pull
cp -a /tmp/db-console-data-backup/. data/   # put your data back (now ignored by git)
pm2 reload ecosystem.config.js              # or restart however you run it
```

On first start after the upgrade, existing connections and saved queries are assigned to the first admin, and the login from `config.js` becomes that admin.

---

# Configuration

DB Console can be configured using `config.js` or environment variables.

### Authentication

```text
APP_USER
APP_PASS
SESSION_SECRET
```

Example:

```javascript
module.exports = {
    appAuth: {
        username: "admin",
        password: "change-me"
    },
    sessionSecret: "replace-with-a-long-random-secret"
};
```

`appAuth` is only used the **first time** the app starts, to create the first admin account in `data/users.json`. After that, users and passwords are managed from the **Users** screen, and changing `appAuth` has no effect.

If you lose access to every admin account, stop the app, delete `data/users.json` and start it again: the admin from `appAuth` is recreated.

Connections and saved queries created before multi-user support are assigned to that first admin automatically.

### Other settings

| Setting (env / `config.js`) | Default  | Purpose |
| --------------------------- | -------- | ------- |
| `PORT`                      | `3000`   | HTTP port |
| `DATA_DIR` / `dataDir`      | `./data` | Where connections, users, sessions and the query log are stored |
| `TRUST_PROXY` / `trustProxy`| off      | Set to `1` behind a reverse proxy, so client IPs (rate limiting) and HTTPS (secure cookies) are detected from `X-Forwarded-*` |

### Database Connections

Initial database connections can optionally be provided as seed data.

For example:

```javascript
databases: [
    {
        key: "production",
        name: "Production",
        host: "127.0.0.1",
        port: 3306,
        user: "dbuser",
        password: "password"
    }
]
```

Seed data is used only when the application creates its initial connection configuration.

After that, connections can be managed through the **Connections** interface.

---

# Data Storage

DB Console does not require a database for its own configuration.

By default:

```text
data/
├── connections.json     # connections, with owner and sharing
├── queries.json         # saved queries, per user
├── users.json           # users and password hashes
├── query_log.jsonl      # query log, one JSON entry per line
├── sessions/            # one file per signed-in session
└── login_attempts.json  # failed-login counters for rate limiting
```

are used for persistent application data.

* Everything is **created automatically** on first start, and recreated if deleted; the whole directory is ignored by git
* Files are readable by the app's OS user only (`0600`) — they contain database passwords and password hashes
* Writes are atomic and locked, so several PM2 cluster instances can share the directory
* The query log rotates at 20 MB to `query_log.1.jsonl`; one previous file is kept
* The location can be changed with `DATA_DIR`

To back up DB Console itself, back up this directory.

This makes the application easy to:

* Copy
* Backup
* Move
* Deploy
* Package
* Run on small servers

---

# API

All API endpoints require an authenticated session except:

```text
POST /api/login
```

## Authentication

```http
POST /api/login
POST /api/logout
GET  /api/session
POST /api/account/password
```

---

## Users

```http
GET    /api/users/directory       # any user: active users, for sharing
GET    /api/users                 # admin
POST   /api/users                 # admin
PUT    /api/users/:username       # admin
DELETE /api/users/:username       # admin
```

---

## Connections

```http
GET    /api/connections
POST   /api/connections
PUT    /api/connections/:key
DELETE /api/connections/:key

POST /api/connections/:key/test
POST /api/connections/test

PUT  /api/connections/:key/sharing    # { "sharedWith": ["alice"] } or ["*"]
```

Only the owner or an admin can edit, delete or share a connection.

---

## Saved Queries

```http
GET    /api/queries                # yours + shared with you
POST   /api/queries
PUT    /api/queries/:id            # owner only
DELETE /api/queries/:id            # owner only
PUT    /api/queries/:id/sharing    # owner only: { "sharedWith": ["alice"] } or ["*"]
```

---

## Database Explorer

List databases:

```http
GET /api/explore/:key/databases
```

List database objects:

```http
GET /api/explore/:key/:database/objects
```

Get table structure:

```http
GET /api/explore/:key/:database/:table/columns
```

Get rows:

```http
GET /api/explore/:key/:database/:table/rows
```

Supported parameters:

```text
page
pageSize
sortCol
sortDir
filters   JSON array of { "col": "<column or *>", "op": "<operator>", "value": "..." }
```

Modify rows:

```http
POST   /api/explore/:key/:database/:table/rows
PUT    /api/explore/:key/:database/:table/rows
DELETE /api/explore/:key/:database/:table/rows
```

Indexes:

```http
GET  /api/explore/:key/:database/:table/indexes
POST /api/explore/:key/:database/:table/indexes
```

`POST` body: `{ "drop": "<index name>", "add": { "kind": "INDEX|UNIQUE|PRIMARY|FULLTEXT|SPATIAL", "name": "...", "columns": [{ "column": "...", "length": 10 }] }, "preview": true }` — `drop` and `add` together edit an index; `preview` returns the SQL without running it.

---

## CSV

Export:

```http
GET /api/explore/:key/:database/:table/export.csv
```

Import:

```http
POST /api/explore/:key/:database/:table/import
```

---

## Backup

```http
GET /api/explore/:key/:database/backup.tar.gz
```

---

## Restore

```http
POST /api/explore/:key/:database/restore?format=sql
```

or:

```http
POST /api/explore/:key/:database/restore?format=targz
```

Restore responses are delivered as newline-delimited JSON progress events.

---

## Query Execution

```http
POST /api/query
```

Example request:

```json
{
    "dbKeys": [
        "production",
        "uat"
    ],
    "sql": "SELECT COUNT(*) FROM customers"
}
```

The query is executed against the selected connections in parallel.

---

## Query Log & Analytics

```http
GET /api/logs?user=&conn=&source=&type=&status=ok|error&q=&from=&to=&limit=&offset=
GET /api/analytics?days=30&user=
```

`user` is honoured for admins only; other users always get their own data.

---

## Update & Restart (admin)

```http
GET  /api/system/status
POST /api/system/check
POST /api/system/update     # streams newline-delimited JSON progress
POST /api/system/restart
```

---

# Connection Pooling

DB Console maintains a Database connection pool for each configured connection.

```text
Connection
     │
     ▼
┌──────────────┐
│ Database Pool   │
├──────────────┤
│ Connection 1 │
│ Connection 2 │
│ Connection 3 │
│ ...          │
└──────────────┘
```

When a connection's configuration changes, its existing pool is automatically rebuilt.

---

# Security

DB Console is an **administrative database tool**.

It can execute arbitrary SQL using the credentials supplied through its database connections.

Treat it accordingly.

## Recommended deployment

Do **not** expose DB Console directly to the public Internet.

A recommended deployment is:

```text
Internet
    │
    ▼
VPN / Zero Trust / Reverse Proxy
    │
    ▼
DB Console
    │
    ▼
Private Database Network
```

Possible deployment approaches include:

* VPN
* Private network
* SSH tunnel
* Cloudflare Tunnel
* Reverse proxy authentication
* IP allowlisting
* Zero-trust access layer

---

## Important Security Considerations

### 1. Database credentials

The current implementation stores database passwords in:

```text
data/connections.json
```

in plaintext.

Protect this file using filesystem permissions.

For production deployments, consider replacing the storage layer with:

* Encrypted credentials
* Environment variables
* OS-level secret storage
* Cloud secret managers
* HashiCorp Vault
* Other secrets-management solutions

---

### 2. HTTPS

The session cookie should be configured as secure when DB Console is deployed behind HTTPS.

For example:

```javascript
cookie: {
    secure: true,
    httpOnly: true
}
```

If the application is behind a reverse proxy, configure Express's proxy settings appropriately.

---

### 3. Database privileges

Prefer using a dedicated database user with only the permissions required for the intended operation.

For example, a read-only deployment can use:

```sql
GRANT SELECT, SHOW VIEW
ON customer_db.*
TO 'dbconsole_reader'@'%';
```

For environments requiring data modification, use a separate account with the minimum required privileges.

---

### 4. Multiple statements

`multipleStatements` is disabled by default.

Do not enable it unless there is a specific requirement and you understand the associated security implications.

---

### 5. Session secret

Always replace the default session secret with a strong random value. The app logs a warning at startup while the sample value is in use.

Example:

```bash
openssl rand -hex 32
```

### 6. Accounts

* Change the default admin password: a banner is shown while an account still uses it
* After 10 failed sign-ins for the same username from one IP (or 50 from one IP), sign-in is blocked for 15 minutes. Behind a reverse proxy, set `TRUST_PROXY=1` so the real client IP is used, otherwise every user shares the proxy's IP

---

# Backup Limitations

The current backup implementation includes:

* Tables
* Table structures
* Table data
* Views

It does **not currently restore**:

* Stored procedures
* Functions
* Triggers
* Events

The reason is that these objects can contain complex SQL bodies containing semicolons and require `DELIMITER`-aware parsing.

Views are generated using `SHOW CREATE VIEW`.

When restoring a database under a different schema/database name, view definitions containing explicit schema references may need to be adjusted.

---

# Large Database Handling

DB Console is designed to avoid unnecessary memory consumption.

### Export

Table exports are streamed:

```text
Database
  ↓
Rows
  ↓
CSV stream
  ↓
HTTP response
  ↓
Browser
```

The entire table does not need to exist in application memory.

### Backup

```text
Database
  ↓
Table-by-table dump
  ↓
Temporary file
  ↓
TAR
  ↓
GZIP
  ↓
HTTP stream
```

### Restore

```text
Upload
  ↓
Stream
  ↓
GZIP / TAR processing
  ↓
SQL parser
  ↓
Statement
  ↓
Database
```

This keeps memory usage relatively bounded even when processing large databases.

However, very large restores can still take considerable time because statements are executed sequentially.

If DB Console is deployed behind a reverse proxy, configure appropriate request and response timeouts.

---

# Project Structure

A typical installation looks like:

```text
db-console/
│
├── server.js             # Express app: routes, auth, access control
├── config.js
├── ecosystem_copy.config.js
├── package.json
│
├── api/
│   ├── db.js             # MySQL pools, queries, explore, CSV, backup/restore
│   ├── store.js          # users, connections, saved queries
│   ├── datadir.js        # data directory, atomic writes, cross-process lock
│   ├── sessionstore.js   # file-based session store (shared by cluster workers)
│   ├── querylog.js       # query log & analytics
│   └── system.js         # update & restart (git, npm, pm2)
│
├── public/
│   ├── index.html
│   └── login.html
│
├── data/
│   ├── connections.json
│   ├── queries.json
│   ├── users.json
│   ├── query_log.jsonl
│   └── sessions/
│
└── ...
```

The exact structure may evolve as the project grows.

---

# Design Principles

DB Console follows a few simple principles.

### Lightweight

Avoid unnecessary infrastructure and dependencies.

### Portable

The application should be easy to copy and deploy to another server.

### Self-hosted

Database access stays within the environment where DB Console is deployed.

### Practical

Focus on the database operations that support engineers and administrators perform most frequently.

### Stream large data

Avoid loading large tables, exports, backups, or restores entirely into memory.

### Simple UI

Common database operations should be possible without writing SQL.

### Extensible

The application should remain easy to extend with additional database and administration capabilities.

---

# Roadmap

The project is intentionally small, but potential future improvements include:

### Security

* [ ] Encrypted database credentials
* [x] Role-based access control
* [x] Multiple application users
* [x] Password hashing
* [ ] MFA / 2FA
* [x] Audit logging
* [x] Login rate limiting
* [ ] Configurable session expiration
* [ ] Secret-manager integrations

### Database Management

* [ ] PostgreSQL support
* [ ] SQLite support
* [ ] Additional database engines
* [ ] Database health information
* [ ] Process list
* [ ] Active query monitoring
* [ ] Index recommendations
* [ ] Query execution statistics
* [ ] Table size information
* [ ] Database size reporting

### Querying

* [ ] SQL editor improvements
* [ ] Syntax highlighting
* [ ] SQL autocomplete
* [x] Query history
* [ ] Query execution plan
* [ ] Explain visualisation
* [ ] Query cancellation
* [ ] Query templates

### Backup

* [ ] Routine backup support
* [ ] Trigger backup support
* [ ] Event backup support
* [ ] Procedure/function backup support
* [ ] Incremental backup options
* [ ] Scheduled backups

### Operations

* [ ] Docker image
* [ ] Docker Compose deployment
* [ ] Health-check endpoint
* [ ] Read-only mode
* [ ] Environment-based configuration
* [ ] Kubernetes deployment
* [ ] Single-binary/package distribution

---

# Docker

A Docker image can make DB Console particularly useful for client and support environments.

Example deployment:

```bash
docker run \
  -p 3000:3000 \
  -v ./data:/app/data \
  db-console
```

> Docker support may evolve as the project matures.

---

# Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
node server.js
```

For development, you can use a Node.js process manager such as:

```bash
npm install -g nodemon
nodemon server.js
```

---

# Contributing

Contributions are welcome.

If you would like to contribute:

1. Fork the repository
2. Create a feature branch

```bash
git checkout -b feature/my-feature
```

3. Make your changes
4. Test the application
5. Commit your changes

```bash
git commit -m "Add my feature"
```

6. Push the branch

```bash
git push origin feature/my-feature
```

7. Open a Pull Request

For larger changes, opening an issue first is recommended so the design can be discussed before implementation.

---

# Security Issues

Please **do not open a public GitHub issue for security vulnerabilities**.

If you discover a security issue, report it privately to the project maintainers so it can be investigated and addressed responsibly.

---

# License

This project is open source.

See the [`LICENSE`](LICENSE) file for the applicable license and terms.

---

# Disclaimer

DB Console is an administrative database management tool.

It provides the ability to execute SQL and modify database contents. Incorrect use can result in data loss, corruption, or service disruption.

Always maintain appropriate database backups and use appropriate database privileges for the environment in which DB Console is deployed.

---

## Project Status

DB Console is an actively evolving lightweight database administration project.

The goal is not to replace enterprise database management platforms.

Instead, DB Console aims to provide something deliberately simpler:

> **A small, portable database console that you can deploy almost anywhere.**

If you need a database administration interface on a small server, inside a customer environment, or next to an application for support and troubleshooting, DB Console is designed for that job.
