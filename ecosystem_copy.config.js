module.exports = {
  apps : [{
    name: 'dbConsole',
    script: 'server.js',
    instances : '1',
    watch: "app/*",
    max_memory_restart: '1024M',
    exec_mode : "cluster",
    env: {
        "NODE_ENV": "production"
    }
  }]
};
