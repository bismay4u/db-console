// server.js
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const store = require('./store');
const db = require('./db');
const querylog = require('./querylog');
const system = require('./system');

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
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 4 // 4 hours
    }
  })
);

// --- Current user ---
// Re-read on every request so that deleting or disabling a user, changing
// their role, or resetting their password takes effect immediately.
app.use((req, res, next) => {
  req.user = null;
  const s = req.session;
  if (s && s.authenticated && s.username) {
    const user = store.getUser(s.username);
    if (user && !user.disabled && (user.sessionVersion || 1) === s.sessionVersion) {
      req.user = user;
    } else {
      s.authenticated = false;
      s.username = null;
    }
  }
  next();
});

// --- Auth helpers ---
function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  return next();
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt
  };
}

// --- Connection access ---
// Owner and admins manage a connection (edit, delete, share). Anyone it is
// shared with may use it (run queries, explore, export, back up, restore).
function canManage(user, conn) {
  return isAdmin(user) || conn.owner === user.username;
}

function canUse(user, conn) {
  const shared = conn.sharedWith || [];
  return canManage(user, conn) || shared.includes('*') || shared.includes(user.username);
}

function connView(conn, user) {
  const { password, sharedWith, ...rest } = conn;
  const manage = canManage(user, conn);
  const shared = sharedWith || [];
  return {
    ...rest,
    hasPassword: Boolean(password),
    canManage: manage,
    sharedWith: manage ? shared : undefined,
    isShared: shared.length > 0,
    sharedWithMe: conn.owner !== user.username && (shared.includes('*') || shared.includes(user.username))
  };
}

// The browser never receives stored passwords, so when a form leaves the
// password blank (editing, or cloning an existing connection) it sends
// `passwordFrom` = the key of the connection whose password to reuse. Only
// a connection the user manages may lend its password: otherwise a user it
// is merely shared with could point a clone at a server they control and
// capture the password.
function resolvePassword(password, passwordFrom, user) {
  if (password) return password;
  if (passwordFrom) {
    const source = store.getConnection(passwordFrom);
    if (source && canManage(user, source)) return source.password || '';
  }
  return '';
}

// Every route with a :key parameter refers to a connection the current user
// must be allowed to use; it is loaded once here as req.conn.
app.param('key', (req, res, next, key) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const conn = store.getConnection(key);
  if (!conn || !canUse(req.user, conn)) return res.status(404).json({ error: 'Connection not found' });
  req.conn = conn;
  return next();
});

function requireManage(req, res, next) {
  if (!canManage(req.user, req.conn)) {
    return res.status(403).json({ error: 'Only the owner or an admin can change this connection' });
  }
  return next();
}

// Records an action against req.conn in the query log.
function logAction(req, entry) {
  querylog.record({
    username: req.user.username,
    connKey: req.conn ? req.conn.key : null,
    connLabel: req.conn ? req.conn.label : null,
    database: req.params.database || (req.conn ? req.conn.database : null),
    ...entry
  });
}

function qualified(req) {
  const { database, table } = req.params;
  return table ? `\`${database}\`.\`${table}\`` : `\`${database}\``;
}

// --- Auth routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.getUser(String(username || ''));
  // Always verify (against a dummy hash for unknown users) so response
  // time doesn't reveal which usernames exist.
  const valid = store.verifyPassword(password, user ? user.passwordHash : null);
  if (!user || !valid || user.disabled) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.authenticated = true;
    req.session.username = user.username;
    req.session.sessionVersion = user.sessionVersion || 1;
    store.touchLastLogin(user.username);
    return res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  if (!req.user) return res.json({ authenticated: false, username: null });
  res.json({
    authenticated: true,
    username: req.user.username,
    displayName: req.user.displayName,
    role: req.user.role
  });
});

// --- Own account ---
app.post('/api/account/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifyPassword(currentPassword, req.user.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const updated = store.updateUser(req.user.username, { password: newPassword });
  // Other sessions of this user are ended; keep this one signed in.
  req.session.sessionVersion = updated.sessionVersion;
  res.json({ ok: true });
});

// Minimal list of active users, for picking who to share a connection with.
app.get('/api/users/directory', requireAuth, (req, res) => {
  res.json(
    store.listUsers()
      .filter((u) => !u.disabled)
      .map((u) => ({ username: u.username, displayName: u.displayName }))
  );
});

// --- User management (admin) ---
function enabledAdminCount(users) {
  return users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

app.get('/api/users', requireAdmin, (req, res) => {
  const conns = store.listConnections();
  res.json(
    store.listUsers().map((u) => ({
      ...publicUser(u),
      connectionCount: conns.filter((c) => c.owner === u.username).length
    }))
  );
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  const error = store.validateNewUser({ username, password });
  if (error) return res.status(400).json({ error });
  if (role && !store.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const user = store.createUser({ username, password, role, displayName });
  res.status(201).json(publicUser(user));
});

app.put('/api/users/:username', requireAdmin, (req, res) => {
  const target = store.getUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { displayName, role, disabled, password } = req.body || {};
  if (role !== undefined && !store.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password && String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Never leave the app without an enabled admin.
  const losesAdmin = target.role === 'admin' && !target.disabled &&
    ((role !== undefined && role !== 'admin') || disabled === true);
  if (losesAdmin && enabledAdminCount(store.listUsers()) <= 1) {
    return res.status(400).json({ error: 'There must be at least one enabled admin' });
  }

  const updated = store.updateUser(target.username, { displayName, role, disabled, password });
  if (target.username === req.user.username && updated.sessionVersion !== target.sessionVersion &&
      !updated.disabled && updated.role === 'admin') {
    // An admin changing their own password stays signed in here.
    req.session.sessionVersion = updated.sessionVersion;
  }
  res.json(publicUser(updated));
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const target = store.getUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.username === req.user.username) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if (target.role === 'admin' && !target.disabled && enabledAdminCount(store.listUsers()) <= 1) {
    return res.status(400).json({ error: 'There must be at least one enabled admin' });
  }
  // Their connections and saved queries move to the admin deleting them.
  store.deleteUser(target.username, req.user.username);
  res.json({ ok: true, transferredTo: req.user.username });
});

// --- Connections CRUD ---
app.get('/api/connections', requireAuth, (req, res) => {
  res.json(
    store.listConnections()
      .filter((c) => canUse(req.user, c))
      .map((c) => connView(c, req.user))
  );
});

app.post('/api/connections', requireAuth, async (req, res) => {
  const { label, host, port, user, password, database, passwordFrom } = req.body || {};
  if (!label || !host || !user || !database) {
    return res.status(400).json({ error: 'label, host, user and database are required' });
  }
  const conn = store.createConnection({
    label, host, port, user, database,
    password: resolvePassword(password, passwordFrom, req.user),
    owner: req.user.username
  });
  res.status(201).json(connView(conn, req.user));
});

app.put('/api/connections/:key', requireAuth, requireManage, (req, res) => {
  const { label, host, port, user, password, database } = req.body || {};
  const updated = store.updateConnection(req.params.key, { label, host, port, user, password, database });
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key); // force pool rebuild with new settings
  res.json(connView(updated, req.user));
});

// Replace who a connection is shared with: { sharedWith: ['alice', 'bob'] }
// or { sharedWith: ['*'] } for every user.
app.put('/api/connections/:key/sharing', requireAuth, requireManage, (req, res) => {
  const { sharedWith } = req.body || {};
  if (!Array.isArray(sharedWith)) return res.status(400).json({ error: 'sharedWith must be an array' });
  const updated = store.setConnectionSharing(req.params.key, sharedWith);
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  res.json(connView(updated, req.user));
});

app.delete('/api/connections/:key', requireAuth, requireManage, (req, res) => {
  const removed = store.deleteConnection(req.params.key);
  if (!removed) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key);
  res.json({ ok: true });
});

// Test a connection's current saved settings
app.post('/api/connections/:key/test', requireAuth, async (req, res) => {
  const result = await db.testConnection(req.conn);
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
    password: resolvePassword(password, passwordFrom, req.user),
    database
  });
  res.json(result);
});

// --- Saved queries CRUD (private to each user) ---
app.get('/api/queries', requireAuth, (req, res) => {
  res.json(store.listQueries(req.user.username));
});

app.post('/api/queries', requireAuth, (req, res) => {
  const { name, sql } = req.body || {};
  if (!name || !sql) {
    return res.status(400).json({ error: 'name and sql are required' });
  }
  res.status(201).json(store.createQuery({ name, sql, owner: req.user.username }));
});

app.put('/api/queries/:id', requireAuth, (req, res) => {
  const { name, sql } = req.body || {};
  const updated = store.updateQuery(req.params.id, { name, sql }, req.user.username);
  if (!updated) return res.status(404).json({ error: 'Query not found' });
  res.json(updated);
});

app.delete('/api/queries/:id', requireAuth, (req, res) => {
  const removed = store.deleteQuery(req.params.id, req.user.username);
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

// Row edits are logged as a readable summary (not the exact SQL, which is
// built with placeholders in db.js).
async function loggedRowAction(req, res, { sql, type, status = 200, run }) {
  const start = Date.now();
  try {
    const result = await run();
    logAction(req, { source: 'explore', sql, type, ok: true, durationMs: Date.now() - start, affectedRows: result.affectedRows });
    res.status(status).json(result);
  } catch (err) {
    logAction(req, { source: 'explore', sql, type, ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message });
  }
}

app.put('/api/explore/:key/:database/:table/rows', requireAuth, (req, res) => {
  const { where, changes } = req.body || {};
  return loggedRowAction(req, res, {
    sql: `UPDATE ${qualified(req)} SET ${Object.keys(changes || {}).join(', ')} WHERE ${JSON.stringify(where)}`,
    type: 'UPDATE',
    run: () => db.updateRow(req.params.key, req.params.database, req.params.table, where, changes)
  });
});

app.post('/api/explore/:key/:database/:table/rows', requireAuth, (req, res) => {
  const { values } = req.body || {};
  return loggedRowAction(req, res, {
    sql: `INSERT INTO ${qualified(req)} (${Object.keys(values || {}).join(', ')})`,
    type: 'INSERT',
    status: 201,
    run: () => db.insertRow(req.params.key, req.params.database, req.params.table, values)
  });
});

app.delete('/api/explore/:key/:database/:table/rows', requireAuth, (req, res) => {
  const { where } = req.body || {};
  return loggedRowAction(req, res, {
    sql: `DELETE FROM ${qualified(req)} WHERE ${JSON.stringify(where)}`,
    type: 'DELETE',
    run: () => db.deleteRow(req.params.key, req.params.database, req.params.table, where)
  });
});

// --- CSV export of a full table (streamed; safe for large tables) ---
app.get('/api/explore/:key/:database/:table/export.csv', requireAuth, async (req, res) => {
  const { table } = req.params;
  const { sortCol, sortDir } = req.query;
  const start = Date.now();
  const entry = { source: 'export', sql: `EXPORT CSV ${qualified(req)}`, type: 'SELECT' };
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    await db.streamTableCsv(req.params.key, req.params.database, table, res, { sortCol, sortDir });
    res.end();
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start });
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
    // Headers may already be sent once streaming starts; end the response either way.
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- CSV import: insert one already-parsed batch of rows into a table ---
// The frontend streams+batches the CSV file client-side, so large files
// never arrive here as one giant payload. Each batch is one log entry.
app.post('/api/explore/:key/:database/:table/import', requireAuth, async (req, res) => {
  const { columns, rows, truncate } = req.body || {};
  const start = Date.now();
  const entry = {
    source: 'import',
    sql: `${truncate ? `TRUNCATE ${qualified(req)}; ` : ''}IMPORT ${Array.isArray(rows) ? rows.length : 0} row(s) INTO ${qualified(req)}`,
    type: 'INSERT'
  };
  try {
    if (truncate) {
      await db.truncateTable(req.params.key, req.params.database, req.params.table);
    }
    const result = await db.insertRowsBulk(req.params.key, req.params.database, req.params.table, columns, rows);
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start, affectedRows: result.affectedRows });
    res.json(result);
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message });
  }
});

// --- Backup: stream a full database dump as a single-file tar.gz ---
app.get('/api/explore/:key/:database/backup.tar.gz', requireAuth, async (req, res) => {
  const { database } = req.params;
  const start = Date.now();
  const entry = { source: 'backup', sql: `BACKUP ${qualified(req)}`, type: 'OTHER' };
  try {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${database}-backup.tar.gz"`);
    await db.streamDatabaseBackupTarGz(req.params.key, database, res);
    res.end();
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start });
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
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
  const start = Date.now();
  const entry = { source: 'restore', sql: `RESTORE ${qualified(req)} FROM .${format === 'targz' ? 'tar.gz' : 'sql'} file`, type: 'OTHER' };
  res.setHeader('Content-Type', 'application/x-ndjson');
  try {
    const result = await db.restoreDump(key, database, req, format, (progress) => {
      res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
    });
    logAction(req, {
      ...entry,
      ok: result.failed === 0,
      error: result.failed ? `${result.failed} statement(s) failed` : null,
      statementCount: result.executed,
      durationMs: Date.now() - start
    });
    res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
    res.end();
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
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

  const conns = dbKeys.map((key) => store.getConnection(key));
  const denied = dbKeys.filter((key, i) => !conns[i] || !canUse(req.user, conns[i]));
  if (denied.length) {
    return res.status(403).json({ error: `No access to connection(s): ${denied.join(', ')}` });
  }

  const results = await Promise.all(
    dbKeys.map(async (key, i) => {
      let result;
      try {
        const { ok, statements } = await db.runQuery(key, sql);
        result = { key, ok, statements };
      } catch (err) {
        result = { key, ok: false, statements: [{ sql, ok: false, error: err.message }] };
      }

      // One log entry per connection per run. Statement types come from the
      // submitted SQL, since a failed connection returns no per-statement results.
      const stmts = result.statements;
      const failed = stmts.find((s) => !s.ok);
      const submitted = db.splitStatements(sql);
      const types = [...new Set(submitted.map((s) => querylog.statementType(s)))];
      querylog.record({
        username: req.user.username,
        source: 'runner',
        connKey: key,
        connLabel: conns[i].label,
        database: conns[i].database,
        sql,
        type: types.length === 0 ? 'OTHER' : (types.length === 1 ? types[0] : 'MULTI'),
        statementCount: submitted.length,
        ok: result.ok,
        error: failed ? failed.error : null,
        durationMs: stmts.reduce((acc, s) => acc + (s.durationMs || 0), 0),
        rowCount: stmts.some((s) => s.type === 'rows') ? stmts.reduce((acc, s) => acc + (s.rowCount || 0), 0) : null,
        affectedRows: stmts.some((s) => s.type === 'result') ? stmts.reduce((acc, s) => acc + (s.affectedRows || 0), 0) : null
      });
      return result;
    })
  );

  res.json({ results });
});

// --- Query log & analytics ---
// Users see their own activity; admins see everyone's (optionally one user).
function logFilters(req) {
  const { user, conn, source, type, status, q, from, to } = req.query;
  return {
    username: isAdmin(req.user) ? (user || undefined) : req.user.username,
    connKey: conn || undefined,
    source: source || undefined,
    type: type || undefined,
    status: status || undefined,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined
  };
}

app.get('/api/logs', requireAuth, (req, res) => {
  res.json(querylog.query(logFilters(req), { limit: req.query.limit, offset: req.query.offset }));
});

app.get('/api/analytics', requireAuth, (req, res) => {
  const { from, to, ...filters } = logFilters(req);
  res.json(querylog.analytics(filters, req.query.days));
});

// --- System: update & restart (admin) ---
app.get('/api/system/status', requireAdmin, async (req, res) => {
  res.json(await system.getStatus());
});

app.post('/api/system/check', requireAdmin, async (req, res) => {
  res.json(await system.checkForUpdates());
});

// Streams progress as newline-delimited JSON, like restore.
app.post('/api/system/update', requireAdmin, async (req, res) => {
  const restart = !(req.body && req.body.restart === false);
  res.setHeader('Content-Type', 'application/x-ndjson');
  const emit = (evt) => res.write(JSON.stringify(evt) + '\n');
  try {
    const result = await system.update({ restart }, emit);
    querylog.record({
      username: req.user.username,
      source: 'system',
      sql: result.updated ? `UPDATE APP ${result.from.slice(0, 7)} -> ${result.to.slice(0, 7)}` : 'UPDATE APP (already up to date)',
      type: 'OTHER',
      ok: true
    });
  } catch (err) {
    querylog.record({ username: req.user.username, source: 'system', sql: 'UPDATE APP', type: 'OTHER', ok: false, error: err.message });
    emit({ type: 'error', error: err.message });
  }
  res.end();
});

app.post('/api/system/restart', requireAdmin, (req, res) => {
  if (!system.pm2Info().managed) {
    return res.status(400).json({ error: 'The app is not running under PM2, so it cannot restart itself' });
  }
  querylog.record({ username: req.user.username, source: 'system', sql: 'RESTART APP', type: 'OTHER', ok: true });
  system.scheduleRestart();
  res.json({ ok: true, restarting: true });
});

// --- Page routes ---
app.get('/', (req, res) => {
  if (req.user) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/');
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- Start server ---
store.ensureStore();
app.listen(PORT, () => {
  console.log(`DB Console running at http://localhost:${PORT}`);
  const admins = store.listUsers().filter((u) => u.role === 'admin').map((u) => u.username);
  console.log(`Admin account(s): ${admins.join(', ')}`);
});
