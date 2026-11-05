// SSRF guard for the cloud AI endpoint. The base URL is user-supplied, so it must never
// reach this machine, a private network or a cloud metadata address.
//   - validateCloudBaseUrl (settings.js) rejects literal private IPs and local-looking names
//     when the URL is saved.
//   - guardedLookup runs at connect time on the cloud https agent, so a public-looking name
//     that resolves to a private address (DNS rebinding, a hosts-file entry) is refused too.
//   - redirects are already refused by the transport (llmClient.js).
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
const V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [addr, prefix] of V4) blocked.addSubnet(addr, prefix, 'ipv4');
const V6 = [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96], // NAT64 (the embedded IPv4 is decoded and checked too)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['fec0::', 10], // deprecated site-local
  ['2001:db8::', 32],
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
];
for (const [addr, prefix] of V6) blocked.addSubnet(addr, prefix, 'ipv6');

const stripBrackets = (s) => String(s).replace(/^\[/, '').replace(/\]$/, '');

/** The 8 sixteen-bit groups of an IPv6 literal (handles `::` and a trailing dotted IPv4), else null. */
function ipv6Groups(addr) {
  let text = addr.toLowerCase();
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [o1, o2, o3, o4] = dotted.slice(2).map(Number);
    if ([o1, o2, o3, o4].some((n) => n > 255)) return null;
    text = `${dotted[1]}${((o1 << 8) | o2).toString(16)}:${((o3 << 8) | o4).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...new Array(fill).fill('0'), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 embedded in an IPv6 address that merely carries one: IPv4-mapped (::ffff:0:0/96),
 * SIIT IPv4-translated (::ffff:0:0:0/96) or NAT64 (64:ff9b::/96), in any textual form. Else null.
 */
function embeddedIPv4(addr) {
  const g = ipv6Groups(addr);
  if (!g) return null;
  const zero = (from, to) => g.slice(from, to).every((n) => n === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4From(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4From(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4From(g[6], g[7]);
  return null;
}

/**
 * Whether an IP literal is a public, routable unicast address. Anything that is not an IP
 * literal returns false (fail closed).
 * @param {unknown} address
 * @returns {boolean}
 */
export function isPublicIp(address) {
  if (typeof address !== 'string') return false;
  const addr = stripBrackets(address.trim()).split('%')[0];
  const family = net.isIP(addr);
  if (family === 4) return !blocked.check(addr, 'ipv4');
  if (family === 6) {
    const embedded = embeddedIPv4(addr);
    if (embedded && (!net.isIPv4(embedded) || blocked.check(embedded, 'ipv4'))) return false;
    // An embedded public IPv4 still has to clear the IPv6 ranges (NAT64 is blocked as a whole).
    if (embedded && !addr.toLowerCase().startsWith('64:ff9b:')) return true;
    return !blocked.check(addr, 'ipv6');
  }
  return false;
}

/**
 * Whether a hostname is local-looking: localhost, *.localhost, *.internal, *.local, *.lan,
 * *.home.arpa, or a single label (no dot). An IP literal is judged by isPublicIp instead.
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string') return true;
  const h = stripBrackets(hostname.trim().toLowerCase()).replace(/\.+$/, '');
  if (!h) return true;
  if (net.isIP(h)) return !isPublicIp(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(?:internal|local|lan)$/.test(h) || h.endsWith('.home.arpa') || h === 'home.arpa') return true;
  return !h.includes('.');
}

let dnsLookup = dns.lookup;

/**
 * Test hook: replace the resolver used by guardedLookup (same signature as dns.lookup).
 * Call with no argument to restore the real one.
 * @param {typeof dns.lookup} [fn]
 */
export function __setCloudDnsLookupForTests(fn) {
  dnsLookup = typeof fn === 'function' ? fn : dns.lookup;
}

const privateError = (hostname) =>
  Object.assign(new Error(`Cloud AI host ${hostname} is not a public address`), { code: 'ECLOUDPRIVATE' });

/**
 * dns.lookup replacement for the cloud agent: resolves every answer and refuses the
 * connection when any of them is not public.
 * @param {string} hostname
 * @param {object | Function} options
 * @param {Function} [callback]
 */
export function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' || !options ? {} : options;
  if (isBlockedHostname(hostname)) {
    cb(privateError(hostname));
    return;
  }
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      cb(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((a) => !isPublicIp(a?.address))) {
      cb(privateError(hostname));
      return;
    }
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

let agent = null;

/** The shared https agent for cloud AI calls (keep-alive, guarded DNS lookup). */
export function cloudHttpsAgent() {
  agent ??= new https.Agent({ keepAlive: true, lookup: guardedLookup });
  return agent;
}
