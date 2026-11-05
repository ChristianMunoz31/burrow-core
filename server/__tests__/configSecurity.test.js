// Startup security decisions: non-loopback bind needs auth, AUTH_SECRET length.
import { describe, it, expect } from 'vitest';
import { checkStartupSecurity, isLoopbackHost } from '../config.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '::', '192.168.1.20', 'burrow.lan'])('%s is not loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('checkStartupSecurity', () => {
  const SECRET = 'x'.repeat(32);

  it('starts on loopback with no auth configured', () => {
    expect(checkStartupSecurity({})).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('refuses a non-loopback bind without APP_PASSWORD + AUTH_SECRET', () => {
    const r = checkStartupSecurity({ BURROW_HOST: '0.0.0.0' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('BURROW_ALLOW_INSECURE_LAN=1');
    expect(checkStartupSecurity({ BURROW_HOST: '0.0.0.0', APP_PASSWORD: 'pw' }).ok).toBe(false);
  });

  it('starts a non-loopback bind with auth configured', () => {
    expect(checkStartupSecurity({ BURROW_HOST: '0.0.0.0', APP_PASSWORD: 'pw', AUTH_SECRET: SECRET })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('BURROW_ALLOW_INSECURE_LAN=1 starts with a loud warning', () => {
    const r = checkStartupSecurity({ BURROW_HOST: '0.0.0.0', BURROW_ALLOW_INSECURE_LAN: '1' });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/^WARNING/);
  });

  it('refuses a short AUTH_SECRET when APP_PASSWORD is set', () => {
    const r = checkStartupSecurity({ APP_PASSWORD: 'pw', AUTH_SECRET: 'short' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('AUTH_SECRET');
    expect(checkStartupSecurity({ APP_PASSWORD: 'pw' }).ok).toBe(false);
    expect(checkStartupSecurity({ APP_PASSWORD: 'pw', AUTH_SECRET: 'y'.repeat(31) }).ok).toBe(false);
    expect(checkStartupSecurity({ APP_PASSWORD: 'pw', AUTH_SECRET: SECRET }).ok).toBe(true);
  });

  it('a short AUTH_SECRET alone (no APP_PASSWORD) is not an error', () => {
    expect(checkStartupSecurity({ AUTH_SECRET: 'short' }).ok).toBe(true);
  });
});
