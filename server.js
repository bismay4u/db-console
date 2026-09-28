// server.js
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const store = require('./store');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 4 // 4 hours
    }
  })
);

// --- Auth helpers ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// The browser never receives stored passwords, so when a form leaves the
// password blank (editing, or cloning an existing connection) it sends
// `passwordFrom` = the key of the connection whose password to reuse.
function resolvePassword(password, passwordFrom) {
  if (password) return password;
  if (passwordFrom) {
    const source = store.getConnection(passwordFrom);
    if (source) return source.password || '';
  }
  return '';
}

function stripPassword(conn) {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: Boolean(password) };
}

// --- Auth routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (
    username === config.appAuth.username &&
    password === config.appAuth.password
  ) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session && req.session.authenticated),
    username: req.session ? req.session.username : null
  });
});

// --- Connections CRUD (all require auth) ---
app.get('/api/connections', requireAuth, (req, res) => {
  res.json(store.listConnections().map(stripPassword));
});

app.post('/api/connections', requireAuth, async (req, res) => {
  const { label, host, port, user, password, database, passwordFrom } = req.body || {};
  if (!label || !host || !user || !database) {
    return res.status(400).json({ error: 'label, host, user and database are required' });
  }
  const conn = store.createConnection({
    label, host, port, user, database,
    password: resolvePassword(password, passwordFrom)
  });
  res.status(201).json(stripPassword(conn));
});

app.put('/api/connections/:key', requireAuth, (req, res) => {
  const updated = store.updateConnection(req.params.key, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key); // force pool rebuild with new settings
  res.json(stripPassword(updated));
});

app.delete('/api/connections/:key', requireAuth, (req, res) => {
  const removed = store.deleteConnection(req.params.key);
  if (!removed) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key);
  res.json({ ok: true });
});

// Test a connection's current saved settings
app.post('/api/connections/:key/test', requireAuth, async (req, res) => {
  const conn = store.getConnection(req.params.key);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const result = await db.testConnection(conn);
  res.json(result);
});

// Test connection settings from an unsaved form (label optional)
app.post('/api/connections/test', requireAuth, async (req, res) => {
  const { host, port, user, password, database, passwordFrom } = req.body || {};
  if (!host || !user || !database) {
    return res.status(400).json({ error: 'host, user and database are required' });
  }
  const result = await db.testConnection({
    host,
    port: Number(port) || 3306,
    user,
    password: resolvePassword(password, passwordFrom),
    database
  });
  res.json(result);
});

// --- Saved queries CRUD ---
app.get('/api/queries', requireAuth, (req, res) => {
  res.json(store.listQueries());
});

app.post('/api/queries', requireAuth, (req, res) => {
  const { name, sql } = req.body || {};
  if (!name || !sql) {
    return res.status(400).json({ error: 'name and sql are required' });
  }
  res.status(201).json(store.createQuery({ name, sql }));
});

app.put('/api/queries/:id', requireAuth, (req, res) => {
  const updated = store.updateQuery(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Query not found' });
  res.json(updated);
});

app.delete('/api/queries/:id', requireAuth, (req, res) => {
  const removed = store.deleteQuery(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Query not found' });
  res.json({ ok: true });
});

// --- Explore: click-driven database/table/data browsing (Adminer-style) ---
app.get('/api/explore/:key/databases', requireAuth, async (req, res) => {
  try {
    res.json(await db.listDatabases(req.params.key));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/objects', requireAuth, async (req, res) => {
  try {
    res.json(await db.listObjects(req.params.key, req.params.database));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/definition/:kind/:name', requireAuth, async (req, res) => {
  try {
    const { key, database, kind, name } = req.params;
    res.json(await db.getObjectDefinition(key, database, kind, name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/:table/indexes', requireAuth, async (req, res) => {
  try {
    res.json(await db.getTableIndexes(req.params.key, req.params.database, req.params.table));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/tables', requireAuth, async (req, res) => {
  try {
    res.json(await db.listTables(req.params.key, req.params.database));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/:table/columns', requireAuth, async (req, res) => {
  try {
    res.json(await db.getTableColumns(req.params.key, req.params.database, req.params.table));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/:key/:database/:table/rows', requireAuth, async (req, res) => {
  try {
    const { page, pageSize, sortCol, sortDir } = req.query;
    const data = await db.browseTable(req.params.key, req.params.database, req.params.table, {
      page,
      pageSize,
      sortCol,
      sortDir
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/explore/:key/:database/:table/rows', requireAuth, async (req, res) => {
  try {
    const { where, changes } = req.body || {};
    const result = await db.updateRow(req.params.key, req.params.database, req.params.table, where, changes);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/explore/:key/:database/:table/rows', requireAuth, async (req, res) => {
  try {
    const { values } = req.body || {};
    const result = await db.insertRow(req.params.key, req.params.database, req.params.table, values);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/explore/:key/:database/:table/rows', requireAuth, async (req, res) => {
  try {
    const { where } = req.body || {};
    const result = await db.deleteRow(req.params.key, req.params.database, req.params.table, where);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- CSV export of a full table (streamed; safe for large tables) ---
app.get('/api/explore/:key/:database/:table/export.csv', requireAuth, async (req, res) => {
  const { table } = req.params;
  const { sortCol, sortDir } = req.query;
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    await db.streamTableCsv(req.params.key, req.params.database, table, res, { sortCol, sortDir });
    res.end();
  } catch (err) {
    // Headers may already be sent once streaming starts; end the response either way.
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- CSV import: insert one already-parsed batch of rows into a table ---
// The frontend streams+batches the CSV file client-side, so large files
// never arrive here as one giant payload.
app.post('/api/explore/:key/:database/:table/import', requireAuth, async (req, res) => {
  try {
    const { columns, rows, truncate } = req.body || {};
    if (truncate) {
      await db.truncateTable(req.params.key, req.params.database, req.params.table);
    }
    const result = await db.insertRowsBulk(req.params.key, req.params.database, req.params.table, columns, rows);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Backup: stream a full database dump as a single-file tar.gz ---
app.get('/api/explore/:key/:database/backup.tar.gz', requireAuth, async (req, res) => {
  const { database } = req.params;
  try {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${database}-backup.tar.gz"`);
    await db.streamDatabaseBackupTarGz(req.params.key, database, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- Restore: execute an uploaded dump against a database ---
// Accepts either a plain .sql file or a .tar.gz (as produced by the Backup
// button above) via ?format=sql|targz. The request body is the raw file
// content (not JSON), read as a stream so a very large dump is never
// buffered whole. Progress is streamed back as newline-delimited JSON so
// the UI can show live progress.
app.post('/api/explore/:key/:database/restore', requireAuth, async (req, res) => {
  const { key, database } = req.params;
  const format = req.query.format === 'targz' ? 'targz' : 'sql';
  res.setHeader('Content-Type', 'application/x-ndjson');
  try {
    const result = await db.restoreDump(key, database, req, format, (progress) => {
      res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
    });
    res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
    res.end();
  } catch (err) {
    res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
    res.end();
  }
});

// --- Run a SQL command against one or more connections ---
app.post('/api/query', requireAuth, async (req, res) => {
  const { dbKeys, sql } = req.body || {};

  if (!Array.isArray(dbKeys) || dbKeys.length === 0) {
    return res.status(400).json({ error: 'dbKeys must be a non-empty array' });
  }
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'sql must be a non-empty string' });
  }

  const results = await Promise.all(
    dbKeys.map(async (key) => {
      try {
        const { ok, statements } = await db.runQuery(key, sql);
        return { key, ok, statements };
      } catch (err) {
        return { key, ok: false, statements: [{ sql, ok: false, error: err.message }] };
      }
    })
  );

  res.json({ results });
});

// --- Page routes ---
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- Start server ---
store.ensureStore();
app.listen(PORT, () => {
  console.log(`Multi-DB client running at http://localhost:${PORT}`);
  console.log(`Login with username: ${config.appAuth.username}`);
});
