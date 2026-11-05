// dist/ is served by the same Express app with an SPA fallback for non-API GETs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerStaticRoutes } from '../staticRoutes.js';

const ENV_SENTINEL = 'SENTINEL_DOTENV_CONTENT';
const GIT_SENTINEL = 'SENTINEL_GIT_HEAD_CONTENT';
const OUTSIDE_SENTINEL = 'SENTINEL_OUTSIDE_DIST_CONTENT';

let root;
let dir;
beforeAll(() => {
  // dist fixture lives one level below root so ../ escapes land on a sentinel file.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-root-'));
  dir = path.join(root, 'dist');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.env'), ENV_SENTINEL);
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), GIT_SENTINEL);
  fs.writeFileSync(path.join(root, 'outside-secret.txt'), OUTSIDE_SENTINEL);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Burrow</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
});
afterAll(() => fs.rmSync(root,{ recursive: true, force: true }));

const build = () => {
  const app = express();
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const enabled = registerStaticRoutes(app, { distDir: dir });
  return { app, enabled };
};

describe('registerStaticRoutes', () => {
  it('is a no-op without dist/index.html', () => {
    const app = express();
    expect(registerStaticRoutes(app, { distDir: path.join(dir, 'missing') })).toBe(false);
  });

  it('serves index.html at / and for client-side routes', async () => {
    const { app, enabled } = build();
    expect(enabled).toBe(true);
    for (const p of ['/', '/todos', '/settings/network']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<title>Burrow</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves real files, with long caching only for fingerprinted assets', async () => {
    const { app } = build();
    const asset = await request(app).get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await request(app).get('/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('never swallows /api: real routes win and unknown API paths are not the SPA', async () => {
    const { app } = build();
    expect((await request(app).get('/api/ping')).body).toEqual({ ok: true });
    const unknown = await request(app).get('/api/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.text).not.toContain('<title>Burrow</title>');
    expect((await request(app).get('/API/nope')).status).toBe(404);
  });

  it('never serves dotfiles or files outside dist, whatever the path encoding', async () => {
    const { app } = build();
    for (const p of ['/.env', '/.git/HEAD']) {
      const res = await request(app).get(p);
      expect(res.text, p).not.toContain(ENV_SENTINEL);
      expect(res.text, p).not.toContain(GIT_SENTINEL);
    }
    const paths = [
      '/%2e%2e/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/..%5c..%5cpackage.json',
      '/%252e%252e/package.json',
      '/index.html%00.js',
      '/%2e%2e/outside-secret.txt',
      '/..%2foutside-secret.txt',
      '/..%5coutside-secret.txt',
    ];
    for (const p of paths) {
      const res = await request(app).get(p);
      expect(res.status, p).not.toBeGreaterThanOrEqual(500);
      expect(res.text ?? '', p).not.toContain(OUTSIDE_SENTINEL);
      expect(res.text ?? '', p).not.toContain('"name": "burrow"');
    }
  });

  it('does not answer /API/x or /api/ with the SPA shell', async () => {
    const { app } = build();
    for (const p of ['/API/x', '/api/']) {
      const res = await request(app).get(p);
      expect(res.text, p).not.toContain('<title>Burrow</title>');
    }
  });

  it('does not answer non-GET requests with the SPA', async () => {
    const { app } = build();
    expect((await request(app).post('/todos').send({})).status).toBe(404);
  });
});
