// PM2 ecosystem file. Copy to ecosystem.config.js and start with:
//   pm2 start ecosystem.config.js
//
// Cluster mode is supported with any number of instances: sessions, data
// files and the query log are shared through the data directory, and
// Update & Restart reloads every instance one at a time.
module.exports = {
  apps : [{
    name: 'dbConsole',
    script: 'server.js',
    instances : '1',          // or e.g. 2, 4, 'max' (one per CPU core)
    watch: "app/*",
    max_memory_restart: '1024M',
    exec_mode : "cluster",
    // Zero-downtime reloads: PM2 waits for the new instance to report it is
    // listening before stopping the old one, and gives in-flight requests
    // time to finish on shutdown.
    wait_ready: true,
    listen_timeout: 10000,
    kill_timeout: 5000,
    env: {
        "NODE_ENV": "production"
    }
  }]
};
