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

* Browse all databases on a connection
* Browse tables and views
* View table data
* Pagination
* Column sorting
* View table structure
* View columns, types and keys
* View indexes
* View table DDL
* View `SHOW CREATE` definitions
* Add rows
* Edit rows
* Delete rows
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

* Created
* Edited
* Deleted
* Loaded directly into Query Runner

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
    APP_USER: "admin",
    APP_PASS: "change-me",
    SESSION_SECRET: "replace-with-a-long-random-secret"
};
```

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
├── connections.json
└── queries.json
```

are used for persistent application data.

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
```

---

## Saved Queries

```http
GET    /api/queries
POST   /api/queries
PUT    /api/queries/:id
DELETE /api/queries/:id
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
```

Modify rows:

```http
POST   /api/explore/:key/:database/:table/rows
PUT    /api/explore/:key/:database/:table/rows
DELETE /api/explore/:key/:database/:table/rows
```

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

Always replace the default session secret with a strong random value.

Example:

```bash
openssl rand -hex 32
```

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
├── server.js
├── config.js
├── db.js
├── package.json
│
├── public/
│   ├── index.html
│   ├── css/
│   └── js/
│
├── data/
│   ├── connections.json
│   └── queries.json
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
* [ ] Role-based access control
* [ ] Multiple application users
* [ ] Password hashing
* [ ] MFA / 2FA
* [ ] Audit logging
* [ ] Login rate limiting
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
* [ ] Query history
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
