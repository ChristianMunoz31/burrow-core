// Runtime config resolvers: listen binding, CORS defaults, trust proxy, scheduler switch.
// Pure functions of an env object; nothing here opens a socket.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  VITE_DEV_PORT,
  formatListenUrl,
  isSchedulerEnabled,
  resolveAllowedOrigins,
  resolveListenConfig,
  resolveTrustProxy,
} from '../config.js';

describe('resolveListenConfig', () => {
  it('binds loopback on port 4321 by default', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(4321);
    expect(resolveListenConfig({})).toEqual({ host: '127.0.0.1', port: 4321 });
  });

  it('reads BURROW_HOST and BURROW_PORT', () => {
    expect(resolveListenConfig({ BURROW_HOST: '0.0.0.0', BURROW_PORT: '8080' })).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('ignores the legacy PORT variable', () => {
    expect(resolveListenConfig({ PORT: '3001' })).toEqual({ host: '127.0.0.1', port: 4321 });
  });

  it.each(['', '0', '65536', 'abc', '12.5', '-1', '80 80'])('falls back to the default port for %j', (raw) => {
    expect(resolveListenConfig({ BURROW_PORT: raw }).port).toBe(4321);
  });

  it('treats a blank host as unset', () => {
    expect(resolveListenConfig({ BURROW_HOST: '   ' }).host).toBe('127.0.0.1');
  });
});

describe('formatListenUrl', () => {
  it('formats loopback, wildcard and IPv6 hosts', () => {
    expect(formatListenUrl({ host: '127.0.0.1', port: 4321 })).toBe('http://127.0.0.1:4321');
    expect(formatListenUrl({ host: '0.0.0.0', port: 4321 })).toBe('http://localhost:4321');
    expect(formatListenUrl({ host: '::1', port: 9 })).toBe('http://[::1]:9');
  });
});

describe('resolveAllowedOrigins', () => {
  it('defaults to loopback origins on the Burrow and Vite dev ports only', () => {
    const origins = resolveAllowedOrigins({});
    expect(origins).toEqual([
      'http://localhost:4321',
      'http://127.0.0.1:4321',
      `http://localhost:${VITE_DEV_PORT}`,
      `http://127.0.0.1:${VITE_DEV_PORT}`,
    ]);
    expect(origins.join(',')).not.toMatch(/vercel|https/i);
  });

  it('follows BURROW_PORT', () => {
    expect(resolveAllowedOrigins({ BURROW_PORT: '9000' })).toContain('http://localhost:9000');
  });

  it('lets ALLOWED_ORIGINS override the defaults completely', () => {
    expect(resolveAllowedOrigins({ ALLOWED_ORIGINS: ' https://a.example , https://b.example ' })).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(resolveAllowedOrigins({ ALLOWED_ORIGINS: ' , ' })).toHaveLength(4);
  });
});

describe('resolveTrustProxy', () => {
  it('is off unless BURROW_TRUST_PROXY=1', () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ BURROW_TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxy({ BURROW_TRUST_PROXY: 'true' })).toBe(false);
    expect(resolveTrustProxy({ BURROW_TRUST_PROXY: '1' })).toBe(1);
  });
});

describe('isSchedulerEnabled', () => {
  it('is on by default and off only for BURROW_SCHEDULER=0', () => {
    expect(isSchedulerEnabled({})).toBe(true);
    expect(isSchedulerEnabled({ BURROW_SCHEDULER: '1' })).toBe(true);
    expect(isSchedulerEnabled({ BURROW_SCHEDULER: '0' })).toBe(false);
  });
});
