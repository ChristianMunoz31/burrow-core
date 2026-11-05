// Desktop CSP: inline-script hashes and header presence (desktop mode only).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { buildCsp } from '../desktop/csp.js';

vi.mock('../../loadEnv.js', () => ({}));

const INLINE = "(function(){var a=1;})();";
const HTML = `<!doctype html><html><head>
<script>${INLINE}</script>
<script type="module" src="/assets/x.js"></script>
<script>   </script>
</head><body></body></html>`;
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

describe('buildCsp', () => {
  it('hashes each inline script and skips external and empty ones', () => {
    const csp = buildCsp(HTML);
    expect(csp).toContain(`script-src 'self' ${sha(INLINE)};`);
    expect(csp.match(/sha256-/g)).toHaveLength(1);
  });

  it('carries the full policy', () => {
    const csp = buildCsp(HTML);
    for (const d of [
      "default-src 'self'",
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(d);
    }
  });

  it('has no script hashes for a page without inline scripts', () => {
    expect(buildCsp('<html></html>')).toContain("script-src 'self';");
  });
});

describe('CSP headers on responses', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-csp-dist-'));
  const saved = { dist: process.env.BURROW_DIST_DIR, desktop: process.env.BURROW_DESKTOP };
  afterAll(() => {
    fs.rmSync(dist, { recursive: true, force: true });
    for (const [k, v] of [['BURROW_DIST_DIR', saved.dist], ['BURROW_DESKTOP', saved.desktop]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeAll(() => {
    fs.writeFileSync(path.join(dist, 'index.html'), HTML);
    fs.writeFileSync(path.join(dist, 'app.js'), 'x');
    process.env.BURROW_DIST_DIR = dist;
  });

  it('desktop mode: every response carries the CSP and hardening headers', async () => {
    vi.resetModules();
    process.env.BURROW_DESKTOP = '1';
    const app = (await import('../../server.js')).default;
    const auth = await import('../desktop/auth.js');
    auth.initDesktopAuth(Buffer.alloc(32, 7));
    const cookie = `burrow_desktop=${auth.cookieValue()}`;
    const expectHardened = (res) => {
      expect(res.headers['content-security-policy']).toContain(sha(INLINE));
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    };

    // SPA fallback paths, including ones that look like files, return index.html with the CSP.
    for (const p of ['/', '/budget', '/a.b', '/foo.html', '/notes/v1.2', '/x.json']) {
      const res = await request(app).get(p).set('Cookie', cookie);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain(INLINE);
      expectHardened(res);
    }
    const unauth = await request(app).get('/');
    expect(unauth.status).toBe(401);
    expectHardened(unauth);

    const asset = await request(app).get('/app.js').set('Cookie', cookie);
    expect(asset.status).toBe(200);
    expectHardened(asset);
    const api = await request(app).get('/api/auth/status').set('Cookie', cookie);
    expect(api.status).toBe(200);
    expectHardened(api);
    const denied = await request(app).get('/api/auth/status');
    expect(denied.status).toBe(401);
    expectHardened(denied);
  });

  it('web mode: no CSP header', async () => {
    vi.resetModules();
    delete process.env.BURROW_DESKTOP;
    const app = (await import('../../server.js')).default;
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });
});
