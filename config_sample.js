// config.js
// App-level settings. Actual database connections are managed at runtime
// through the UI and persisted in data/connections.json (see store.js) —
// the "databases" array below is only used to SEED that file the very
// first time the app runs (if data/connections.json doesn't exist yet).

module.exports = {
  // --- First admin account ---
  // Only used the first time the app starts, to create the first admin in
  // data/users.json. After that, manage users from the Users screen.
  appAuth: {
    username: process.env.APP_USER || 'admin',
    password: process.env.APP_PASS || 'admin123!'
  },

  // --- Where runtime data lives (default ./data). Also settable with the
  // DATA_DIR environment variable. All PM2 instances must share it. ---
  // dataDir: './data',

  // --- Set to 1 behind a reverse proxy (or use TRUST_PROXY=1) so client IPs
  // and HTTPS are read from X-Forwarded-* headers. ---
  // trustProxy: 1,

  // --- Session secret (used to sign the session cookie) ---
  sessionSecret: process.env.SESSION_SECRET || 'replace-this-with-a-random-string',

  // --- Optional first-run seed data (edit or delete freely; after the
  // first run, use the "Connections" tab in the UI instead) ---
  databases: [
    {
      key: 'db1',
      label: 'Local DB',
      host: process.env.DB1_HOST || 'localhost',
      port: Number(process.env.DB1_PORT || 3306),
      user: process.env.DB1_USER || 'root',
      password: process.env.DB1_PASSWORD || '',
      database: process.env.DB1_NAME || 'db1'
    }
  ]
};
