// Test-only preload for the e2e server process (`node --import <this file> server.js`).
// Worker threads inherit the preload through execArgv.
//
// It records, and blocks, every outbound connection attempt:
//   - a non-loopback address or any DNS name other than localhost: logged as `connect` or `dns`
//     and failed with ENETBLOCKED (nothing leaves the machine, even if a bug tries);
//   - loopback ports 11434 (the real Ollama), 4321 and 5174 (the owner's dev servers): logged as
//     `loopback-reserved` and failed with ECONNREFUSED. This simulates "no Ollama installed"
//     deterministically, even on a dev box that runs one. It does not count as outbound.
// The log is JSON lines appended to BURROW_E2E_NETLOG (a file outside the data dir).
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';

const LOG_FILE = process.env.BURROW_E2E_NETLOG || '';
const RESERVED_PORTS = new Set([11434, 4321, 5174]);

const stripBrackets = (h) => String(h).replace(/^\[|\]$/g, '');
const isLoopbackName = (h) => {
  const host = stripBrackets(h).toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    host === '::ffff:127.0.0.1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
};

function record(entry) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is best effort; blocking still happens.
  }
}

function blockedError(code, host, port) {
  const err = new Error(`${code}: blocked by the e2e network recorder (${host}${port ? `:${port}` : ''})`);
  err.code = code;
  return err;
}

// net.Socket#connect(options | port, host?, cb? | path, cb?) -> { host, port, path }.
function target(args) {
  // net.createConnection passes Node's normalized args array ([options, cb]).
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    return { host: first.host ?? 'localhost', port: Number(first.port), path: first.path };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first), path: undefined };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const { host, port, path } = target(args);
  if (path) return realConnect.apply(this, args);
  if (!isLoopbackName(host)) {
    const literal = net.isIP(stripBrackets(host)) !== 0;
    record({ kind: literal ? 'connect' : 'dns', host: String(host), port });
    process.nextTick(() => this.destroy(blockedError('ENETBLOCKED', host, port)));
    return this;
  }
  if (RESERVED_PORTS.has(port)) {
    record({ kind: 'loopback-reserved', host: String(host), port });
    process.nextTick(() => this.destroy(blockedError('ECONNREFUSED', host, port)));
    return this;
  }
  return realConnect.apply(this, args);
};

const needsBlock = (hostname) =>
  typeof hostname === 'string' && hostname !== '' && !isLoopbackName(hostname) && net.isIP(hostname) === 0;

const realLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  if (needsBlock(hostname)) {
    record({ kind: 'dns', host: hostname });
    const cb = rest.find((r) => typeof r === 'function');
    if (cb) process.nextTick(cb, blockedError('ENETBLOCKED', hostname));
    return {};
  }
  return realLookup.call(this, hostname, ...rest);
};

const realPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function patchedPromisesLookup(hostname, ...rest) {
  if (needsBlock(hostname)) {
    record({ kind: 'dns', host: hostname });
    throw blockedError('ENETBLOCKED', hostname);
  }
  return realPromisesLookup.call(this, hostname, ...rest);
};
