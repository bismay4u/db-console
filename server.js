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
const insight = require('./api/insight');
const diff = require('./api/diff');
const metrics = require('./api/metrics');
const totp = require('./api/totp');
const secrets = require('./api/secrets');
const oidcMod = require('./api/oidc');
const ldapMod = require('./api/ldap');
const approvals = require('./api/approvals');
const engines = require('./api/engines');
const engineExplore = require('./api/engine-explore');
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

const { isAdmin, canManage, permissionsOf, restrictionsFor, canUse, scopeOf } = require('./api/access');
const scopeLib = require('./api/scope');

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
    totpEnabled: Boolean(u.totp && u.totp.enabled),
    sso: u.sso || undefined
  };
}

// --- Connection access ---
// Owner and admins manage a connection (edit, delete, share). Anyone it is
// shared with may use it (run queries, explore, export, back up, restore),
// or, when it is shared read-only, only read through it.
// What is missing or not allowed in a new connection, or null. A SQLite connection names a file on the server,
// so only administrators may add one.
function connectionProblem(req, { label, host, user, database, engine }) {
  if (engine === 'sqlite') {
    if (!isAdmin(req.user)) return 'Only administrators can add SQLite connections (they open a file on the server)';
    if (!label || !database) return 'label and the file path are required';
    if (/^(file|https?):/i.test(database)) return 'Give the path of the file, not a URL';
    return null;
  }
  if (engine && !['mysql', 'postgres'].includes(engine)) return 'Unknown database engine';
  if (!label || !host || !user || !database) return 'label, host, user and database are required';
  return null;
}

function connView(conn, user) {
  const { sharedWith, secretError, ...rest } = conn;
  rest.engine = conn.engine || 'mysql';
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
    shareScopes: manage ? (conn.shareScopes || undefined) : undefined,
    limited: manage ? undefined : Boolean(scopeOf(user, conn)),
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

// ---- Database / table limits on shared connections (see api/scope.js) ----
const dbNameCache = new Map();
async function knownDatabases(key) {
  const hit = dbNameCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.names;
  let names = [];
  try { names = await db.listDatabases(key); } catch (e) { /* the query itself will report the problem */ }
  dbNameCache.set(key, { at: Date.now(), names });
  return names;
}
// null when `sql` stays inside what the user may touch on `conn`, else the message.
async function scopeError(user, conn, sql, currentDb) {
  const sc = scopeOf(user, conn);
  // Restrictions read SQL with MySQL's quoting rules; other engines quote differently, so free-form SQL is refused (Explore still works).
  if (sc && conn.engine && conn.engine !== 'mysql') return 'Your access to this connection is limited to certain databases or tables, so SQL cannot be run on a ' + (conn.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL') + ' connection. Use Explore instead.';
  return sc ? scopeLib.checkSql(sc, sql, currentDb, await knownDatabases(conn.key)) : null;
}
const DB_LEVEL_FORBIDDEN_WITH_HIDDEN = new Set(['export', 'restore', 'analyze', 'search-replace']); // they read every table
app.use('/api/explore/:key', (req, res, next) => {
  if (!req.user) return next();
  const conn = store.getConnection(req.params.key);
  if (!conn || !canUse(req.user, conn)) return next();
  const sc = scopeOf(req.user, conn);
  if (!sc) return next();
  const segs = req.path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
  const deny = (status, message) => res.status(status).json({ error: message });
  const hasHidden = sc.hideTables.length > 0;

  if (segs[0] === 'databases') {
    if (req.method === 'POST' && sc.databases) return deny(403, 'You cannot create databases on this connection');
    if (req.method === 'GET' && sc.databases) {
      const send = res.json.bind(res);
      res.json = (body) => send(Array.isArray(body) ? body.filter((d) => scopeLib.dbAllowed(sc, d)) : body);
    }
    return next();
  }
  if (segs[0] === 'meta' || !segs[0]) return next();
  const database = segs[0];
  if (!scopeLib.dbAllowed(sc, database)) return deny(403, `You do not have access to the database ${database}`);
  const second = segs[1];
  const dbLevel = segs.length <= 2 || ['objects', 'definition', 'analyze'].includes(second);
  if (hasHidden) {
    if (dbLevel) {
      if (DB_LEVEL_FORBIDDEN_WITH_HIDDEN.has(second)) return deny(403, 'This is not available while some tables are hidden from you');
      if (second === 'definition' && scopeLib.tableHidden(sc, database, segs[3] || '')) return deny(404, 'Not found');
      if (second === 'table-actions' || second === 'objects') {
        const names = [...(req.body.tables || []), req.body.target, req.body.newName, req.body.name].filter(Boolean);
        if (names.some((n) => scopeLib.tableHidden(sc, database, n))) return deny(403, 'That table is not available to you');
        if (typeof req.body.sql === 'string') { const err = scopeLib.checkSql(sc, req.body.sql, database, []); if (err) return deny(403, err); }
      }
      if (second === 'tables' && req.method === 'POST' && scopeLib.tableHidden(sc, database, (req.body || {}).name || '')) return deny(403, 'That name is not available to you');
      const send = res.json.bind(res);
      const visible = (t) => !scopeLib.tableHidden(sc, database, t.name || t.table || '');
      res.json = (body) => {
        if (!body || typeof body !== 'object') return send(body);
        if (second === 'objects' && Array.isArray(body.tables)) return send({ ...body, tables: body.tables.filter(visible) });
        if (second === 'autocomplete' && body.tables) return send({ ...body, tables: Object.fromEntries(Object.entries(body.tables).filter(([t]) => !scopeLib.tableHidden(sc, database, t))) });
        if (second === 'diagram') return send({ ...body, tables: (body.tables || []).filter(visible), foreignKeys: (body.foreignKeys || []).filter((f) => !scopeLib.tableHidden(sc, database, f.table) && !scopeLib.tableHidden(sc, database, f.refTable)) });
        if (second === 'foreign-keys' && Array.isArray(body)) return send(body.filter((f) => !scopeLib.tableHidden(sc, database, f.table) && !scopeLib.tableHidden(sc, database, f.refTable)));
        if (second === 'search' && Array.isArray(body.results)) return send({ ...body, results: body.results.filter((r) => !scopeLib.tableHidden(sc, database, r.table)) });
        return send(body);
      };
    } else if (scopeLib.tableHidden(sc, database, second)) {
      return deny(404, `Table not found: ${second}`);
    }
  }
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

// PostgreSQL and SQLite connections have their own, smaller Explore API (api/engine-explore.js).
app.use('/api/explore/:key', (req, res, next) => {
  if (!req.user) return next();
  const conn = store.getConnection(req.params.key);
  if (!conn || !canUse(req.user, conn) || engines.engineOf(conn) === 'mysql') return next();
  return engineExplore.handle(req, res, next, conn, { logAction, attachment, parseFilters });
});
// The server tools (processes, variables, accounts, health) are MySQL / MariaDB only.
app.use('/api/server/:key', (req, res, next) => {
  const conn = req.user && store.getConnection(req.params.key);
  if (conn && engines.engineOf(conn) !== 'mysql') return res.status(400).json({ error: engines.unsupported(engines.engineOf(conn), 'The server tools are').message });
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
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const who = { username: String(username || '').slice(0, 64), ip: req.ip, agent: req.get('user-agent') };
  const retryAfter = loginRetryAfter(req, username);
  if (retryAfter) {
    authlog.record({ ...who, event: 'login_locked', detail: `blocked for ${Math.ceil(retryAfter / 60)} more minute(s)` });
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
  }

  const local = store.getUser(String(username || ''));
  let user = local;
  let valid;
  if (ldapClient && (!local || local.sso === 'ldap')) {
    // A directory account (or a name no local account has): the directory checks the password.
    // A local account is never handed to the directory, so a directory user cannot take over a local name.
    valid = false;
    try {
      const found = await ldapClient.authenticate(username, password);
      if (found) {
        valid = true;
        user = provisionLdapUser(found);
      }
    } catch (e) {
      authlog.record({ ...who, event: 'login_failed', detail: `LDAP: ${e.message}`.slice(0, 160) });
      recordLoginAttempt(req, username, false);
      return res.status(e.refused ? 401 : 503).json({ error: e.refused ? e.message : 'The directory server could not be reached' });
    }
    if (!valid) user = null;
  } else {
    // Always verify (against a dummy hash for unknown users) so response
    // time doesn't reveal which usernames exist.
    valid = store.verifyPassword(password, user ? user.passwordHash : null) && !(user && user.sso);
  }
  if (!user || !valid || user.disabled) {
    authlog.record({ ...who, event: 'login_failed', detail: !user ? 'unknown user' : user.disabled ? 'account disabled' : 'wrong password' });
    recordLoginAttempt(req, username, false);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Second factor: the password alone does not sign in. The half-finished sign-in lives in the session for 5 minutes.
  if (user.totp && user.totp.enabled) {
    return req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start session' });
      req.session.pending2fa = { username: user.username, at: Date.now(), defaultPassword: password === DEFAULT_ADMIN_PASSWORD };
      authlog.record({ ...who, username: user.username, event: 'login_2fa_required', detail: 'password accepted, waiting for the code' });
      return res.json({ need2fa: true });
    });
  }
  recordLoginAttempt(req, username, true);
  return completeLogin(req, res, user, { defaultPassword: password === DEFAULT_ADMIN_PASSWORD, method: 'password' });
});

// Starts the signed-in session. Shared by every way of signing in (password, 2FA, SSO, LDAP).
function completeLogin(req, res, user, { defaultPassword = false, method = 'password', redirect = null } = {}) {
  authlog.record({ username: user.username, ip: req.ip, agent: req.get('user-agent'), event: 'login_ok', detail: method === 'password' ? undefined : `via ${method}` });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.authenticated = true;
    req.session.username = user.username;
    req.session.sessionVersion = user.sessionVersion || 1;
    req.session.defaultPassword = defaultPassword;
    store.touchLastLogin(user.username);
    return redirect ? res.redirect(redirect) : res.json({ ok: true });
  });
}

// Step two of a password sign-in: an authenticator code, or a recovery code.
app.post('/api/login/2fa', (req, res) => {
  const pending = req.session && req.session.pending2fa;
  const who = { ip: req.ip, agent: req.get('user-agent') };
  if (!pending || Date.now() - pending.at > 5 * 60 * 1000) return res.status(401).json({ error: 'Your sign-in expired — enter your password again', expired: true });
  const retryAfter = loginRetryAfter(req, pending.username);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
  }
  const user = store.getUser(pending.username);
  const code = String((req.body || {}).code || '').trim();
  const fail = (detail) => {
    authlog.record({ ...who, username: pending.username, event: 'login_failed', detail });
    recordLoginAttempt(req, pending.username, false);
    return res.status(401).json({ error: 'That code is not right' });
  };
  if (!user || user.disabled || !user.totp || !user.totp.enabled) return fail('2FA not available');
  let secret;
  try { secret = secrets.decrypt(user.totp.secret); } catch (e) { return res.status(500).json({ error: 'The 2FA secret cannot be read (the encryption key changed?). Ask an administrator to reset your 2FA.' }); }
  const step = totp.verify(secret, code, { lastStep: user.totp.lastStep || 0 });
  if (step !== null) {
    store.patchUser(user.username, { totp: { ...user.totp, lastStep: step } });
  } else {
    const rest = totp.useRecoveryCode(user.totp.recovery, code);
    if (!rest) return fail('wrong 2FA code');
    store.patchUser(user.username, { totp: { ...user.totp, recovery: rest } });
    authlog.record({ ...who, username: user.username, event: 'recovery_code_used', detail: `${rest.length} left` });
  }
  recordLoginAttempt(req, pending.username, true);
  return completeLogin(req, res, user, { defaultPassword: pending.defaultPassword, method: '2FA' });
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
    usingDefaultPassword: Boolean(req.session.defaultPassword),
    totpEnabled: Boolean(req.user.totp && req.user.totp.enabled),
    needs2faSetup: REQUIRE_2FA && !(req.user.totp && req.user.totp.enabled)
  });
});

// --- Directory sign-in (LDAP / Active Directory) ---
const ldapSettings = ldapMod.load(config);
const ldapClient = ldapSettings.enabled ? ldapMod.create(ldapSettings) : null;

// The local user for a directory account, created on first sign-in when allowed. The directory entry (its DN)
// is the identity; the admin role follows the admin group on every sign-in.
function provisionLdapUser(found) {
  const subject = `ldap|${found.dn.toLowerCase()}`;
  let user = store.listUsers().find((u) => u.ssoSub === subject);
  const role = found.admin ? 'admin' : (store.ROLES.includes(ldapSettings.defaultRole) ? ldapSettings.defaultRole : 'user');
  if (!user) {
    if (!ldapSettings.autoCreate) { const e = new Error('You have no account here yet — ask an administrator to let you in'); e.refused = true; throw e; }
    user = store.createExternalUser({ preferred: found.username, displayName: found.name, role, sso: 'ldap', ssoSub: subject, email: found.email });
  } else if (ldapSettings.adminGroupDn && user.role !== role && (user.role === 'admin' || role === 'admin')) {
    user = store.updateUser(user.username, { role });
  }
  return user;
}

// --- Single sign-on (OpenID Connect) ---
const oidcSettings = oidcMod.load(config);
const oidcClient = oidcSettings.enabled ? oidcMod.create(oidcSettings) : null;

// What the login page needs to know before anyone is signed in.
app.get('/api/auth-config', (req, res) => {
  res.json({ oidc: oidcClient ? { label: oidcSettings.label } : null, ldap: ldapClient ? { label: ldapSettings.label } : null });
});

const oidcRedirectUri = (req) => oidcSettings.redirectUri || `${req.protocol}://${req.get('host')}/auth/oidc/callback`;
const loginError = (res, message) => res.redirect('/login?error=' + encodeURIComponent(message));

app.get('/auth/oidc/login', async (req, res) => {
  if (!oidcClient) return loginError(res, 'Single sign-on is not set up');
  try {
    const { url, saved } = await oidcClient.start(oidcRedirectUri(req));
    req.session.oidc = saved;
    return req.session.save(() => res.redirect(url));
  } catch (e) { return loginError(res, `Could not reach the sign-in provider: ${e.message}`); }
});

app.get('/auth/oidc/callback', async (req, res) => {
  const who = { ip: req.ip, agent: req.get('user-agent') };
  if (!oidcClient) return loginError(res, 'Single sign-on is not set up');
  const retryAfter = loginRetryAfter(req, '*sso');
  if (retryAfter) return loginError(res, 'Too many failed sign-in attempts. Try again later.');
  const saved = req.session.oidc;
  delete req.session.oidc;
  try {
    const profile = await oidcClient.finish(req.query, saved);
    const user = provisionSsoUser(profile);
    recordLoginAttempt(req, '*sso', true);
    return completeLogin(req, res, user, { method: 'SSO', redirect: '/' });
  } catch (e) {
    authlog.record({ ...who, username: '(sso)', event: 'login_failed', detail: `SSO: ${e.message}` });
    recordLoginAttempt(req, '*sso', false);
    return loginError(res, e.message);
  }
});

// The local user for an identity the provider has vouched for, created on first sign-in when allowed.
function provisionSsoUser(profile) {
  const domain = profile.email.split('@')[1];
  if (oidcSettings.allowedDomains.length && !oidcSettings.allowedDomains.includes(domain)) throw new Error(`Accounts at ${domain} may not sign in here`);
  const subject = `oidc|${oidcSettings.issuer}|${profile.sub}`;
  let user = store.listUsers().find((u) => u.ssoSub === subject);
  if (!user) {
    if (!oidcSettings.autoCreate) throw new Error('You have no account here yet — ask an administrator to let you in');
    const role = oidcSettings.adminEmails.includes(profile.email) ? 'admin' : (store.ROLES.includes(oidcSettings.defaultRole) ? oidcSettings.defaultRole : 'user');
    user = store.createExternalUser({ preferred: profile.email.split('@')[0], displayName: profile.name, role, sso: 'oidc', ssoSub: subject, email: profile.email });
  } else if (user.email !== profile.email) {
    user = store.patchUser(user.username, { email: profile.email });
  }
  if (user.disabled) throw new Error('This account is disabled');
  return user;
}

// --- Two-factor authentication (own account) ---
const REQUIRE_2FA = /^(1|true|yes)$/i.test(String(process.env.REQUIRE_2FA ?? config.require2fa ?? ''));
const TOTP_ISSUER = 'DB Console';

// With require2fa on, a user without 2FA can only set it up (and sign out) until they have.
app.use('/api', (req, res, next) => {
  if (!REQUIRE_2FA || !req.user || (req.user.totp && req.user.totp.enabled)) return next();
  if (/^\/(session|logout|login|2fa)/.test(req.path)) return next();
  return res.status(403).json({ error: 'Two-factor authentication is required: set it up first', needs2faSetup: true });
});

app.get('/api/2fa', requireAuth, (req, res) => {
  const t = req.user.totp;
  res.json({ enabled: Boolean(t && t.enabled), required: REQUIRE_2FA, sso: Boolean(req.user.sso), recoveryLeft: t && t.enabled ? (t.recovery || []).length : 0, enabledAt: t && t.enabledAt });
});
// Step 1: a fresh secret (kept in the session only until it is confirmed).
app.post('/api/2fa/setup', requireAuth, (req, res) => {
  if (req.user.totp && req.user.totp.enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });
  const secret = totp.newSecret();
  req.session.pendingTotp = { secret, at: Date.now() };
  res.json({ secret, uri: totp.uri(req.user.username, TOTP_ISSUER, secret) });
});
// Step 2: prove the app shows the right codes, then it is on. The recovery codes are shown once.
app.post('/api/2fa/enable', requireAuth, (req, res) => {
  const pending = req.session.pendingTotp;
  if (!pending || Date.now() - pending.at > 15 * 60 * 1000) return res.status(400).json({ error: 'Start again: the setup expired' });
  const step = totp.verify(pending.secret, (req.body || {}).code);
  if (step === null) return res.status(400).json({ error: 'That code is not right — check the time on your phone and try the next code' });
  const { codes, hashes } = totp.newRecoveryCodes();
  store.patchUser(req.user.username, { totp: { enabled: true, secret: secrets.encrypt(pending.secret), lastStep: step, recovery: hashes, enabledAt: new Date().toISOString() } });
  delete req.session.pendingTotp;
  authlog.record({ username: req.user.username, ip: req.ip, agent: req.get('user-agent'), event: '2fa_enabled' });
  res.json({ ok: true, recoveryCodes: codes });
});
app.post('/api/2fa/disable', requireAuth, (req, res) => {
  if (!req.user.totp || !req.user.totp.enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
  if (REQUIRE_2FA) return res.status(400).json({ error: 'Two-factor authentication is required on this server' });
  const { password, code } = req.body || {};
  if (!req.user.sso && !store.verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Your password is not right' });
  let secret;
  try { secret = secrets.decrypt(req.user.totp.secret); } catch (e) { secret = ''; }
  if (totp.verify(secret, code, { lastStep: req.user.totp.lastStep || 0 }) === null && !totp.useRecoveryCode(req.user.totp.recovery, code)) return res.status(400).json({ error: 'That code is not right' });
  store.patchUser(req.user.username, { totp: undefined });
  authlog.record({ username: req.user.username, ip: req.ip, agent: req.get('user-agent'), event: '2fa_disabled' });
  res.json({ ok: true });
});
app.post('/api/2fa/recovery-codes', requireAuth, (req, res) => {
  const t = req.user.totp;
  if (!t || !t.enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
  let secret;
  try { secret = secrets.decrypt(t.secret); } catch (e) { secret = ''; }
  if (totp.verify(secret, (req.body || {}).code, { lastStep: t.lastStep || 0 }) === null) return res.status(400).json({ error: 'That code is not right' });
  const { codes, hashes } = totp.newRecoveryCodes();
  store.patchUser(req.user.username, { totp: { ...t, recovery: hashes } });
  res.json({ ok: true, recoveryCodes: codes });
});
// An administrator turns 2FA off for someone who lost their phone and their recovery codes.
app.delete('/api/users/:username/2fa', requireAdmin, (req, res) => {
  const target = store.getUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  store.patchUser(target.username, { totp: undefined });
  authlog.record({ username: target.username, ip: req.ip, agent: req.get('user-agent'), event: '2fa_reset', detail: `by ${req.user.username}` });
  res.json({ ok: true });
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
  const { label, host, port, user, password, database, passwordFrom, engine, sqliteCreate, sqliteReadOnly } = req.body || {};
  const problem = connectionProblem(req, { label, host, user, database, engine });
  if (problem) return res.status(400).json({ error: problem });
  const conn = store.createConnection({
    label, host, port, user, database, engine, sqliteCreate, sqliteReadOnly,
    password: resolvePassword(password, passwordFrom, req.user),
    owner: req.user.username,
    ...networkFromBody(req.body, passwordFrom, req.user)
  });
  res.status(201).json(connView(conn, req.user));
});

app.put('/api/connections/:key', requireAuth, requireManage, (req, res) => {
  const { label, host, port, user, password, database, monitor, requireApproval, sqliteCreate, sqliteReadOnly } = req.body || {};
  if (req.conn.engine === 'sqlite' && database !== undefined && database !== req.conn.database && !isAdmin(req.user)) return res.status(403).json({ error: 'Only administrators can change the file of a SQLite connection' });
  const updated = store.updateConnection(req.params.key, { label, host, port, user, password, database, monitor, requireApproval, sqliteCreate, sqliteReadOnly, ...networkFromBody(req.body || {}) });
  if (!updated) return res.status(404).json({ error: 'Connection not found' });
  db.dropPool(req.params.key); // force pool rebuild with new settings
  res.json(connView(updated, req.user));
});

// Replace who a connection is shared with: { sharedWith: ['alice', 'bob'] }
// or { sharedWith: ['*'] } for every user.
app.put('/api/connections/:key/sharing', requireAuth, requireManage, (req, res) => {
  const { sharedWith, permissions, readOnly, scopes } = req.body || {};
  if (!Array.isArray(sharedWith)) return res.status(400).json({ error: 'sharedWith must be an array' });
  const updated = store.setConnectionSharing(req.params.key, sharedWith, permissions, readOnly === undefined ? undefined : Boolean(readOnly), scopes);
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
  const { host, port, user, password, database, passwordFrom, engine, sqliteCreate, sqliteReadOnly } = req.body || {};
  const problem = connectionProblem(req, { label: 'test', host, user, database, engine });
  if (problem) return res.status(400).json({ error: problem });
  const result = await db.testConnection({
    engine: ['postgres', 'sqlite'].includes(engine) ? engine : undefined,
    sqliteCreate: Boolean(sqliteCreate), sqliteReadOnly: Boolean(sqliteReadOnly),
    host,
    port: Number(port) || (engine === 'postgres' ? 5432 : 3306),
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
  const outOfScope = await scopeError(req.user, conn, sql, options.database);
  if (outOfScope) return res.status(403).json({ error: outOfScope });
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

// Dismiss a finding ("we know") or bring it back. Needs owner/admin rights on the connection.
app.post('/api/explore/:key/:database/analyze/dismiss', requireAuth, requireManage, (req, res) => {
  try { res.json(analyzer.dismiss(req.params.key, req.params.database, req.body || {}, req.user.username)); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/explore/:key/:database/analyze/restore', requireAuth, requireManage, (req, res) => {
  const { rule, object } = req.body || {};
  res.json({ ok: analyzer.restore(req.params.key, req.params.database, rule, object) });
});
// Run a finding's suggested fix. The SQL comes from a fresh analysis on the server, never from the browser, and
// runs with the caller's permissions (so a read-only share can't apply anything). Without confirm:true it only
// returns the SQL and what it needs, so the UI can show a preview first.
app.post('/api/explore/:key/:database/analyze/apply', requireAuth, async (req, res) => {
  const { key, database } = req.params;
  const { rule, object, confirm } = req.body || {};
  const conn = req.conn;
  const start = Date.now();
  try {
    const found = (await analyzer.analyze(key, database, { only: [rule] })).findings.find((f) => f.rule === rule && f.object === object);
    if (!found) return res.status(404).json({ error: 'That finding is gone — the problem may already be fixed. Run the analysis again.' });
    if (!found.fix) return res.status(400).json({ error: 'This finding has no automatic fix' });
    const statements = db.splitStatements(found.fix);
    const allowed = restrictionsFor(req.user, conn);
    const denied = statements.map((s) => perms.statementDenied(s, allowed)).find(Boolean);
    const destructive = statements.some((s) => /^\s*(drop|truncate|delete|kill)\b/i.test(s));
    if (!confirm) return res.json({ sql: found.fix, statements: statements.length, destructive, denied: denied || null, message: found.message });
    if (denied) return res.status(403).json({ error: denied });
    const result = await db.runQuery(key, found.fix, { database, allowed });
    const failed = result.statements.find((s) => !s.ok);
    querylog.record({ username: req.user.username, source: 'analysis-fix', connKey: key, connLabel: conn.label, database, sql: found.fix, type: querylog.statementType(found.fix), ok: result.ok, error: failed ? failed.error : null, durationMs: Date.now() - start });
    if (!result.ok) return res.status(400).json({ error: failed ? failed.error : 'The fix failed' });
    return res.json({ ok: true, statements: result.statements.length });
  } catch (err) { return res.status(400).json({ error: err.message }); }
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
app.post('/api/explore/:key/:database/search-replace', requireAuth, schemaRoute((req, b) => insight.searchReplace(req.params.key, req.params.database, { ...b, preview: b.preview !== false })));
app.get('/api/explore/:key/:database/:table/profile', requireAuth, schemaRoute((req) => insight.profileColumn(req.params.key, req.params.database, req.params.table, req.query.column), { logged: false }));
app.get('/api/explore/:key/:database/:table/related', requireAuth, schemaRoute((req) => {
  let where;
  try { where = JSON.parse(req.query.where || '{}'); } catch (e) { throw new Error('where must be JSON'); }
  return insight.relatedRows(req.params.key, req.params.database, req.params.table, where);
}, { logged: false }));
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

app.get('/api/server/:key/health', ...serverRoute((req) => metrics.snapshot(req.params.key), { logged: false }));
app.get('/api/server/:key/health/history', ...serverRoute((req) => ({ recording: Boolean(req.conn.monitor), points: metrics.history(req.params.key, Date.now() - Math.min(Math.max(Number(req.query.hours) || 1, 0.1), 168) * 3600000) }), { logged: false }));
app.get('/api/server/:key/innodb-status', ...serverRoute(async (req) => ({ text: await metrics.innodbStatus(req.params.key) }), { logged: false }));
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
      const outOfScope = await scopeError(req.user, conns[i], sql, startDb(key, i));
      if (outOfScope) return { key, ok: false, statements: [{ sql, ok: false, error: outOfScope }] };
      // A shared user on a connection that wants a second pair of eyes: dangerous statements wait for approval.
      if (conns[i].requireApproval && !explain && !canManage(req.user, conns[i])) {
        const reasons = approvals.classify(sql);
        if (reasons.length) {
          const a = approvals.create({ requester: req.user.username, connKey: key, connLabel: conns[i].label, database: startDb(key, i), sql, reasons });
          announceApproval(a);
          querylog.record({ username: req.user.username, source: 'runner', connKey: key, connLabel: conns[i].label, database: startDb(key, i), sql, type: querylog.statementType(sql), ok: false, error: `Held for approval (${reasons.join(', ')})`, durationMs: 0 });
          return { key, ok: false, pending: true, approvalId: a.id, statements: [{ sql, ok: false, error: `Needs approval before it runs (${reasons.join(', ')}). The owner of this connection has been asked.` }] };
        }
      }
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
      const submitted = db.splitStatementsFor(key, sql);
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

// ---- Approvals for dangerous statements ----
const announced = new Set();
function announceApproval(a) {
  if (announced.has(a.id)) return;
  announced.add(a.id);
  const st = notify.load();
  const link = notify.link('/#/approvals');
  notify.deliver({
    subject: `[DB Console] ${a.requester} asks to run ${a.reasons.join(', ')} on ${a.connLabel}`,
    text: `${a.requester} wants to run this on ${a.connLabel} (${a.database}):\n\n${a.sql.slice(0, 1500)}\n\nIt will not run until the owner of the connection or an admin approves it.${link ? '\n' + link : ''}`,
    data: { event: 'approval.requested', approval: { id: a.id, requester: a.requester, connection: a.connLabel, database: a.database, reasons: a.reasons } },
    to: st.approvalEmails, webhook: true
  }).catch(() => {});
}
const approvalView = (a, user) => {
  const conn = store.getConnection(a.connKey);
  return { ...a, connLabel: conn ? conn.label : a.connLabel, canDecide: a.status === 'pending' && a.requester !== user.username && Boolean(conn) && canManage(user, conn), mine: a.requester === user.username };
};
app.get('/api/approvals', requireAuth, (req, res) => {
  const all = approvals.load().map((a) => approvalView(a, req.user));
  const toApprove = all.filter((a) => !a.mine && (isAdmin(req.user) || (store.getConnection(a.connKey) || {}).owner === req.user.username));
  res.json({
    toApprove: toApprove.slice().reverse().slice(0, 200),
    mine: all.filter((a) => a.mine).reverse().slice(0, 100),
    pending: toApprove.filter((a) => a.status === 'pending').length
  });
});
function loadApproval(req, res) {
  const a = approvals.get(req.params.id);
  const conn = a && store.getConnection(a.connKey);
  if (!a || !conn) { res.status(404).json({ error: 'Request not found' }); return null; }
  return { a, conn };
}
app.post('/api/approvals/:id/approve', requireAuth, async (req, res) => {
  const found = loadApproval(req, res); if (!found) return;
  const { a, conn } = found;
  if (a.status !== 'pending') return res.status(409).json({ error: `This request is already ${a.status}` });
  if (a.requester === req.user.username) return res.status(403).json({ error: 'You cannot approve your own request' });
  if (!canManage(req.user, conn)) return res.status(403).json({ error: 'Only the owner of the connection or an admin can approve this' });
  const requester = store.getUser(a.requester);
  const start = Date.now();
  let outcome;
  try {
    if (!requester || requester.disabled) throw new Error('The user who asked no longer has an active account');
    if (!canUse(requester, conn)) throw new Error('The user who asked no longer has access to this connection');
    const bad = await scopeError(requester, conn, a.sql, a.database);
    if (bad) throw new Error(bad);
    const result = await db.runQuery(a.connKey, a.sql, { database: a.database, allowed: restrictionsFor(requester, conn) });
    const failed = result.statements.find((x) => !x.ok);
    outcome = { ok: result.ok, error: failed ? failed.error : null, statements: result.statements.length, affected: result.statements.reduce((n, x) => n + (x.affectedRows || 0), 0) };
  } catch (err) { outcome = { ok: false, error: err.message, statements: 0, affected: 0 }; }
  querylog.record({ username: a.requester, source: 'approval', connKey: a.connKey, connLabel: conn.label, database: a.database, sql: a.sql, type: querylog.statementType(a.sql), ok: outcome.ok, error: outcome.error ? `${outcome.error} (approved by ${req.user.username})` : null, affectedRows: outcome.affected, durationMs: Date.now() - start });
  const updated = approvals.update(a.id, { status: 'approved', decidedBy: req.user.username, decidedAt: new Date().toISOString(), outcome });
  res.json(approvalView(updated, req.user));
});
app.post('/api/approvals/:id/reject', requireAuth, (req, res) => {
  const found = loadApproval(req, res); if (!found) return;
  const { a, conn } = found;
  if (a.status !== 'pending') return res.status(409).json({ error: `This request is already ${a.status}` });
  if (a.requester === req.user.username) return res.status(403).json({ error: 'Use "withdraw" for your own request' });
  if (!canManage(req.user, conn)) return res.status(403).json({ error: 'Only the owner of the connection or an admin can reject this' });
  res.json(approvalView(approvals.update(a.id, { status: 'rejected', decidedBy: req.user.username, decidedAt: new Date().toISOString(), reason: String((req.body || {}).reason || '').slice(0, 300) }), req.user));
});
app.post('/api/approvals/:id/withdraw', requireAuth, (req, res) => {
  const found = loadApproval(req, res); if (!found) return;
  const { a } = found;
  if (a.requester !== req.user.username) return res.status(403).json({ error: 'That is not your request' });
  if (a.status !== 'pending') return res.status(409).json({ error: `This request is already ${a.status}` });
  res.json(approvalView(approvals.update(a.id, { status: 'withdrawn', decidedAt: new Date().toISOString() }), req.user));
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
    if (engines.engineOf(conn) !== 'mysql' && (job.type === 'analysis' || job.type === 'backup')) throw engines.unsupported(engines.engineOf(conn), job.type === 'backup' ? 'Scheduled backups are' : 'Analysis is');
    const sc = scopeOf(user, conn);
    if (sc && job.type !== 'health') {
      if (job.database && !scopeLib.dbAllowed(sc, job.database)) throw new Error(`You do not have access to the database ${job.database}`);
      if (job.type === 'analysis' && sc.hideTables.length) throw new Error('Analysis is not available while tables are hidden from you');
      const bad = job.type === 'query' ? scopeLib.checkSql(sc, job.sql, job.database, []) : null;
      if (bad) throw new Error(bad);
    }
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

// ---- Compare two databases / two tables ----
// Both sides must be connections the user can use. Applying needs the permissions on the target, checked
// statement by statement, and the SQL is always recomputed on the server (the browser sends only item ids).
function diffSides(req, res, needTable) {
  const { source, target } = req.body || {};
  const out = [];
  for (const side of [source, target]) {
    const conn = side && store.getConnection(side.key);
    if (!conn || !canUse(req.user, conn)) { res.status(404).json({ error: 'Connection not found' }); return null; }
    if (engines.engineOf(conn) !== 'mysql') { res.status(400).json({ error: engines.unsupported(engines.engineOf(conn), 'Comparing databases is').message }); return null; }
    if (!side.database || (needTable && !side.table)) { res.status(400).json({ error: needTable ? 'Choose a database and a table on both sides' : 'Choose a database on both sides' }); return null; }
    const sc = scopeOf(req.user, conn);
    if (sc && (!scopeLib.dbAllowed(sc, side.database) || (needTable ? scopeLib.tableHidden(sc, side.database, side.table) : sc.hideTables.length))) {
      res.status(403).json({ error: needTable ? 'That table is not available to you' : 'Comparing structures is not available while databases or tables are limited for you' }); return null;
    }
    out.push({ key: side.key, database: String(side.database), table: side.table ? String(side.table) : undefined, conn });
  }
  return out;
}
const diffTarget = (t) => ({ key: t.key, database: t.database, table: t.table });

app.post('/api/diff/schema', requireAuth, async (req, res) => {
  const sides = diffSides(req, res, false);
  if (!sides) return;
  try {
    const items = await diff.diffSchema(diffTarget(sides[0]), diffTarget(sides[1]), { drops: req.body.drops !== false });
    res.json({ items, script: diff.script(Array.isArray(req.body.ids) ? items.filter((i) => req.body.ids.includes(i.id)) : items.filter((i) => !i.destructive)), fullScript: diff.script(items), summary: { total: items.length, destructive: items.filter((i) => i.destructive).length } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/diff/schema/apply', requireAuth, async (req, res) => {
  const sides = diffSides(req, res, false);
  if (!sides) return;
  const { ids } = req.body || {};
  const start = Date.now();
  try {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one change');
    const items = (await diff.diffSchema(diffTarget(sides[0]), diffTarget(sides[1]), { drops: req.body.drops !== false })).filter((i) => ids.includes(i.id));
    if (!items.length) throw new Error('Those changes are gone — the databases changed. Compare again.');
    const sqlText = diff.script(items);
    const r = await diff.applySchema(diffTarget(sides[1]), items, { allowed: restrictionsFor(req.user, sides[1].conn) });
    querylog.record({ username: req.user.username, source: 'schema-diff', connKey: sides[1].key, connLabel: sides[1].conn.label, database: sides[1].database, sql: sqlText, type: 'DDL', ok: true, durationMs: Date.now() - start });
    res.json(r);
  } catch (err) {
    querylog.record({ username: req.user.username, source: 'schema-diff', connKey: sides[1].key, connLabel: sides[1].conn.label, database: sides[1].database, sql: '(schema diff apply)', type: 'DDL', ok: false, error: err.message, durationMs: Date.now() - start });
    res.status(400).json({ error: err.message });
  }
});
const dataOptions = (b) => ({ keyColumns: b.keyColumns, where: typeof b.where === 'string' && b.where.trim() ? b.where.trim() : undefined, columns: b.columns });
async function dataWhereError(req, sides) {
  const w = dataOptions(req.body).where;
  if (!w) return null;
  for (const sd of sides) { const e = await scopeError(req.user, sd.conn, w, sd.database); if (e) return e; }
  return null;
}
app.post('/api/diff/data', requireAuth, async (req, res) => {
  const sides = diffSides(req, res, true);
  if (!sides) return;
  try {
    const bad = await dataWhereError(req, sides);
    if (bad) throw new Error(bad);
    const r = await diff.diffData(diffTarget(sides[0]), diffTarget(sides[1]), dataOptions(req.body));
    const { statements, ...rest } = r;
    res.json({ ...rest, script: [...statements.insert, ...statements.update, ...statements.delete].map((x) => x + ';').join('\n') });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/diff/data/apply', requireAuth, async (req, res) => {
  const sides = diffSides(req, res, true);
  if (!sides) return;
  const start = Date.now();
  try {
    const bad = await dataWhereError(req, sides);
    if (bad) throw new Error(bad);
    const actions = req.body.actions || {};
    const d = await diff.diffData(diffTarget(sides[0]), diffTarget(sides[1]), dataOptions(req.body));
    const r = await diff.applyData(diffTarget(sides[1]), d, actions, { allowed: restrictionsFor(req.user, sides[1].conn) });
    querylog.record({ username: req.user.username, source: 'data-diff', connKey: sides[1].key, connLabel: sides[1].conn.label, database: sides[1].database, sql: `SYNC ${sides[1].table} (${['insert', 'update', 'delete'].filter((k) => actions[k]).join(', ')})`, type: 'MULTI', ok: true, affectedRows: r.executed, durationMs: Date.now() - start });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
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
