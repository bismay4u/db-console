// api/appconfig.js
// Loads the app's settings. In order: the file named by CONFIG_PATH, then
// ./config.js, then ./config_sample.js (so a fresh clone, a container or a CI
// run starts without anyone having to create config.js first).

const path = require('path');

function load() {
  if (process.env.CONFIG_PATH) return require(path.resolve(process.env.CONFIG_PATH));
  try {
    return require('../config');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !/config['"]?$|[\\/]config(\.js)?['"]/.test(String(e.message).split('\n')[0])) throw e;
    return require('../config_sample');
  }
}

module.exports = load();
