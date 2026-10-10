// api/access.js
// Who may use and manage a connection. Shared by the HTTP routes and the job scheduler
// (a scheduled job runs with its owner's permissions).

const perms = require('./permissions');

function isAdmin(user) {
  return user && user.role === 'admin';
}

function canManage(user, conn) {
  return isAdmin(user) || conn.owner === user.username;
}

// What the user may change through this connection: everything for the
// owner and admins, otherwise what it was shared with them (see permissions.js).
function permissionsOf(user, conn) {
  return canManage(user, conn) ? perms.ALL.slice() : perms.sharedPermissions(conn, user.username);
}

// The Set handed to the Query Runner; null means no restrictions.
function restrictionsFor(user, conn) {
  const p = permissionsOf(user, conn);
  return p.length === perms.ALL.length ? null : new Set(p);
}

function canUse(user, conn) {
  const shared = conn.sharedWith || [];
  return canManage(user, conn) || shared.includes('*') || shared.includes(user.username);
}

module.exports = { isAdmin, canManage, permissionsOf, restrictionsFor, canUse };
