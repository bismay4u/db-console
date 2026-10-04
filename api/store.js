// store.js
// Simple JSON-file-backed store for:
//   - app users (login accounts, roles)
//   - database connections (added/edited/removed from the UI), each owned
//     by a user and optionally shared with other users
//   - saved SQL queries (private to the user who saved them)
//
// Good enough for a small internal admin tool. Every function that changes
// data runs under the data-directory lock (see datadir.js), so several PM2
// cluster workers can share these files safely.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, FILE_MODE, ensureDir, readJson, writeJson, withLock } = require('./datadir');

const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const QUERIES_FILE = path.join(DATA_DIR, 'queries.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const ROLES = ['admin', 'user'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

// Creates any missing data file. Runs on every start, so a fresh install
// (or a deleted file) is regenerated automatically.
function ensureStore() {
  ensureDir();

  if (!fs.existsSync(CONNECTIONS_FILE)) {
    // Seed from config.js on first run, if it has a "databases" array.
    let seed = [];
    try {
      const config = require('../config');
      if (Array.isArray(config.databases)) {
        seed = config.databases.map((d) => ({
          key: d.key,
          label: d.label,
          host: d.host,
          port: d.port,
          user: d.user,
          password: d.password || '',
          database: d.database
        }));
      }
    } catch (e) {
      // no config seed available, that's fine
    }
    writeJson(CONNECTIONS_FILE, seed);
  }

  if (!fs.existsSync(QUERIES_FILE)) {
    writeJson(QUERIES_FILE, []);
  }

  if (!fs.existsSync(USERS_FILE)) {
    // First run with multi-user support: the old single login from
    // config.appAuth becomes the first admin account.
    let username = 'admin';
    let password = 'admin123!';
    try {
      const config = require('../config');
      if (config.appAuth) {
        username = config.appAuth.username || username;
        password = config.appAuth.password || password;
      }
    } catch (e) {
      // no config available, fall back to the defaults above
    }
    writeJson(USERS_FILE, [newUserRecord({ username, password, role: 'admin', displayName: 'Administrator' })]);
  }

  migrateOwnership();

  // Files from older versions were created world-readable; they hold
  // database passwords and password hashes.
  for (const file of [CONNECTIONS_FILE, QUERIES_FILE, USERS_FILE]) {
    try { fs.chmodSync(file, FILE_MODE); } catch (e) { /* e.g. not supported on Windows */ }
  }
}

// Connections and saved queries created before multi-user support have no
// owner; hand them to the first admin so nothing becomes inaccessible.
function migrateOwnership() {
  const admin = listUsers().find((u) => u.role === 'admin');
  if (!admin) return;

  const conns = listConnections();
  let changed = false;
  for (const c of conns) {
    if (!c.owner) { c.owner = admin.username; changed = true; }
    if (!Array.isArray(c.sharedWith)) { c.sharedWith = []; changed = true; }
  }
  if (changed) writeJson(CONNECTIONS_FILE, conns);

  const queries = listQueries();
  changed = false;
  for (const q of queries) {
    if (!q.owner) { q.owner = admin.username; changed = true; }
  }
  if (changed) writeJson(QUERIES_FILE, queries);
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || 'conn';
}

// ---------- Connections ----------

function listConnections() {
  return readJson(CONNECTIONS_FILE);
}

function getConnection(key) {
  return listConnections().find((c) => c.key === key) || null;
}

function createConnection(data) {
  const conns = listConnections();
  let base = slugify(data.label || 'conn');
  let key = base;
  let i = 2;
  while (conns.some((c) => c.key === key)) {
    key = `${base}-${i++}`;
  }

  const conn = {
    key,
    label: data.label,
    host: data.host,
    port: Number(data.port) || 3306,
    user: data.user,
    password: data.password || '',
    database: data.database,
    owner: data.owner,
    sharedWith: []
  };

  conns.push(conn);
  writeJson(CONNECTIONS_FILE, conns);
  return conn;
}

function updateConnection(key, data) {
  const conns = listConnections();
  const idx = conns.findIndex((c) => c.key === key);
  if (idx === -1) return null;

  const existing = conns[idx];
  const updated = {
    ...existing,
    label: data.label ?? existing.label,
    host: data.host ?? existing.host,
    port: data.port !== undefined ? Number(data.port) : existing.port,
    user: data.user ?? existing.user,
    // Keep existing password if a blank one is submitted (means "unchanged")
    password: data.password ? data.password : existing.password,
    database: data.database ?? existing.database
  };

  conns[idx] = updated;
  writeJson(CONNECTIONS_FILE, conns);
  return updated;
}

// sharedWith: array of usernames, or ['*'] for every user.
function setConnectionSharing(key, sharedWith) {
  const conns = listConnections();
  const idx = conns.findIndex((c) => c.key === key);
  if (idx === -1) return null;

  conns[idx] = { ...conns[idx], sharedWith: normalizeSharedWith(sharedWith, conns[idx].owner) };
  writeJson(CONNECTIONS_FILE, conns);
  return conns[idx];
}

function normalizeSharedWith(list, owner) {
  if (!Array.isArray(list)) return [];
  if (list.includes('*')) return ['*'];
  const known = new Set(listUsers().map((u) => u.username));
  return [...new Set(list.map(String))].filter((u) => u !== owner && known.has(u));
}

function deleteConnection(key) {
  const conns = listConnections();
  const next = conns.filter((c) => c.key !== key);
  const changed = next.length !== conns.length;
  if (changed) writeJson(CONNECTIONS_FILE, next);
  return changed;
}

// ---------- Saved queries ----------

function listQueries(owner) {
  const queries = readJson(QUERIES_FILE);
  return owner ? queries.filter((q) => q.owner === owner) : queries;
}

function createQuery(data) {
  const queries = listQueries();
  const query = {
    id: crypto.randomUUID(),
    name: data.name,
    sql: data.sql,
    owner: data.owner,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  queries.unshift(query);
  writeJson(QUERIES_FILE, queries);
  return query;
}

function updateQuery(id, data, owner) {
  const queries = listQueries();
  const idx = queries.findIndex((q) => q.id === id && q.owner === owner);
  if (idx === -1) return null;

  queries[idx] = {
    ...queries[idx],
    name: data.name ?? queries[idx].name,
    sql: data.sql ?? queries[idx].sql,
    updatedAt: new Date().toISOString()
  };
  writeJson(QUERIES_FILE, queries);
  return queries[idx];
}

function deleteQuery(id, owner) {
  const queries = listQueries();
  const next = queries.filter((q) => !(q.id === id && q.owner === owner));
  const changed = next.length !== queries.length;
  if (changed) writeJson(QUERIES_FILE, next);
  return changed;
}

// ---------- Users ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// Hash used to spend the same time on unknown usernames as on real ones.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password || ''), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function newUserRecord({ username, password, role, displayName }) {
  const now = new Date().toISOString();
  return {
    username,
    displayName: displayName || username,
    role: ROLES.includes(role) ? role : 'user',
    passwordHash: hashPassword(password),
    disabled: false,
    // Bumped whenever a password/role/status change should end existing
    // sessions for this user (checked on every request in server.js).
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };
}

function listUsers() {
  return readJson(USERS_FILE);
}

function getUser(username) {
  return listUsers().find((u) => u.username === username) || null;
}

function validateNewUser({ username, password }) {
  if (!username || !USERNAME_RE.test(username)) {
    return 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore';
  }
  if (!password || String(password).length < 8) return 'Password must be at least 8 characters';
  if (getUser(username)) return 'A user with that username already exists';
  return null;
}

function createUser(data) {
  const users = listUsers();
  const user = newUserRecord(data);
  users.push(user);
  writeJson(USERS_FILE, users);
  return user;
}

// Applies displayName / role / disabled / password changes. Anything that
// changes what the user may do (or how they log in) ends their sessions.
function updateUser(username, data) {
  const users = listUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx === -1) return null;

  const existing = users[idx];
  const updated = { ...existing, updatedAt: new Date().toISOString() };
  let endSessions = false;

  if (data.displayName !== undefined) updated.displayName = String(data.displayName).trim() || username;
  if (data.role !== undefined && ROLES.includes(data.role) && data.role !== existing.role) {
    updated.role = data.role;
    endSessions = true;
  }
  if (data.disabled !== undefined && Boolean(data.disabled) !== Boolean(existing.disabled)) {
    updated.disabled = Boolean(data.disabled);
    endSessions = true;
  }
  if (data.password) {
    updated.passwordHash = hashPassword(data.password);
    endSessions = true;
  }
  if (endSessions) updated.sessionVersion = (existing.sessionVersion || 1) + 1;

  users[idx] = updated;
  writeJson(USERS_FILE, users);
  return updated;
}

function touchLastLogin(username) {
  const users = listUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  writeJson(USERS_FILE, users);
}

// Deletes a user and hands everything they owned to `transferTo`, so no
// connection or saved query is orphaned.
function deleteUser(username, transferTo) {
  const users = listUsers();
  const next = users.filter((u) => u.username !== username);
  if (next.length === users.length) return false;
  writeJson(USERS_FILE, next);

  const conns = listConnections().map((c) => ({
    ...c,
    owner: c.owner === username ? transferTo : c.owner,
    sharedWith: (c.sharedWith || []).filter((u) => u !== username)
  }));
  writeJson(CONNECTIONS_FILE, conns);

  const queries = listQueries().map((q) => (q.owner === username ? { ...q, owner: transferTo } : q));
  writeJson(QUERIES_FILE, queries);
  return true;
}

// Wraps a function that changes data so it runs under the data-dir lock.
const locked = (fn) => (...args) => withLock(() => fn(...args));

module.exports = {
  DATA_DIR,
  ROLES,
  ensureStore: locked(ensureStore),
  listUsers,
  getUser,
  validateNewUser,
  createUser: locked(createUser),
  updateUser: locked(updateUser),
  deleteUser: locked(deleteUser),
  touchLastLogin: locked(touchLastLogin),
  verifyPassword,
  setConnectionSharing: locked(setConnectionSharing),
  listConnections,
  getConnection,
  createConnection: locked(createConnection),
  updateConnection: locked(updateConnection),
  deleteConnection: locked(deleteConnection),
  listQueries,
  createQuery: locked(createQuery),
  updateQuery: locked(updateQuery),
  deleteQuery: locked(deleteQuery)
};
