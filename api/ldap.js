// api/ldap.js
// Sign in with a directory account (OpenLDAP, Active Directory, FreeIPA, …):
//   1. bind with a read-only service account (or anonymously) and look the user up under baseDn,
//   2. bind as the user's own DN with the password they typed — that is the check.
// An empty password is refused outright (many directories treat "DN + empty password" as an anonymous bind).
//
// Settings (config.js `ldap: {…}` or LDAP_* environment variables):
//   url            LDAP_URL             ldap://dc.example.com:389  or  ldaps://dc.example.com:636
//   startTls       LDAP_STARTTLS        upgrade an ldap:// connection with STARTTLS
//   rejectUnauthorized  LDAP_REJECT_UNAUTHORIZED  verify the server certificate (default true)
//   bindDn / bindPassword  LDAP_BIND_DN / LDAP_BIND_PASSWORD   the service account used for the search
//   baseDn         LDAP_BASE_DN         where to look for users, e.g. ou=people,dc=example,dc=com
//   userFilter     LDAP_USER_FILTER     default (|(uid={username})(sAMAccountName={username})(mail={username}))
//   nameAttr / mailAttr / usernameAttr   cn / mail / uid (or sAMAccountName)
//   adminGroupDn   LDAP_ADMIN_GROUP     members of this group become admins
//   autoCreate     LDAP_AUTO_CREATE     create a local user on first sign-in (default true)
//   defaultRole    LDAP_DEFAULT_ROLE    default user
//   label          LDAP_LABEL

const { Client } = require('ldapts');

function load(config = {}) {
  const c = config.ldap || {};
  const e = process.env;
  const bool = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|no)$/i.test(String(v)));
  const s = {
    url: e.LDAP_URL || c.url || '',
    startTls: bool(e.LDAP_STARTTLS ?? c.startTls, false),
    rejectUnauthorized: bool(e.LDAP_REJECT_UNAUTHORIZED ?? c.rejectUnauthorized, true),
    bindDn: e.LDAP_BIND_DN || c.bindDn || '',
    bindPassword: e.LDAP_BIND_PASSWORD || c.bindPassword || '',
    baseDn: e.LDAP_BASE_DN || c.baseDn || '',
    userFilter: e.LDAP_USER_FILTER || c.userFilter || '(|(uid={username})(sAMAccountName={username})(mail={username}))',
    usernameAttr: e.LDAP_USERNAME_ATTR || c.usernameAttr || '',
    nameAttr: e.LDAP_NAME_ATTR || c.nameAttr || 'cn',
    mailAttr: e.LDAP_MAIL_ATTR || c.mailAttr || 'mail',
    adminGroupDn: e.LDAP_ADMIN_GROUP || c.adminGroupDn || '',
    autoCreate: bool(e.LDAP_AUTO_CREATE ?? c.autoCreate, true),
    defaultRole: e.LDAP_DEFAULT_ROLE || c.defaultRole || 'user',
    label: e.LDAP_LABEL || c.label || 'directory'
  };
  s.enabled = Boolean(s.url && s.baseDn);
  return s;
}

// RFC 4515 escaping, so a user name can never change the meaning of the filter.
const escapeFilter = (v) => String(v).replace(/[\\*()\0]/g, (ch) => '\\' + ch.charCodeAt(0).toString(16).padStart(2, '0'));

// Attribute names are case-insensitive in LDAP; servers differ in the case they answer with.
const attr = (entry, name) => {
  const keys = Object.keys(entry).filter((x) => x.toLowerCase() === String(name).toLowerCase());
  const full = keys.find((k) => [].concat(entry[k]).some((v) => v !== '' && v !== undefined && v !== null));
  return full !== undefined ? entry[full] : (keys.length ? entry[keys[0]] : undefined);
};
const first = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => { const x = first(v); return x === undefined || x === null ? '' : Buffer.isBuffer(x) ? x.toString('utf8') : String(x); };

function create(s) {
  const open = async () => {
    // tlsOptions only for ldaps:// — given for a plain ldap:// URL the library tries TLS on the first byte
    const client = new Client({ url: s.url, timeout: 10000, connectTimeout: 10000, ...(/^ldaps:/i.test(s.url) ? { tlsOptions: { rejectUnauthorized: s.rejectUnauthorized } } : {}) });
    if (s.startTls) await client.startTLS({ rejectUnauthorized: s.rejectUnauthorized });
    return client;
  };

  return {
    // → { dn, username, name, email, admin } for a correct username + password, null for a wrong one; throws for a broken setup.
    async authenticate(username, password) {
      const name = String(username || '').trim();
      if (!name || !password || name.length > 128) return null;
      const search = await open();
      let entry;
      try {
        await search.bind(s.bindDn, s.bindPassword);
        const attrs = [...new Set(['dn', s.nameAttr, s.mailAttr, 'uid', 'sAMAccountName', 'memberOf', s.usernameAttr].filter(Boolean))];
        const { searchEntries } = await search.search(s.baseDn, { scope: 'sub', filter: s.userFilter.replace(/\{username\}/g, escapeFilter(name)), attributes: attrs, sizeLimit: 2 });
        if (searchEntries.length !== 1) return null; // none, or ambiguous
        entry = searchEntries[0];
        let admin = false;
        if (s.adminGroupDn) {
          const groups = [].concat(attr(entry, 'memberOf') || []).map((g) => text(g).toLowerCase());
          admin = groups.includes(s.adminGroupDn.toLowerCase());
          if (!admin) {
            const g = await search.search(s.adminGroupDn, { scope: 'base', filter: `(|(member=${escapeFilter(entry.dn)})(uniqueMember=${escapeFilter(entry.dn)}))`, attributes: ['dn'] }).catch(() => ({ searchEntries: [] }));
            admin = g.searchEntries.length > 0;
          }
        }
        const userClient = await open();
        try { await userClient.bind(entry.dn, String(password)); } catch (e) {
          if (e && /InvalidCredentials|49/.test(`${e.name} ${e.code}`)) return null;
          throw e;
        } finally { await userClient.unbind().catch(() => {}); }
        const login = (s.usernameAttr && text(attr(entry, s.usernameAttr))) || text(attr(entry, 'uid')) || text(attr(entry, 'sAMAccountName')) || name;
        return { dn: entry.dn, username: login, name: text(attr(entry, s.nameAttr)) || login, email: text(attr(entry, s.mailAttr)).toLowerCase(), admin };
      } finally { await search.unbind().catch(() => {}); }
    }
  };
}

module.exports = { load, create, escapeFilter };
