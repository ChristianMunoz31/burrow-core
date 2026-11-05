// DNS-rebinding Host allowlist, Origin vs Host checks, malformed cookie tolerance.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createHostGuard, isHostAllowed, isSameOrigin, parseHostPort, resolveHostPolicy } from '../hostGuard.js';

vi.mock('../../loadEnv.js', () => ({}));

describe('parseHostPort', () => {
  it.each([
    ['localhost:4321', { hostname: 'localhost', port: 4321 }],
    ['LOCALHOST', { hostname: 'localhost', port: null }],
    ['[::1]:4321', { hostname: '[::1]', port: 4321 }],
    ['[::1]', { hostname: '[::1]', port: null }],
  ])('parses %s', (input, expected) => {
    expect(parseHostPort(input)).toEqual(expected);
  });

  it.each(['', 'a b', 'evil.com/x', 'a@b', 'a:b', 'a:1:2', 'a:99999', '[::1', undefined])('rejects %j', (input) => {
    expect(parseHostPort(input)).toBeNull();
  });
});

describe('isHostAllowed', () => {
  const policy = resolveHostPolicy({});

  it.each(['localhost:4321', '127.0.0.1:4321', '[::1]:4321', 'localhost:5174', '127.0.0.1:5174', 'localhost'])(
    'accepts loopback Host %s',
    (h) => expect(isHostAllowed(h, policy)).toBe(true),
  );

  it.each(['evil.example.com', 'evil.example.com:4321', 'localhost.evil.com:4321', '192.168.1.20:4321', '', undefined])(
    'rejects rebinding Host %j',
    (h) => expect(isHostAllowed(h, policy)).toBe(false),
  );

  it('BURROW_ALLOWED_HOSTS extends the list (host and host:port)', () => {
    const p = resolveHostPolicy({ BURROW_ALLOWED_HOSTS: 'burrow.lan, nas.local:9000' });
    expect(isHostAllowed('burrow.lan', p)).toBe(true);
    expect(isHostAllowed('burrow.lan:4321', p)).toBe(true);
    expect(isHostAllowed('burrow.lan:8080', p)).toBe(false);
    expect(isHostAllowed('nas.local:9000', p)).toBe(true);
    expect(isHostAllowed('nas.local:9001', p)).toBe(false);
    expect(isHostAllowed('evil.example.com', p)).toBe(false);
  });

  it('allows a non-loopback BURROW_HOST', () => {
    const p = resolveHostPolicy({ BURROW_HOST: '192.168.1.20', BURROW_PORT: '4321' });
    expect(isHostAllowed('192.168.1.20:4321', p)).toBe(true);
    expect(isHostAllowed('192.168.1.21:4321', p)).toBe(false);
  });

  it('does not allow a wildcard bind address as a Host', () => {
    expect(isHostAllowed('0.0.0.0:4321', resolveHostPolicy({ BURROW_HOST: '0.0.0.0' }))).toBe(false);
  });
});

describe('isSameOrigin', () => {
  const policy = resolveHostPolicy({ BURROW_ALLOWED_HOSTS: 'burrow.lan' });

  it('accepts an Origin equal to an allowed Host', () => {
    expect(isSameOrigin('http://localhost:4321', 'localhost:4321', policy)).toBe(true);
    expect(isSameOrigin('https://burrow.lan', 'burrow.lan', policy)).toBe(true);
  });

  it('rejects when Origin and Host differ', () => {
    expect(isSameOrigin('http://localhost:4321', '127.0.0.1:4321', policy)).toBe(false);
    expect(isSameOrigin('http://localhost:4321', 'localhost:5174', policy)).toBe(false);
  });

  it('rejects an Origin on a non-allowed host even when Host matches it (spoofed Host)', () => {
    expect(isSameOrigin('http://evil.example.com', 'evil.example.com', policy)).toBe(false);
  });

  it('rejects non-http schemes and garbage', () => {
    expect(isSameOrigin('file://localhost', 'localhost', policy)).toBe(false);
    expect(isSameOrigin('not a url', 'localhost', policy)).toBe(false);
    expect(isSameOrigin('null', 'localhost', policy)).toBe(false);
  });
});

describe('createHostGuard', () => {
  it('answers 421 JSON for a disallowed Host, passes allowed ones', () => {
    const guard = createHostGuard({});
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    guard({ headers: { host: 'evil.example.com' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(421);
    expect(res.json).toHaveBeenCalledWith({ error: 'Host not allowed' });
    expect(next).not.toHaveBeenCalled();
    guard({ headers: { host: '127.0.0.1:4321' } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('server wiring', () => {
  let app;
  const saved = { enc: process.env.SECRETS_ENCRYPTION_KEY, hosts: process.env.BURROW_ALLOWED_HOSTS };
  afterAll(() => {
    if (saved.enc === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = saved.enc;
    if (saved.hosts === undefined) delete process.env.BURROW_ALLOWED_HOSTS;
    else process.env.BURROW_ALLOWED_HOSTS = saved.hosts;
  });
  beforeAll(async () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.APP_PASSWORD;
    delete process.env.AUTH_SECRET;
    delete process.env.ALLOWED_ORIGINS;
    process.env.BURROW_ALLOWED_HOSTS = 'burrow.lan';
    app = (await import('../../server.js')).default;
  });

  it('rejects a rebinding Host with 421 before anything else', async () => {
    const res = await request(app).get('/api/auth/status').set('Host', 'evil.example.com:4321');
    expect(res.status).toBe(421);
    expect(res.body).toEqual({ error: 'Host not allowed' });
  });

  it('rejects a rebinding Host even with a matching Origin', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('Host', 'evil.example.com')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(421);
  });

  it('accepts loopback Hosts', async () => {
    for (const host of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321']) {
      const res = await request(app).get('/api/auth/status').set('Host', host);
      expect(res.status).toBe(200);
    }
  });

  it('accepts hosts added through BURROW_ALLOWED_HOSTS (same-origin too)', async () => {
    const res = await request(app).get('/api/auth/status').set('Host', 'burrow.lan').set('Origin', 'http://burrow.lan');
    expect(res.status).toBe(200);
  });

  it('rejects an Origin that does not match the Host', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('Host', 'burrow.lan')
      .set('Origin', 'http://localhost:3001');
    expect(res.status).toBe(403);
  });

  it('accepts the Vite dev origin', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('Host', 'localhost:4321')
      .set('Origin', 'http://localhost:5174');
    expect(res.status).toBe(200);
  });

  it('ignores a malformed percent-encoded cookie instead of failing', async () => {
    const res = await request(app).get('/api/auth/status').set('Cookie', 'burrow_session=%E0%A4%A; other=%zz; ok=1');
    expect(res.status).toBe(200);
  });
});
