// server.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./api/appconfig');
const store = require('./api/store');
const db = require('./api/db');
const querylog = require('./api/querylog');
const params = require('./api/params');
const jobs = require('./api/jobs');
const scheduler = require('./api/scheduler');
const notify = require('./api/notify');
const cron = require('./api/cron');
const system = require('./api/system');
const schema = require('./api/schema');
const serverAdmin = require('./api/serveradmin');
const importer = require('./api/importer');
const perms = require('./api/permissions');
const analyzer = require('./api/analyzer');
const runs = require('./api/runs');
const netguard = require('./api/netguard');
const authlog = require('./api/authlog');
const FileSessionStore = require('./api/sessionstore');
const { DATA_DIR, readJson, writeJson, withLock } = require('./api/datadir');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_ADMIN_PASSWORD = 'admin123!';
const DEFAULT_SESSION_SECRET = 'replace-this-with-a-random-string';

// Behind a reverse proxy (nginx, a load balancer...) set TRUST_PROXY=1 (or
// `trustProxy` in config.js) so req.ip and HTTPS detection use the
// X-Forwarded-* headers.
const trustProxy = process.env.TRUST_PROXY ?? config.trustProxy;
if (trustProxy) app.set('trust proxy', trustProxy === 'true' || trustProxy === '1' ? 1 : trustProxy);

// IP allow-list (ALLOWED_IPS or `allowedIps` in config.js): everyone else gets 403.
const ipGuard = netguard.create(process.env.ALLOWED_IPS || config.allowedIps || []);
if (ipGuard.active) {
  app.use((req, res, next) => {
    if (ipGuard.allows(req.ip) || req.path === '/health') return next();
    authlog.record({ event: 'ip_blocked', ip: req.ip, detail: `${req.method} ${req.path}`.slice(0, 120), agent: req.get('user-agent') });
    return res.status(403).type('text/plain').send('Access from your address is not allowed.');
  });
}

// Liveness / readiness probe for Docker, load balancers and uptime monitors.
// No sign-in needed and no session is created; it fails (503) when the data
// directory isn't writable, which means the app can't work.
app.get('/health', (req, res) => {
  let ok = true;
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); } catch (e) { ok = false; }
  res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ status: ok ? 'ok' : 'unavailable', uptime: Math.round(process.uptime()), version: require('./package.json').version });
});

// Sessions: SESSION_MINUTES (or `sessionMinutes`) is how long a sign-in lasts at most (default 240);
// IDLE_MINUTES (or `idleMinutes`) signs out after that long without activity (default: off).
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || config.sessionMinutes) || 240;
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || config.idleMinutes) || 0;

// Large enough for long SQL in the Query Runner and big bulk edits. File
// uploads (import, restore) are streamed as raw bodies and don't go through
// this parser.
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions are stored as files in the data directory, so every PM2 cluster
// worker sees the same sessions and a restart doesn't sign anyone out.
app.use(
  session({
    store: new FileSessionStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // Secure flag whenever the request came in over HTTPS
      maxAge: 1000 * 60 * SESSION_MINUTES
    }
  })
);

// Idle timeout: a session unused for IDLE_MINUTES is ended.
app.use((req, res, next) => {
  const s = req.session;
  if (IDLE_MINUTES && s && s.authenticated) {
    const now = Date.now();
    if (s.lastSeen && now - s.lastSeen > IDLE_MINUTES * 60000) {
      return s.destroy(() => next());
    }
    if (!s.lastSeen || now - s.lastSeen > 30000) s.lastSeen = now; // not on every request: that would rewrite the session file each time
  }
  return next();
});

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

const { isAdmin, canManage, permissionsOf, restrictionsFor, canUse } = require('./api/access');

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
// shared with may use it (run queries, explore, export, back up, restore),
// or, when it is shared read-only, only read through it.
function connView(conn, user) {
  const { sharedWith, secretError, ...rest } = conn;
  const hasSecrets = Object.fromEntries(store.SECRET_FIELDS.map((f) => [f, Boolean(conn[f])]));
  for (const f of store.SECRET_FIELDS) delete rest[f];
  const manage = canManage(user, conn);
  const shared = sharedWith || [];
  return {
    ...rest,
    hasPassword: hasSecrets.password,
    hasSshPassword: hasSecrets.sshPassword, hasSshPrivateKey: hasSecrets.sshPrivateKey, hasSshPassphrase: hasSecrets.sshPassphrase, hasSslKey: hasSecrets.sslKey,
    secretError: secretError || undefined,
    canManage: manage,
    sharedWith: manage ? shared : undefined,
    permissions: permissionsOf(user, conn),
    canWrite: permissionsOf(user, conn).length > 0,
    sharePermissions: manage ? (conn.sharePermissions || undefined) : undefined,
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

// The connection form's network options (TLS, SSH tunnel). Secrets left blank
// are copied from `passwordFrom` when the user manages that connection.
function networkFromBody(body, passwordFrom, user) {
  const out = {};
  for (const f of store.NETWORK_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  const source = passwordFrom ? store.getConnection(passwordFrom) : null;
  if (source && canManage(user, source)) {
    for (const f of store.SECRET_FIELDS) if (f !== 'password' && !out[f] && source[f] && !(f.startsWith('ssh') && body.sshHost === '')) out[f] = source[f];
  }
  return out;
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

// Every Explore request that is not a GET changes something (rows, schema,
// objects, imports, restores); each needs the matching permission.
app.use('/api/explore/:key', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.user) return next();
  const conn = store.getConnection(req.params.key);
  if (!conn || !canUse(req.user, conn)) return next(); // the :key handler answers
  const segments = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  const needs = perms.exploreRequirement(req.method, segments, req.body || {}, req.query || {});
  const has = new Set(permissionsOf(req.user, conn));
  const missing = needs.filter((p) => !has.has(p));
  if (missing.length) {
    const what = missing.map((p) => perms.LABELS[p]).join(', ');
    return res.status(403).json({
      error: has.size ? `You don't have permission for this on this connection (needs: ${what})` : 'This connection is shared with you read-only'
    });
  }
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

// Safe Content-Disposition for a download named after a table/database.
function attachment(res, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

// --- Login rate limiting ---
// Failed logins are counted per IP+username and per IP in a file in the
// data directory, so the limit holds across all PM2 cluster workers.
const ATTEMPTS_FILE = path.join(DATA_DIR, 'login_attempts.json');
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { user: 10, ip: 50 };

function attemptKeys(req, username) {
  return { user: `u|${req.ip}|${String(username || '').toLowerCase()}`, ip: `i|${req.ip}` };
}

// Seconds until the caller may try again, or 0 if not blocked.
function loginRetryAfter(req, username) {
  const all = readJson(ATTEMPTS_FILE, {});
  const keys = attemptKeys(req, username);
  let wait = 0;
  for (const [kind, key] of Object.entries(keys)) {
    const a = all[key];
    if (a && a.count >= LIMITS[kind] && Date.now() - a.first < ATTEMPT_WINDOW_MS) {
      wait = Math.max(wait, Math.ceil((a.first + ATTEMPT_WINDOW_MS - Date.now()) / 1000));
    }
  }
  return wait;
}

function recordLoginAttempt(req, username, ok) {
  withLock(() => {
    const all = readJson(ATTEMPTS_FILE, {});
    const now = Date.now();
    for (const [k, a] of Object.entries(all)) if (now - a.first >= ATTEMPT_WINDOW_MS) delete all[k];
    const keys = attemptKeys(req, username);
    if (ok) {
      delete all[keys.user];
    } else {
      for (const key of Object.values(keys)) {
        const a = all[key] || { count: 0, first: now };
        a.count++;
        all[key] = a;
      }
    }
    writeJson(ATTEMPTS_FILE, all);
  });
}

// --- Auth routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const who = { username: String(username || '').slice(0, 64), ip: req.ip, agent: req.get('user-agent') };
  const retryAfter = loginRetryAfter(req, username);
  if (retryAfter) {
    authlog.record({ ...who, event: 'login_locked', detail: `blocked for ${Math.ceil(retryAfter / 60)} more minute(s)` });
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
  }

  const user = store.getUser(String(username || ''));
  // Always verify (against a dummy hash for unknown users) so response
  // time doesn't reveal which usernames exist.
  const valid = store.verifyPassword(password, user ? user.passwordHash : null);
  if (!user || !valid || user.disabled) {
    authlog.record({ ...who, event: 'login_failed', detail: !user ? 'unknown user' : user.disabled ? 'account disabled' : 'wrong password' });
    recordLoginAttempt(req, username, false);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  recordLoginAttempt(req, username, true);
  authlog.record({ ...who, username: user.username, event: 'login_ok' });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.authenticated = true;
    req.session.username = user.username;
    req.session.sessionVersion = user.sessionVersion || 1;
    req.session.defaultPassword = password === DEFAULT_ADMIN_PASSWORD;
    store.touchLastLogin(user.username);
    return res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.user) authlog.record({ event: 'logout', username: req.user.username, ip: req.ip, agent: req.get('user-agent') });
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
    role: req.user.role,
    usingDefaultPassword: Boolean(req.session.defaultPassword)
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
  authlog.record({ event: 'password_changed', username: req.user.username, ip: req.ip, agent: req.get('user-agent') });
  // Other sessions of this user are ended; keep this one signed in.
  req.session.sessionVersion = updated.sessionVersion;
  req.session.defaultPassword = newPassword === DEFAULT_ADMIN_PASSWORD;
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
    owner: req.user.username,
    ...networkFromBody(req.body, passwordFrom, req.user)
  });
  res.status(201).json(connView(conn, req.user));
});

app.put('/api/connections/:key', requireAuth, requireManage, (req, res) => {
  const { label, host, port, user, password, database } = req.body || {};
  const updated = store.updateConnection(req.params.key, { label, host, port, user, password, database, ...networkFromBody(req.body || {}) });
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key); // force pool rebuild with new settings
  res.json(connView(updated, req.user));
});

// Replace who a connection is shared with: { sharedWith: ['alice', 'bob'] }
// or { sharedWith: ['*'] } for every user.
app.put('/api/connections/:key/sharing', requireAuth, requireManage, (req, res) => {
  const { sharedWith, permissions, readOnly } = req.body || {};
  if (!Array.isArray(sharedWith)) return res.status(400).json({ error: 'sharedWith must be an array' });
  const updated = store.setConnectionSharing(req.params.key, sharedWith, permissions, readOnly === undefined ? undefined : Boolean(readOnly));
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
// The permissions a connection can be shared with, and the presets.
app.get('/api/permissions', requireAuth, (req, res) => {
  res.json({ permissions: perms.PERMISSIONS, presets: perms.PRESETS });
});

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
    database,
    ...networkFromBody(req.body, passwordFrom, req.user)
  });
  res.json(result);
});

// --- Saved queries ---
// Each user sees their own saved queries plus those shared with them. Only
// the owner can edit, delete or share a query; others can load it or save
// their own copy.
function queryView(q, user) {
  const mine = q.owner === user.username;
  const shared = q.sharedWith || [];
  return {
    ...q,
    sharedWith: mine ? shared : undefined,
    canManage: mine,
    isShared: shared.length > 0,
    sharedWithMe: !mine
  };
}

app.get('/api/queries', requireAuth, (req, res) => {
  res.json(store.listVisibleQueries(req.user.username).map((q) => queryView(q, req.user)));
});

app.put('/api/queries/:id/sharing', requireAuth, (req, res) => {
  const { sharedWith } = req.body || {};
  if (!Array.isArray(sharedWith)) return res.status(400).json({ error: 'sharedWith must be an array' });
  const q = store.getQuery(req.params.id);
  if (!q || (q.owner !== req.user.username && !(q.sharedWith || []).includes('*') && !(q.sharedWith || []).includes(req.user.username))) {
    return res.status(404).json({ error: 'Query not found' });
  }
  if (q.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can share this query' });
  res.json(queryView(store.setQuerySharing(req.params.id, sharedWith, req.user.username), req.user));
});

app.post('/api/queries', requireAuth, (req, res) => {
  const { name, sql } = req.body || {};
  if (!name || !sql) {
    return res.status(400).json({ error: 'name and sql are required' });
  }
  res.status(201).json(queryView(store.createQuery({ name, sql, owner: req.user.username }), req.user));
});

app.put('/api/queries/:id', requireAuth, (req, res) => {
  const { name, sql } = req.body || {};
  const updated = store.updateQuery(req.params.id, { name, sql }, req.user.username);
  if (!updated) return res.status(404).json({ error: 'Query not found' });
  res.json(queryView(updated, req.user));
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

// ---- Schema editing (databases, tables, columns, foreign keys) ----
// Every endpoint accepts preview: true to return the SQL without running it.
// Changes are written to the query log as DDL.
function schemaRoute(handler, { logged = true } = {}) {
  return async (req, res) => {
    const start = Date.now();
    const body = req.body || {};
    try {
      const result = await handler(req, body);
      if (logged && !body.preview && result && result.sql) {
        logAction(req, { source: 'explore', sql: result.sql, type: 'DDL', ok: true, durationMs: Date.now() - start });
      }
      res.json(result);
    } catch (err) {
      if (logged && !body.preview) {
        logAction(req, { source: 'explore', sql: err.sql || `(${req.method} ${req.path})`, type: 'DDL', ok: false, error: err.message, durationMs: Date.now() - start });
      }
      res.status(400).json({ error: err.message });
    }
  };
}

// ---- Download the full result of a Query Runner statement ----
// The browser submits a plain form (so the file is streamed straight to disk
// by the download manager); the statement is run again on the server with no
// row limit. See db.exportQueryResult.
app.post('/api/query/export', requireAuth, express.urlencoded({ extended: false, limit: '2mb' }), async (req, res) => {
  const b = req.body || {};
  const conn = store.getConnection(b.key);
  if (!conn || !canUse(req.user, conn)) return res.status(404).json({ error: 'Connection not found' });
  const yes = (v) => v === '1' || v === 'true' || v === 'on';
  const options = {
    database: b.database || conn.database,
    format: b.format === 'tsv' ? 'tsv' : 'csv',
    gzip: yes(b.gzip), bom: yes(b.bom), stripLimit: yes(b.stripLimit),
    nulls: ['null', '\\N'].includes(b.nulls) ? b.nulls : 'empty',
    maxRows: Math.max(0, parseInt(b.maxRows, 10) || 0),
    allowed: restrictionsFor(req.user, conn)
  };
  const sql = String(b.sql || '');
  const start = Date.now();
  const entry = { username: req.user.username, source: 'export', connKey: conn.key, connLabel: conn.label, database: options.database, sql };
  try {
    const result = await db.exportQueryResult(conn.key, sql, options, res, (filename, contentType) => {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      attachment(res, filename);
    });
    querylog.record({ ...entry, type: querylog.statementType(sql), ok: true, rowCount: result.rows, durationMs: Date.now() - start });
  } catch (err) {
    querylog.record({ ...entry, type: querylog.statementType(sql), ok: false, error: err.message, durationMs: Date.now() - start });
    if (!res.headersSent) res.status(400).json({ error: err.message });
    else res.end();
  }
});

// ---- Database analysis (Explore → Analyze) ----
// Anyone with access to the connection can run it (it only reads); the rules
// are managed by admins.
app.get('/api/explore/:key/:database/analyze', requireAuth, async (req, res) => {
  const start = Date.now();
  const entry = { source: 'explore', sql: `ANALYZE DATABASE \`${req.params.database}\``, type: 'OTHER' };
  try {
    const result = await analyzer.analyze(req.params.key, req.params.database);
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start });
    res.json(result);
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/analyzer/rules', requireAuth, (req, res) => {
  res.json(analyzer.listRules({ includeSql: isAdmin(req.user) }));
});
app.post('/api/analyzer/rules', requireAdmin, (req, res) => {
  try { res.status(201).json(analyzer.saveCustom(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/analyzer/rules/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const rule = id.startsWith('custom-') ? analyzer.saveCustom(req.body || {}, id) : analyzer.updateBuiltin(id, req.body || {});
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    return res.json(rule);
  } catch (err) { return res.status(400).json({ error: err.message }); }
});
app.delete('/api/analyzer/rules/:id', requireAdmin, (req, res) => {
  if (!analyzer.deleteCustom(req.params.id)) return res.status(404).json({ error: 'Custom rule not found (built-in rules can only be switched off)' });
  return res.json({ ok: true });
});
// Try a rule that isn't saved yet against one database.
app.post('/api/analyzer/test', requireAdmin, async (req, res) => {
  const { key, database, rule } = req.body || {};
  const conn = store.getConnection(key);
  if (!conn || !canUse(req.user, conn)) return res.status(404).json({ error: 'Connection not found' });
  try { return res.json(await analyzer.testRule(key, database || conn.database, rule || {})); } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.get('/api/explore/:key/meta', requireAuth, schemaRoute((req) => schema.getServerMeta(req.params.key), { logged: false }));
app.post('/api/explore/:key/databases', requireAuth, schemaRoute((req, b) => schema.createDatabase(req.params.key, b)));
app.get('/api/explore/:key/:database/info', requireAuth, schemaRoute((req) => schema.getDatabaseInfo(req.params.key, req.params.database), { logged: false }));
app.put('/api/explore/:key/:database', requireAuth, schemaRoute((req, b) => schema.alterDatabase(req.params.key, req.params.database, b)));
app.delete('/api/explore/:key/:database', requireAuth, schemaRoute((req, b) => schema.dropDatabase(req.params.key, req.params.database, b)));
app.get('/api/explore/:key/:database/search', requireAuth, schemaRoute((req) => schema.searchDatabase(req.params.key, req.params.database, req.query.q), { logged: false }));
app.get('/api/explore/:key/:database/diagram', requireAuth, schemaRoute((req) => schema.getDiagram(req.params.key, req.params.database), { logged: false }));
app.get('/api/explore/:key/:database/foreign-keys', requireAuth, schemaRoute((req) => schema.getDatabaseForeignKeys(req.params.key, req.params.database), { logged: false }));
// Table and column names of a database, for SQL autocomplete: { table: [columns] }.
app.get('/api/explore/:key/:database/autocomplete', requireAuth, schemaRoute(async (req) => {
  const [rows] = await db.getPool(req.params.key).query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 20000`,
    [req.params.database]
  );
  const tables = {};
  for (const r of rows) (tables[r.t] = tables[r.t] || []).push(r.c);
  return { tables };
}, { logged: false }));
app.post('/api/explore/:key/:database/objects/save', requireAuth, schemaRoute((req, b) => schema.saveObject(req.params.key, req.params.database, b)));
app.post('/api/explore/:key/:database/objects/drop', requireAuth, schemaRoute((req, b) => schema.dropObject(req.params.key, req.params.database, b)));
app.post('/api/explore/:key/:database/tables', requireAuth, schemaRoute((req, b) => schema.createTable(req.params.key, req.params.database, b)));
app.post('/api/explore/:key/:database/table-actions', requireAuth, schemaRoute((req, b) => schema.tableAction(req.params.key, req.params.database, b)));
app.get('/api/explore/:key/:database/:table/schema', requireAuth, schemaRoute(async (req) => {
  const { key, database, table } = req.params;
  const [info, columns, foreignKeys] = await Promise.all([
    schema.getTableInfo(key, database, table),
    schema.getColumnsDetailed(key, database, table),
    schema.getForeignKeys(key, database, table)
  ]);
  return { info, columns, foreignKeys };
}, { logged: false }));
app.post('/api/explore/:key/:database/:table/alter', requireAuth, schemaRoute((req, b) => schema.alterTable(req.params.key, req.params.database, req.params.table, b)));
app.post('/api/explore/:key/:database/:table/foreign-keys', requireAuth, schemaRoute((req, b) => schema.alterForeignKey(req.params.key, req.params.database, req.params.table, b)));

// ---- Server tools (process list, variables, status, MySQL accounts) ----
// Only the connection's owner or an admin. Changes are written to the query
// log (passwords masked).
function serverRoute(handler, { logged = true } = {}) {
  return [requireAuth, requireManage, async (req, res) => {
    const start = Date.now();
    const body = req.body || {};
    try {
      const result = await handler(req, body);
      if (logged && !body.preview && result && result.sql) {
        logAction(req, { source: 'server', sql: result.sql, type: 'OTHER', ok: true, durationMs: Date.now() - start });
      }
      res.json(result);
    } catch (err) {
      if (logged && !body.preview) {
        logAction(req, { source: 'server', sql: err.sql || `(${req.method} ${req.path})`, type: 'OTHER', ok: false, error: err.message, durationMs: Date.now() - start });
      }
      res.status(400).json({ error: err.message });
    }
  }];
}

app.get('/api/server/:key/processes', ...serverRoute((req) => serverAdmin.processList(req.params.key), { logged: false }));
app.post('/api/server/:key/processes/:id/kill', ...serverRoute((req, b) => serverAdmin.killProcess(req.params.key, req.params.id, b)));
app.get('/api/server/:key/variables', ...serverRoute((req) => serverAdmin.variables(req.params.key, 'variables'), { logged: false }));
app.get('/api/server/:key/status', ...serverRoute((req) => serverAdmin.variables(req.params.key, 'status'), { logged: false }));
app.get('/api/server/:key/accounts', ...serverRoute(async (req) => ({ privileges: serverAdmin.PRIVILEGES, accounts: await serverAdmin.listAccounts(req.params.key) }), { logged: false }));
app.post('/api/server/:key/accounts', ...serverRoute((req, b) => serverAdmin.createUser(req.params.key, b)));
app.put('/api/server/:key/accounts/password', ...serverRoute((req, b) => serverAdmin.setPassword(req.params.key, b)));
app.delete('/api/server/:key/accounts', ...serverRoute((req, b) => serverAdmin.dropUser(req.params.key, b)));
app.post('/api/server/:key/grants', ...serverRoute((req, b) => serverAdmin.changeGrants(req.params.key, b)));

// Create / alter / drop an index: { drop?: name, add?: { kind, name, columns: [{ column, length }] }, preview? }.
// With preview: true, only returns the ALTER TABLE statement.
app.post('/api/explore/:key/:database/:table/indexes', requireAuth, async (req, res) => {
  const { drop, add, preview } = req.body || {};
  const start = Date.now();
  let sql = null;
  try {
    const result = await db.alterIndex(req.params.key, req.params.database, req.params.table, { drop, add, preview: true });
    sql = result.sql;
    if (preview) return res.json({ sql });
    await db.getPool(req.params.key).query(sql);
    logAction(req, { source: 'explore', sql, type: 'DDL', ok: true, durationMs: Date.now() - start });
    res.json({ ok: true, sql });
  } catch (err) {
    if (sql) logAction(req, { source: 'explore', sql, type: 'DDL', ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message, sql });
  }
});

app.get('/api/explore/:key/:database/:table/columns', requireAuth, async (req, res) => {
  try {
    res.json(await db.getTableColumns(req.params.key, req.params.database, req.params.table));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?filters= is a JSON array of { col, op, value } (see buildWhere in api/db.js).
function parseFilters(raw) {
  if (!raw) return [];
  let filters;
  try {
    filters = JSON.parse(raw);
  } catch (e) {
    throw new Error('filters must be valid JSON');
  }
  if (!Array.isArray(filters)) throw new Error('filters must be an array');
  return filters;
}

app.get('/api/explore/:key/:database/:table/rows', requireAuth, async (req, res) => {
  try {
    const { page, pageSize, sortCol, sortDir } = req.query;
    const data = await db.browseTable(req.params.key, req.params.database, req.params.table, {
      page,
      pageSize,
      sortCol,
      sortDir,
      sort: parseFilters(req.query.sort),
      filters: parseFilters(req.query.filters)
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download one cell's raw value (for binary columns): ?where={pk json}&col=name
app.get('/api/explore/:key/:database/:table/cell', requireAuth, async (req, res) => {
  try {
    const where = JSON.parse(req.query.where || '{}');
    const value = await db.getCellValue(req.params.key, req.params.database, req.params.table, where, String(req.query.col || ''));
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value === null ? '' : String(value), 'utf8');
    res.setHeader('Content-Type', 'application/octet-stream');
    attachment(res, `${req.params.table}-${req.query.col}.bin`);
    res.end(buf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Row edits are logged as a readable summary (not the exact SQL, which is
// built with placeholders in api/db.js).
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

// Bulk edit: { rows: [pk objects] | all: true + filters, changes, preview }.
app.post('/api/explore/:key/:database/:table/bulk-update', requireAuth, async (req, res) => {
  const body = req.body || {};
  const start = Date.now();
  try {
    const result = await db.bulkUpdate(req.params.key, req.params.database, req.params.table, body);
    if (!body.preview) logAction(req, { source: 'explore', sql: result.sql, type: 'UPDATE', ok: true, durationMs: Date.now() - start, affectedRows: result.affectedRows });
    res.json(result);
  } catch (err) {
    if (!body.preview) logAction(req, { source: 'explore', sql: err.sql || `UPDATE ${qualified(req)} (bulk edit)`, type: 'UPDATE', ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message });
  }
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
  const entry = {
    source: 'export',
    sql: `EXPORT CSV ${qualified(req)}${req.query.filters ? ` FILTERED BY ${req.query.filters}` : ''}`,
    type: 'SELECT'
  };
  let filters;
  let sort;
  try {
    filters = parseFilters(req.query.filters);
    sort = parseFilters(req.query.sort);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    attachment(res, `${table}.csv`);
    await db.streamTableCsv(req.params.key, req.params.database, table, res, { sortCol, sortDir, sort, filters });
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
// Streaming import: the CSV/TSV file is the raw request body; options are a
// JSON query parameter (see importer.importDelimited). Progress and the
// result are sent back as newline-delimited JSON while the file uploads.
app.post('/api/explore/:key/:database/:table/import-file', requireAuth, async (req, res) => {
  let options;
  try {
    options = JSON.parse(req.query.options || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'options must be valid JSON' });
  }
  const start = Date.now();
  const describe = (r) => `IMPORT ${options.format === 'tsv' ? 'TSV' : 'CSV'} INTO ${qualified(req)}: ${r.inserted} row(s)`
    + `${r.skipped ? `, ${r.skipped} skipped` : ''} · duplicates: ${options.onDuplicate || 'error'}${options.truncate ? ' · emptied first' : ''}`;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  const send = (evt) => { if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n'); };
  try {
    const result = await importer.importDelimited(req.params.key, req.params.database, req.params.table, req, options,
      (progress) => send({ type: 'progress', ...progress }));
    logAction(req, { source: 'import', sql: describe(result), type: 'INSERT', ok: true, durationMs: Date.now() - start, affectedRows: result.inserted });
    send({ type: 'done', ...result });
  } catch (err) {
    const r = err.result || { inserted: 0 };
    logAction(req, { source: 'import', sql: describe(r), type: 'INSERT', ok: false, error: err.message, durationMs: Date.now() - start });
    send({ type: 'error', error: err.message, ...(err.result || {}) });
  }
  // Rejected before reading the file (e.g. bad options): let the upload
  // finish (discarded) so the browser receives the answer.
  if (!req.complete && !req.destroyed) await new Promise((resolve) => { req.on('end', resolve); req.on('close', resolve); req.resume(); });
  res.end();
});

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
    attachment(res, `${database}-backup.tar.gz`);
    await db.streamDatabaseBackupTarGz(req.params.key, database, res);
    res.end();
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start });
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- Export: SQL (.sql / .sql.gz) or CSV / TSV with options (see exportDatabase) ---
app.get('/api/explore/:key/:database/export', requireAuth, async (req, res) => {
  let options;
  try {
    options = JSON.parse(req.query.options || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'options must be valid JSON' });
  }
  const start = Date.now();
  const entry = { source: 'backup', sql: `EXPORT ${qualified(req)} ${req.query.options || ''}`.trim(), type: 'OTHER' };
  try {
    await db.exportDatabase(req.params.key, req.params.database, res, options, (filename, contentType) => {
      res.setHeader('Content-Type', contentType);
      attachment(res, filename);
    });
    if (!res.writableEnded) res.end();
    logAction(req, { ...entry, ok: true, durationMs: Date.now() - start });
  } catch (err) {
    logAction(req, { ...entry, ok: false, error: err.message, durationMs: Date.now() - start });
    if (!res.headersSent) res.status(400).json({ error: err.message });
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
  const format = ['targz', 'sqlgz'].includes(req.query.format) ? req.query.format : 'sql';
  const restoreOptions = { onError: req.query.onError === 'continue' ? 'continue' : 'stop', foreignKeyChecks: req.query.foreignKeyChecks === '1' };
  const start = Date.now();
  const entry = { source: 'restore', sql: `RESTORE ${qualified(req)} FROM .${{ targz: 'tar.gz', sqlgz: 'sql.gz', sql: 'sql' }[format]} file`, type: 'OTHER' };
  res.setHeader('Content-Type', 'application/x-ndjson');
  try {
    const result = await db.restoreDump(key, database, req, format, (progress) => {
      res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
    }, restoreOptions);
    logAction(req, {
      ...entry,
      ok: result.failed === 0,
      error: result.failed ? `${result.failed} statement(s) failed${result.stopped ? ' (stopped at the first error)' : ''}` : null,
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
  // databases: { [connKey]: dbName } — where each connection currently is
  // in the Query Runner (after an earlier USE); defaults to its database.
  const { dbKeys, databases, explain, runId } = req.body || {};
  let sql = (req.body || {}).sql;

  if (!Array.isArray(dbKeys) || dbKeys.length === 0) {
    return res.status(400).json({ error: 'dbKeys must be a non-empty array' });
  }
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'sql must be a non-empty string' });
  }
  // {{name}} placeholders become escaped literals; the log and the results show the SQL that actually ran.
  try { sql = params.apply(sql, (req.body || {}).params || {}); } catch (err) { return res.status(400).json({ error: err.message }); }

  const conns = dbKeys.map((key) => store.getConnection(key));
  const denied = dbKeys.filter((key, i) => !conns[i] || !canUse(req.user, conns[i]));
  if (denied.length) {
    return res.status(403).json({ error: `No access to connection(s): ${denied.join(', ')}` });
  }

  const startDb = (key, i) => {
    const d = databases && databases[key];
    return typeof d === 'string' && d ? d : conns[i].database;
  };

  // A run with an id can be stopped from the Stop button (see /api/query/cancel).
  const run = runs.begin(runId, req.user.username);

  const results = await Promise.all(
    dbKeys.map(async (key, i) => {
      let result;
      try {
        const { ok, statements, currentDatabase } = await db.runQuery(key, sql, {
          database: startDb(key, i), explain: Boolean(explain), allowed: restrictionsFor(req.user, conns[i]),
          track: run ? run.track(key) : null
        });
        result = { key, ok, statements, currentDatabase };
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
        database: startDb(key, i),
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

  if (run) run.end();
  res.json({ results });
});

// Stop a run that is still executing: KILL QUERY on each connection running one of its statements.
app.post('/api/query/cancel', requireAuth, async (req, res) => {
  const run = runs.read((req.body || {}).runId);
  if (!run) return res.status(404).json({ error: 'That query is no longer running' });
  if (run.username !== req.user.username && !isAdmin(req.user)) return res.status(403).json({ error: 'That query belongs to someone else' });
  let stopped = 0;
  for (const [key, c] of Object.entries(run.conns || {})) {
    const conn = store.getConnection(key);
    const thread = Number(c.thread);
    if (!conn || !canUse(req.user, conn) || !Number.isInteger(thread) || thread <= 0) continue;
    try {
      stopped += await db.killQuery(key, thread, c.sql);
    } catch (err) { /* the query finished in the meantime */ }
  }
  return res.json({ stopped });
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

// ---- CSV helpers for log exports ----
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  attachment(res, filename);
  res.write('\uFEFF' + header.map(csvCell).join(',') + '\r\n');
  let chunk = '';
  for (const r of rows) {
    chunk += r.map(csvCell).join(',') + '\r\n';
    if (chunk.length > 64 * 1024) { res.write(chunk); chunk = ''; }
  }
  res.end(chunk);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// The same filters as /api/logs, every matching entry, as CSV (for audits).
app.get('/api/logs/export.csv', requireAuth, (req, res) => {
  const entries = querylog.filtered(logFilters(req)).reverse();
  sendCsv(res, `query-log-${stamp()}.csv`,
    ['time', 'user', 'source', 'connection', 'database', 'type', 'ok', 'error', 'duration_ms', 'rows', 'affected_rows', 'sql'],
    entries.map((e) => [e.ts, e.username, e.source, e.connLabel || e.connKey, e.database, e.type, e.ok ? 'yes' : 'no', e.error, e.durationMs, e.rowCount, e.affectedRows, e.sql]));
});

// Sign-in activity and the failed-login report (admins).
const authFilters = (req) => ({ event: req.query.event || undefined, username: req.query.user || undefined, ip: req.query.ip || undefined, q: req.query.q || undefined, from: req.query.from || undefined, to: req.query.to || undefined });
app.get('/api/auth-log', requireAdmin, (req, res) => {
  res.json({ ...authlog.query(authFilters(req), { limit: req.query.limit, offset: req.query.offset }), summary: authlog.summary(req.query.hours) });
});
app.get('/api/auth-log.csv', requireAdmin, (req, res) => {
  const entries = authlog.filter(authlog.readAll(), authFilters(req)).reverse();
  sendCsv(res, `sign-in-activity-${stamp()}.csv`, ['time', 'event', 'user', 'ip', 'detail', 'browser'], entries.map((e) => [e.ts, e.event, e.username, e.ip, e.detail, e.agent]));
});

// ---- Scheduled jobs: queries, analysis, backups, connection checks ----
// Everyone manages their own jobs (a job runs with its owner's permissions); admins see and manage all of them.
const jobView = (job) => {
  const conn = job.connKey ? store.getConnection(job.connKey) : null;
  return { ...jobs.view(job), connLabel: conn ? conn.label : (job.connKey ? '(deleted)' : undefined), running: scheduler.runningIds().includes(job.id) };
};
function requireJob(req, res, next) {
  const job = jobs.get(req.params.id);
  if (!job || (job.owner !== req.user.username && !isAdmin(req.user))) return res.status(404).json({ error: 'Job not found' });
  req.job = job;
  return next();
}
// The connections a job refers to must be usable by whoever saves it; a backup needs more.
function checkJobAccess(user, job) {
  const keys = job.type === 'health' ? (job.connKeys || []) : [job.connKey];
  for (const k of keys) {
    const conn = store.getConnection(k);
    if (!conn || !canUse(user, conn)) throw new Error('No access to that connection');
    if (job.type === 'backup' && !canManage(user, conn)) throw new Error('Scheduled backups need owner or admin rights on the connection');
  }
}

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json(jobs.list().filter((j) => isAdmin(req.user) || j.owner === req.user.username).map(jobView));
});
app.post('/api/schedule/preview', requireAuth, (req, res) => {
  try {
    const expr = cron.validate(req.body && req.body.schedule);
    const runs = [];
    let from = new Date();
    for (let i = 0; i < 5; i++) { const d = cron.next(expr, from); if (!d) break; runs.push(d.toISOString()); from = d; }
    res.json({ schedule: expr, next: runs });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/jobs', requireAuth, (req, res) => {
  try {
    const draft = jobs.normalize(req.body || {});
    checkJobAccess(req.user, draft);
    res.status(201).json(jobView(jobs.create(req.body, req.user.username)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/jobs/:id', requireAuth, requireJob, (req, res) => {
  try {
    const draft = { ...jobs.normalize(req.body || {}, req.job) };
    checkJobAccess(req.user, draft);
    res.json(jobView(jobs.update(req.job.id, req.body)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/jobs/:id', requireAuth, requireJob, (req, res) => {
  jobs.remove(req.job.id);
  res.json({ ok: true });
});
// Runs it now. Returns at once; with ?wait=1 it waits for the run to finish and returns it.
app.post('/api/jobs/:id/run', requireAuth, requireJob, async (req, res) => {
  if (scheduler.runningIds().includes(req.job.id)) return res.status(409).json({ error: 'This job is already running' });
  const p = scheduler.runJob(req.job, { trigger: 'manual', by: req.user.username });
  if (req.query.wait === '1') {
    try { return res.json(await p); } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  p.catch((e) => console.error(`Job ${req.job.name} failed: ${e.message}`));
  return res.status(202).json({ started: true });
});
app.get('/api/jobs/:id/runs', requireAuth, requireJob, (req, res) => {
  res.json(jobs.runsFor(req.job.id, Math.min(Number(req.query.limit) || 50, 200)));
});
// The file a run produced: the CSV of a query job, or a backup.
app.get('/api/jobs/:id/runs/:runId/file', requireAuth, requireJob, (req, res) => {
  const run = jobs.runsFor(req.job.id, 1000).find((r) => r.id === req.params.runId);
  if (!run || !run.file) return res.status(404).json({ error: 'No file for this run' });
  const dir = req.job.type === 'backup' ? jobs.backupDir(req.job.id) : jobs.outputDir(req.job.id);
  const file = path.join(dir, path.basename(run.file));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is gone (older files are removed to keep the newest ones)' });
  if (req.job.type === 'backup') {
    const conn = store.getConnection(req.job.connKey);
    if (!conn || !canManage(req.user, conn)) return res.status(403).json({ error: 'Downloading a backup needs owner or admin rights on the connection' });
  }
  return res.download(file, path.basename(file));
});

// Where alerts go (admins).
app.get('/api/notify', requireAuth, (req, res) => {
  const v = notify.publicView();
  res.json(isAdmin(req.user) ? v : { emailConfigured: v.emailConfigured, webhookConfigured: v.webhookConfigured });
});
app.put('/api/notify', requireAdmin, (req, res) => {
  try { res.json(notify.save(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/notify/test', requireAdmin, async (req, res) => {
  const { email, webhook } = req.body || {};
  const out = { sent: [], errors: [] };
  if (email) { try { await notify.sendEmail({ to: email, subject: '[DB Console] Test message', text: 'Alerts from DB Console reach this address.' }); out.sent.push('email'); } catch (e) { out.errors.push('email: ' + e.message); } }
  if (webhook) { try { await notify.sendWebhook({ text: '[DB Console] Test message', subject: 'Test message', event: 'test' }); out.sent.push('webhook'); } catch (e) { out.errors.push('webhook: ' + e.message); } }
  res.json(out);
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
    const result = await system.update({ restart, username: req.user.username }, emit);
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
  const requestedAt = Date.now();
  const action = system.scheduleRestart();
  res.json({ ok: true, restarting: true, action, requestedAt });
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
if (!config.sessionSecret || config.sessionSecret === DEFAULT_SESSION_SECRET) {
  console.warn('WARNING: sessionSecret is the sample value — set SESSION_SECRET (or sessionSecret in config.js) to a long random string.');
}

const server = app.listen(PORT, () => {
  console.log(`DB Console running at http://localhost:${PORT} (data: ${DATA_DIR})`);
  const admins = store.listUsers().filter((u) => u.role === 'admin').map((u) => u.username);
  console.log(`Admin account(s): ${admins.join(', ')}`);
  // With `wait_ready: true` in the PM2 ecosystem file, PM2 waits for this
  // before routing traffic to a reloaded worker and stopping the old one.
  if (process.send) process.send('ready');
  scheduler.start();
});
// Node closes a request that takes longer than 5 minutes to upload by
// default; a restore or import of a multi-GB file can take much longer.
// Slow-header protection (headersTimeout) stays on.
server.requestTimeout = 0;

// Graceful shutdown: PM2 sends SIGINT on reload/restart/stop. Stop taking
// new connections, let in-flight requests finish, then close DB pools.
// PM2 force-kills after kill_timeout if something hangs.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    // Second Ctrl+C when running by hand: don't wait any longer.
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  // A long export/restore could keep the server open; don't wait forever.
  setTimeout(() => process.exit(0), 10000).unref();
  scheduler.stop();
  server.close(async () => {
    await db.closeAllPools();
    process.exit(0);
  });
  // Idle keep-alive connections would otherwise hold server.close() open.
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
