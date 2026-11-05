// Self-test for the test network guard (server/__tests__/setup/networkGuard.js).
// Uses real node-fetch (no mock) on purpose: the guard must stop the connection before it leaves.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fetch from 'node-fetch';
import { allowLoopbackPort, portFromOllamaHost, takeNetworkViolations } from './setup/networkGuard.js';

// A pooled keep-alive socket from an earlier allowed connection would skip Socket#connect; use fresh agents.
const FRESH = { agent: new http.Agent({ keepAlive: false }) };

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => server.close(resolve));

describe('networkGuard', () => {
  it('blocks node-fetch to loopback Ollama port 11434 and records it', async () => {
    await expect(fetch('http://127.0.0.1:11434/api/version', FRESH)).rejects.toMatchObject({ code: 'ENETBLOCKED' });
    const v = takeNetworkViolations();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ host: '127.0.0.1', port: 11434, via: 'socket' });
  });

  it('blocks the owner live ports 4321 and 5174 on localhost and ::1 too', async () => {
    for (const url of ['http://localhost:4321/', 'http://127.0.0.1:5174/', 'http://[::1]:4321/']) {
      await expect(fetch(url)).rejects.toMatchObject({ code: 'ENETBLOCKED' });
    }
    expect(takeNetworkViolations()).toHaveLength(3);
  });

  it('blocks node-fetch to a remote host', async () => {
    await expect(fetch('http://192.0.2.1/')).rejects.toMatchObject({ code: 'ENETBLOCKED' });
    const v = takeNetworkViolations();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ host: '192.0.2.1', port: 80, via: 'socket' });
  });

  it('blocks global fetch to blocked targets immediately and records it', async () => {
    await expect(globalThis.fetch('http://127.0.0.1:11434/api/tags')).rejects.toMatchObject({ code: 'ENETBLOCKED' });
    await expect(globalThis.fetch('https://example.org/')).rejects.toThrow(/blocked outbound connection/);
    const v = takeNetworkViolations();
    expect(v.map((x) => x.via)).toEqual(['fetch', 'fetch']);
    expect(v[1]).toMatchObject({ host: 'example.org', port: 443 });
  });

  it('passes relative URLs and allowed global fetch targets through to the original', async () => {
    await expect(globalThis.fetch('/relative/path')).rejects.toThrow();
    expect(takeNetworkViolations()).toEqual([]);
    const server = http.createServer((_req, res) => res.end('ok'));
    const port = await listen(server);
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      await close(server);
    }
    expect(takeNetworkViolations()).toEqual([]);
  });

  it('allows a real loopback server on an ephemeral port', async () => {
    const server = http.createServer((_req, res) => res.end('hello'));
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('hello');
    } finally {
      await close(server);
    }
    expect(takeNetworkViolations()).toEqual([]);
  });

  it('allows IPC/path targets', async () => {
    const sock = new net.Socket();
    sock.on('error', () => {});
    sock.connect({ path: process.platform === 'win32' ? '\\\\.\\pipe\\burrow-guard-selftest-missing' : '/tmp/burrow-guard-selftest-missing' });
    await new Promise((resolve) => sock.once('close', resolve));
    expect(takeNetworkViolations()).toEqual([]);
  });

  it('allowLoopbackPort permits a fixed port and undo restores the block', async () => {
    const undo = allowLoopbackPort(11434);
    try {
      // Allowed now: the connection is attempted (refused or answered), not blocked by the guard.
      const attempt = await fetch('http://127.0.0.1:11434/api/version', FRESH).then(
        () => 'reached',
        (e) => e.code,
      );
      expect(attempt).not.toBe('ENETBLOCKED');
      expect(takeNetworkViolations()).toEqual([]);
      undo();
      await expect(fetch('http://127.0.0.1:11434/api/version', FRESH)).rejects.toMatchObject({ code: 'ENETBLOCKED' });
      expect(takeNetworkViolations()).toHaveLength(1);
    } finally {
      undo();
    }
  });

  it('the allow list is reset automatically after each test', async () => {
    await expect(fetch('http://127.0.0.1:11434/', FRESH)).rejects.toMatchObject({ code: 'ENETBLOCKED' });
    expect(takeNetworkViolations()).toHaveLength(1);
  });

  it('takeNetworkViolations drains', async () => {
    await fetch('http://192.0.2.7/').catch(() => {});
    expect(takeNetworkViolations()).toHaveLength(1);
    expect(takeNetworkViolations()).toEqual([]);
  });
});

describe('portFromOllamaHost', () => {
  it('parses host:port, URL and bracketed IPv6 forms', () => {
    expect(portFromOllamaHost('127.0.0.1:11500')).toBe(11500);
    expect(portFromOllamaHost('http://localhost:9999')).toBe(9999);
    expect(portFromOllamaHost('https://ollama.lan:8443/')).toBe(8443);
    expect(portFromOllamaHost('[::1]:12000')).toBe(12000);
    expect(portFromOllamaHost('  0.0.0.0:11435 ')).toBe(11435);
  });

  it('returns null for unset, blank, portless or unparsable values', () => {
    expect(portFromOllamaHost(undefined)).toBeNull();
    expect(portFromOllamaHost('')).toBeNull();
    expect(portFromOllamaHost('localhost')).toBeNull();
    expect(portFromOllamaHost('http://localhost')).toBeNull();
    expect(portFromOllamaHost('http://:::')).toBeNull();
  });

  it('is blanked for the workers so the developer OLLAMA_HOST cannot steer a test', () => {
    expect(process.env.OLLAMA_HOST ?? '').toBe('');
    expect(process.env.BURROW_NO_DOTENV).toBe('1');
  });
});
