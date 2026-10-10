// api/netguard.js
// IP allow-list: only requests from the listed addresses / networks reach the
// app (everything else gets 403). Configure with ALLOWED_IPS (comma separated)
// or `allowedIps` in config.js:  ['10.0.0.0/8', '203.0.113.5', '2001:db8::/32'].
// Behind a reverse proxy set TRUST_PROXY=1 so the real client address is used.

const net = require('net');

function normalize(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

function create(entries) {
  const list = (Array.isArray(entries) ? entries : String(entries || '').split(','))
    .map((e) => String(e).trim()).filter(Boolean);
  const bl = new net.BlockList();
  for (const e of list) {
    const [addr, prefix] = e.split('/');
    const a = normalize(addr);
    const family = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
    if (!family) throw new Error(`Invalid address in the IP allow-list: ${e}`);
    if (prefix === undefined) bl.addAddress(a, family);
    else {
      const n = Number(prefix);
      if (!Number.isInteger(n) || n < 0 || n > (family === 'ipv4' ? 32 : 128)) throw new Error(`Invalid network prefix in the IP allow-list: ${e}`);
      bl.addSubnet(a, n, family);
    }
  }
  return {
    active: list.length > 0,
    entries: list,
    allows(ip) {
      if (!list.length) return true;
      const a = normalize(ip);
      const family = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
      return family ? bl.check(a, family) : false;
    }
  };
}

module.exports = { create };
