// GET and POST /api/backups/direct-import on a small app (the import itself is stubbed; directImport.test.js covers the copy).
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { BackupError } from '../backup/errors.js';
import { DIRECT_IMPORT_PATH, isDirectImportPath, registerDirectImportRoutes } from '../backup/directImportRoutes.js';
import { SAME_ORIGIN } from './helpers/eraseEnv.js';

const STATUS = { available: true, canOffer: true, reason: null, found: true, sourceDir: 'C:\\Users\\example\\AppData\\Roaming\\Burrow', lastChangedAt: null, pending: false };
const STAGED = { status: 'staged', needsRestart: true, copiedFrom: STATUS.sourceDir, schemaVersion: 20, totalRows: 5, backups: 1, files: 4 };

function build({ offered = true, run = vi.fn(async () => STAGED), status = vi.fn(async () => STATUS) } = {}) {
  const app = express();
  app.use(express.json());
  registerDirectImportRoutes(app, { offered: () => offered, run, status });
  return { app, run, status };
}

const post = (app, body = { confirm: true }, headers = SAME_ORIGIN) => request(app).post(DIRECT_IMPORT_PATH).set(headers).send(body);

describe('GET /api/backups/direct-import', () => {
  it('answers the status, no-store', async () => {
    const { app } = build();
    const res = await request(app).get(DIRECT_IMPORT_PATH);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: STATUS });
  });
});

describe('POST /api/backups/direct-import', () => {
  it('runs the import for a same-origin JSON request with exactly { confirm: true }', async () => {
    const { app, run } = build();
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: STAGED });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a request from another page (no Origin, another origin, cross-site fetch) with 403 and runs nothing', async () => {
    const { app, run } = build();
    for (const headers of [
      { Host: SAME_ORIGIN.Host },
      { ...SAME_ORIGIN, Origin: 'http://127.0.0.1:5174' },
      { ...SAME_ORIGIN, Origin: 'https://example.com' },
      { ...SAME_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const res = await post(app, { confirm: true }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body.error).toBe('import_origin_blocked');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('needs a JSON body type and exactly { confirm: true }', async () => {
    const { app, run } = build();
    const form = await request(app).post(DIRECT_IMPORT_PATH).set(SAME_ORIGIN).type('form').send('confirm=true');
    expect(form.status).toBe(415);
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, extra: 1 }, []]) {
      const res = await post(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 404 import_unavailable when this build does not offer it, before it looks at the body', async () => {
    const { app, run } = build({ offered: false });
    const res = await post(app);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'import_unavailable', code: 'import_unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('passes the refusals of the import through with their fixed copy', async () => {
    const cases = [
      ['import_target_not_empty', 409],
      ['import_direct_running', 409],
      ['import_running_unknown', 409],
      ['import_source_busy', 409],
      ['import_source_invalid', 422],
      ['import_source_not_found', 404],
      ['import_failed', 500],
    ];
    for (const [code, status] of cases) {
      const { app } = build({
        run: vi.fn(async () => {
          throw new BackupError(code);
        }),
      });
      const res = await post(app);
      expect(res.status, code).toBe(status);
      expect(res.body).toMatchObject({ error: code, code });
      expect(res.body.message).toBe(new BackupError(code).message);
      expect(res.body.message).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('never leaks an unexpected error text', async () => {
    const { app } = build({
      run: vi.fn(async () => {
        throw new Error('C:\\secret\\path exploded');
      }),
    });
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('is limited to 5 requests per 15 minutes', async () => {
    const { app } = build();
    for (let i = 0; i < 5; i += 1) expect((await post(app)).status).toBe(200);
    const res = await post(app);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });
});

describe('path helper', () => {
  it('matches the path like Express routing does (case and trailing slash), so the CORS layer sends no headers on it', () => {
    expect(isDirectImportPath('/api/backups/direct-import')).toBe(true);
    expect(isDirectImportPath('/API/Backups/Direct-Import/')).toBe(true);
    expect(isDirectImportPath('/api/backups/direct-import/x')).toBe(false);
    expect(isDirectImportPath('/api/backups')).toBe(false);
  });
});
