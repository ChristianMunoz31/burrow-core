// /api/backups over HTTP: envelopes, media types, validation, path safety, rate limits, access rules.
// Each test builds a fresh express app (same middleware order as server.js: JSON parser, restore
// gate, routes) so the per-app rate limiters start empty. The real server.js app is covered in
// backupGate.test.js and backupAuth.test.js.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, insert, select } from '../db/index.js';
import { restoreGateMiddleware, tryAcquire } from '../backup/lock.js';
import { listMetas } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { registerBackupRoutes } from '../backup/routes.js';
import { BACKUP_UPLOAD_MAX_BYTES, __resetUploadsForTests } from '../backup/restore.js';
import { createBackup } from '../backup/service.js';
import { getAutoBackup } from '../backup/settings.js';
import { latestSchemaVersion } from '../backup/snapshot.js';
import {
  backupFile,
  cleanupBackupEnv,
  dataDir,
  day,
  enospc,
  names,
  noteBodies,
  resetBackupEnv,
  rewriteBackupDb,
} from './helpers/backupEnv.js';

function makeApp({ authEnabled = false, ip } = {}) {
  const app = express();
  if (ip) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: ip });
      next();
    });
  }
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', restoreGateMiddleware);
  registerBackupRoutes(app, { authEnabled });
  return app;
}

let app;
beforeEach(() => {
  resetBackupEnv();
  app = makeApp();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  cleanupBackupEnv();
});

const notes = () => select('notes').map((n) => n.body).sort();
const post = (url, body) => request(app).post(url).set('Content-Type', 'application/json').send(body);
const upload = (bytes, type = 'application/octet-stream') => request(app).post('/api/backups/upload').set('Content-Type', type).send(bytes);
const manual = async (when = day(1)) => (await createBackup({ kind: 'manual', now: when })).meta;
const dbBytes = (id) => fs.readFileSync(backupFile(id, '.db'));

function expectError(res, status, code, message) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: code, code, message: expect.any(String) });
  if (message) expect(res.body.message).toBe(message);
  expect(res.headers['cache-control']).toMatch(/no-store/);
}

describe('GET /api/backups and /api/backups/status', () => {
  it('empty state: no backups, health none, default settings, the folder path', async () => {
    const res = await request(app).get('/api/backups');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.data.backups).toEqual([]);
    expect(res.body.data.status).toMatchObject({ health: 'none', lastBackupId: null, lastResult: null, restoring: false, lastRestore: null });
    expect(res.body.data.settings).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    expect(res.body.data.location).toBe(backupsDir());
    expect(res.body.data.desktop).toBe(false);
  });

  it('reports desktop mode and whether automatic backups are on', async () => {
    const saved = { d: process.env.BURROW_DESKTOP, s: process.env.BURROW_SCHEDULER };
    process.env.BURROW_DESKTOP = '1';
    process.env.BURROW_SCHEDULER = '0';
    try {
      const res = await request(app).get('/api/backups');
      expect(res.body.data.desktop).toBe(true);
      expect(res.body.data.status.autoEnabled).toBe(false);
    } finally {
      for (const [key, value] of [
        ['BURROW_DESKTOP', saved.d],
        ['BURROW_SCHEDULER', saved.s],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('lists backups newest first as summaries and marks safety copies pinned', async () => {
    insert('notes', { body: 'x' });
    const a = await manual(day(1));
    const b = await manual(day(2));
    const res = await request(app).get('/api/backups');
    expect(res.body.data.backups.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(Object.keys(res.body.data.backups[0]).sort()).toEqual(
      ['appVersion', 'createdAt', 'error', 'exportStatus', 'id', 'kind', 'pinned', 'schemaVersion', 'sizeBytes', 'status', 'totalRows'].sort(),
    );
    expect(res.body.data.backups[0]).toMatchObject({ kind: 'manual', status: 'verified', error: null, pinned: false, exportStatus: 'ok', totalRows: 1 });
    expect(res.body.data.backups[0].sizeBytes).toBeGreaterThan(0);
    expect(res.body.data.status.lastBackupId).toBe(b.id);
    // The response never exposes file hashes or the file layout of a backup.
    expect(JSON.stringify(res.body)).not.toMatch(/sha256|fingerprint|\.partial/);
  });

  it('status has the documented fields', async () => {
    const res = await request(app).get('/api/backups/status');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['autoChangedAt', 'autoEnabled', 'autoOffReminder', 'autoSwitch', 'diskWarning', 'freeBytes', 'health', 'lastBackupAt', 'lastBackupId', 'lastError', 'lastResult', 'lastRestore', 'lastRunAt', 'lastSuccessAt', 'recoveryRequired', 'restoring'].sort(),
    );
    expect(res.body.data.health).toBe('none');
  });

  it('unknown sub-paths and unsupported methods do not reach the handlers', async () => {
    expect((await request(app).get('/api/backups/nope')).status).toBe(404);
    expect((await request(app).delete('/api/backups')).status).toBe(404);
    expect((await request(app).put('/api/backups')).status).toBe(404);
  });
});

describe('POST /api/backups', () => {
  it('creates a manual backup and answers 201 with its summary', async () => {
    insert('notes', { body: 'made over http' });
    const res = await post('/api/backups', {});
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const { backup } = res.body.data;
    expect(backup).toMatchObject({ kind: 'manual', status: 'verified', pinned: false, exportStatus: 'ok', schemaVersion: latestSchemaVersion() });
    expect(noteBodies(backupFile(backup.id, '.db'))).toEqual(['made over http']);
  });

  it.each([
    ['text/plain', 'x'],
    ['application/x-www-form-urlencoded', 'a=b'],
    ['multipart/form-data; boundary=x', '--x--'],
    ['application/octet-stream', Buffer.from('x')],
  ])('%s is 415 and no backup is made', async (type, body) => {
    const res = await request(app).post('/api/backups').set('Content-Type', type).send(body);
    expectError(res, 415, 'unsupported_media_type', 'Send the request as JSON.');
    expect(await listMetas(backupsDir())).toEqual([]);
  });

  it('no content type at all is 415 too', async () => {
    const res = await request(app).post('/api/backups');
    expectError(res, 415, 'unsupported_media_type');
    expect(await listMetas(backupsDir())).toEqual([]);
  });

  it('disk_low is 507 with the plain message and no files', async () => {
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 10, bsize: 4096 });
    const res = await post('/api/backups', {});
    expectError(res, 507, 'disk_low', 'There is not enough free disk space to make a backup. Free up some space and try again.');
    expect(names().filter((n) => n.endsWith('.db') || n.endsWith('.zip') || n.endsWith('.partial'))).toEqual([]);
  });

  it('ENOSPC while writing is 507 disk_full and leaves no partial files', async () => {
    const real = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.export.zip.partial')) throw enospc();
      return real(file, ...rest);
    });
    const res = await post('/api/backups', {});
    expectError(res, 507, 'disk_full');
    expect(names().filter((n) => n.endsWith('.db') || n.endsWith('.zip') || n.endsWith('.partial'))).toEqual([]);
  });

  it('an unexpected failure is 500 backup_failed with fixed copy that leaks nothing', async () => {
    const real = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, 'lstat').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.db.partial')) throw Object.assign(new Error(`EIO at ${file} secret-detail`), { code: 'EIO' });
      return real(file, ...rest);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/backups', {});
    expectError(res, 500, 'backup_failed', 'The backup could not be made.');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-detail|EIO|burrow/i);
  });

  it('a backup folder that is a junction or symlink is refused (500) and nothing is written through it', async (ctx) => {
    const elsewhere = path.join(dataDir(), 'elsewhere');
    fs.mkdirSync(elsewhere);
    try {
      fs.symlinkSync(elsewhere, backupsDir(), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip('links are not permitted on this machine');
      return;
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/backups', {});
    expectError(res, 500, 'backup_failed');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(backupsDir(), { force: true, recursive: false });
  });

  it('a second request while one runs is 409 backup_busy', async () => {
    const release = tryAcquire('backup');
    try {
      expectError(await post('/api/backups', {}), 409, 'backup_busy', 'A backup or restore is already running. Try again in a moment.');
    } finally {
      release();
    }
  });

  it('while a restore runs the answer is 503 db_restoring with Retry-After', async () => {
    const release = tryAcquire('restore');
    try {
      const res = await post('/api/backups', {});
      expectError(res, 503, 'db_restoring');
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      release();
    }
  });

  it('is rate limited to 10 per 15 minutes (429 rate_limited)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Failing requests count too, and are much faster than real backups.
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 });
    for (let i = 0; i < 10; i += 1) expect((await post('/api/backups', {})).status).toBe(507);
    const limited = await post('/api/backups', {});
    expectError(limited, 429, 'rate_limited');
  });
});

describe('PUT /api/backups/settings', () => {
  const put = (body, type = 'application/json') => request(app).put('/api/backups/settings').set('Content-Type', type).send(body);

  it('saves valid settings and returns them', async () => {
    const res = await put({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { keepDaily: 3, keepWeekly: 2, keepMonthly: 1 } });
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect((await request(app).get('/api/backups')).body.data.settings).toEqual({ keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
  });

  it.each([
    [{ keepDaily: 0, keepWeekly: 4, keepMonthly: 6 }],
    [{ keepDaily: 61, keepWeekly: 4, keepMonthly: 6 }],
    [{ keepDaily: 7, keepWeekly: 53, keepMonthly: 6 }],
    [{ keepDaily: 7, keepWeekly: 4, keepMonthly: 61 }],
    [{ keepDaily: '7', keepWeekly: 4, keepMonthly: 6 }],
    [{ keepDaily: 7.5, keepWeekly: 4, keepMonthly: 6 }],
    [{ keepDaily: 7, keepWeekly: 4 }],
    [{ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 }],
    [{}],
    [[7, 4, 6]],
  ])('rejects %j with 400 invalid_settings and keeps the old settings', async (body) => {
    await put({ keepDaily: 5, keepWeekly: 5, keepMonthly: 5 });
    const res = await put(body);
    expectError(res, 400, 'invalid_settings', 'Those backup settings are not valid.');
    expect((await request(app).get('/api/backups')).body.data.settings).toEqual({ keepDaily: 5, keepWeekly: 5, keepMonthly: 5 });
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded'])('%s is 415', async (type) => {
    expectError(await put('keepDaily=3', type), 415, 'unsupported_media_type');
  });

  it('applies retention immediately, keeping the newest backup', async () => {
    insert('notes', { body: 'x' });
    const ids = [];
    for (let i = 1; i <= 4; i += 1) {
      insert('notes', { body: `n${i}` });
      ids.push((await manual(day(i))).id);
    }
    expect(await listMetas(backupsDir())).toHaveLength(4);
    await put({ keepDaily: 1, keepWeekly: 0, keepMonthly: 0 });
    const left = await listMetas(backupsDir());
    expect(left.map((m) => m.id)).toEqual([ids[3]]);
    expect(names().filter((n) => n.endsWith('.db'))).toHaveLength(1);
  });

  it('while a backup runs the settings are saved and retention waits', async () => {
    insert('notes', { body: 'x' });
    await manual(day(1));
    insert('notes', { body: 'y' });
    await manual(day(2));
    const release = tryAcquire('backup');
    try {
      const res = await put({ keepDaily: 1, keepWeekly: 0, keepMonthly: 0 });
      expect(res.status).toBe(200);
    } finally {
      release();
    }
    expect(await listMetas(backupsDir())).toHaveLength(2);
  });
});

describe('POST /api/backups/upload', () => {
  it('accepts a backup file as application/octet-stream and returns the inspection', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    const res = await upload(dbBytes(backup.id));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.data).toMatchObject({
      bytes: dbBytes(backup.id).length,
      schemaVersion: latestSchemaVersion(),
      appSchemaVersion: latestSchemaVersion(),
      migrationNeeded: false,
      totalRows: 1,
    });
    expect(res.body.data.uploadToken).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(res.body.data.expiresAt)).toBeGreaterThan(Date.now());
    // The server clock at answer time, and the deadline is after it.
    const serverNow = Date.parse(res.body.data.now);
    expect(serverNow).not.toBeNaN();
    expect(Math.abs(serverNow - Date.now())).toBeLessThan(60_000);
    expect(Date.parse(res.body.data.expiresAt)).toBeGreaterThan(serverNow);
    expect(JSON.stringify(res.body)).not.toContain(dataDir());
  });

  it('accepts application/vnd.sqlite3 too', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    expect((await upload(dbBytes(backup.id), 'application/vnd.sqlite3')).status).toBe(200);
  });

  it.each(['application/json', 'text/plain', 'application/zip', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    '%s is 415 unsupported_media_type',
    async (type) => {
      const res = await request(app).post('/api/backups/upload').set('Content-Type', type).send(Buffer.from('SQLite format 3\0'));
      expectError(res, 415, 'unsupported_media_type', 'Send the backup file as raw bytes.');
      expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    },
  );

  it('no content type is 415', async () => {
    expectError(await request(app).post('/api/backups/upload'), 415, 'unsupported_media_type');
  });

  it.each([
    ['text', Buffer.from('hello, this is not a database '.repeat(50))],
    ['a ZIP export', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(500, 7)])],
    ['an empty body', Buffer.alloc(0)],
  ])('%s is 422 backup_invalid and nothing is kept', async (_label, bytes) => {
    const res = await upload(bytes);
    expectError(res, 422, 'backup_invalid', 'That file is not a usable Burrow backup.');
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('a backup from a newer version is 409 backup_too_new with the plain message', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    rewriteBackupDb(backup.id, (db) => {
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(latestSchemaVersion() + 1, 'future', '2030-01-01T00:00:00.000Z');
    });
    const res = await upload(dbBytes(backup.id));
    expectError(res, 409, 'backup_too_new', 'This backup was made by a newer version of Burrow. Update Burrow, then try again.');
  });

  it('a declared size over the cap is refused with 413 before the body is read', async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/backups/upload',
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BACKUP_UPLOAD_MAX_BYTES + 1) },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => {
              data += c;
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
          },
        );
        req.on('error', reject);
        req.write('x');
        setTimeout(() => req.destroy(), 3000).unref();
      });
      expect(result.status).toBe(413);
      expect(result.body).toEqual({ error: 'too_large', code: 'too_large', message: 'That file is too large to restore here.' });
      expect(result.headers['cache-control']).toMatch(/no-store/);
      expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('low disk space is 507 disk_low', async () => {
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 });
    expectError(await upload(Buffer.from('x')), 507, 'disk_low');
  });

  it('shares a rate limit of 10 per 15 minutes with restore (429 rate_limited)', async () => {
    for (let i = 0; i < 5; i += 1) expect((await upload(Buffer.from('nope'))).status).toBe(422);
    for (let i = 0; i < 5; i += 1) expect((await post('/api/backups/restore', {})).status).toBe(400);
    expectError(await upload(Buffer.from('nope')), 429, 'rate_limited');
    expectError(await post('/api/backups/restore', {}), 429, 'rate_limited');
  });
});

describe('POST /api/backups/restore', () => {
  it('restores a listed backup and answers with the summary of what happened', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'later' });
    const res = await post('/api/backups/restore', { id: backup.id, confirm: true });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.data).toEqual({
      restoredFrom: backup.id,
      safetyBackupId: expect.stringMatching(/-safety-/),
      schemaFrom: latestSchemaVersion(),
      schemaTo: latestSchemaVersion(),
      totalRows: backup.totalRows,
    });
    expect(notes()).toEqual(['saved']);
    const listed = (await request(app).get('/api/backups')).body.data;
    expect(listed.backups.find((b) => b.id === res.body.data.safetyBackupId)).toMatchObject({ kind: 'safety', pinned: true, status: 'verified' });
    expect(listed.status.lastRestore).toMatchObject({ outcome: 'restored', sourceId: backup.id });
  });

  it('restores an uploaded file by token', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'later' });
    const up = await upload(dbBytes(backup.id));
    const res = await post('/api/backups/restore', { uploadToken: up.body.data.uploadToken, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data.restoredFrom).toBe('upload');
    expect(notes()).toEqual(['saved']);
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['confirm missing', { id: '20260101T000000Z-manual-aaaaaa' }],
    ['confirm false', { id: '20260101T000000Z-manual-aaaaaa', confirm: false }],
    ['confirm as the string "true"', { id: '20260101T000000Z-manual-aaaaaa', confirm: 'true' }],
    ['confirm as 1', { id: '20260101T000000Z-manual-aaaaaa', confirm: 1 }],
    ['neither id nor token', { confirm: true }],
    ['both id and token', { id: '20260101T000000Z-manual-aaaaaa', uploadToken: 'a'.repeat(32), confirm: true }],
    ['an extra key', { id: '20260101T000000Z-manual-aaaaaa', confirm: true, force: true }],
    ['an array body', [{ id: '20260101T000000Z-manual-aaaaaa', confirm: true }]],
    ['a null id', { id: null, confirm: true }],
  ])('%s is 400 invalid_request and nothing changes', async (_label, body) => {
    insert('notes', { body: 'live' });
    const res = body === undefined ? await request(app).post('/api/backups/restore').set('Content-Type', 'application/json').send() : await post('/api/backups/restore', body);
    expectError(res, 400, 'invalid_request', 'That request was not valid.');
    expect(notes()).toEqual(['live']);
    expect(await listMetas(backupsDir())).toEqual([]);
  });

  it.each([
    ['a number id', { id: 12345, confirm: true }],
    ['an object id', { id: { $ne: '' }, confirm: true }],
    ['a short token', { uploadToken: 'abc', confirm: true }],
    ['an uppercase token', { uploadToken: 'A'.repeat(32), confirm: true }],
    ['a token with a trailing character', { uploadToken: `${'a'.repeat(32)}0`, confirm: true }],
    ['a token with path characters', { uploadToken: '../'.repeat(11), confirm: true }],
    ['a numeric token', { uploadToken: 12345, confirm: true }],
  ])('a tampered upload token or id (%s) is 400 or 404 and nothing changes', async (_label, body) => {
    insert('notes', { body: 'live' });
    const res = await post('/api/backups/restore', body);
    expect([400, 404]).toContain(res.status);
    expect(res.body.error).toMatch(/^(invalid_request|backup_not_found)$/);
    expect(notes()).toEqual(['live']);
  });

  it('a flipped character in a real token is a different, unknown token: 410 upload_expired', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    const up = await upload(dbBytes(backup.id));
    const token = up.body.data.uploadToken;
    const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expectError(await post('/api/backups/restore', { uploadToken: flipped, confirm: true }), 410, 'upload_expired', 'That upload expired. Choose the file again.');
    // The real upload is still usable.
    expect((await post('/api/backups/restore', { uploadToken: token, confirm: true })).status).toBe(200);
  });

  it.each([
    '../x',
    '..\\x',
    '../../burrow.db',
    '..\\..\\burrow.db',
    'C:\\Windows\\win.ini',
    '/etc/passwd',
    '\\\\server\\share\\x',
    '%2e%2e%2fx',
    '%2e%2e%5cx',
    '..%2f..%2fburrow.db',
    '20260101T000000Z-manual-aaaaaa/../../burrow',
    '20260101T000000Z-manual-aaaaaa\u0000.db',
    '20260101T000000Z-manual-aaaaaa.db',
    '20260101T000000Z-manual-AAAAAA',
    '20260101T000000Z-other-aaaaaa',
    'x'.repeat(5000),
    '',
  ])('restore id %j is 404 backup_not_found and nothing changes', async (id) => {
    insert('notes', { body: 'live' });
    const res = await post('/api/backups/restore', { id, confirm: true });
    expectError(res, 404, 'backup_not_found', 'That backup could not be found.');
    expect(notes()).toEqual(['live']);
    expect(JSON.stringify(res.body)).not.toContain(dataDir());
  });

  it('a valid-looking id with no files is 404 backup_not_found', async () => {
    insert('notes', { body: 'live' });
    expectError(await post('/api/backups/restore', { id: '20260101T000000Z-manual-abcdef', confirm: true }), 404, 'backup_not_found');
    expect(notes()).toEqual(['live']);
  });

  it('a valid-looking id whose meta exists but whose .db is gone is 404', async () => {
    insert('notes', { body: 'live' });
    const backup = await manual();
    fs.rmSync(backupFile(backup.id, '.db'));
    expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 404, 'backup_not_found');
  });

  it('a symlinked .db in the backups folder is 404 (never followed)', async (ctx) => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    const file = backupFile(backup.id, '.db');
    const target = path.join(dataDir(), 'real-target.db');
    fs.copyFileSync(file, target);
    fs.rmSync(file);
    try {
      fs.symlinkSync(target, file, 'file');
    } catch {
      // Windows without symlink privilege: a junction is the link type it allows (it points to a folder).
      try {
        fs.mkdirSync(path.join(dataDir(), 'junction-target'));
        fs.symlinkSync(path.join(dataDir(), 'junction-target'), file, 'junction');
      } catch {
        ctx.skip('neither a symlink nor a junction can be created here');
        return;
      }
    }
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 404, 'backup_not_found');
    expect(notes()).toEqual(['live', 'saved']);
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
  });

  it('a folder or other non-regular file where the .db should be is 404', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    fs.rmSync(backupFile(backup.id, '.db'));
    fs.mkdirSync(backupFile(backup.id, '.db'));
    expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 404, 'backup_not_found');
    expect(notes()).toEqual(['live', 'saved']);
  });

  it('a backup whose .db was changed afterwards is 422 backup_invalid', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    fs.appendFileSync(backupFile(backup.id, '.db'), 'tampered');
    expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 422, 'backup_invalid');
    expect(notes()).toEqual(['live', 'saved']);
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
  });

  it.each([
    ['an extra trigger', 'CREATE TRIGGER evil AFTER INSERT ON notes BEGIN DELETE FROM todos; END'],
    ['an extra view', 'CREATE VIEW sneaky AS SELECT body FROM notes'],
  ])('a backup .db containing %s is 422 backup_invalid (by id and by upload)', async (_label, sql) => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    rewriteBackupDb(backup.id, (db) => db.exec(sql));

    expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 422, 'backup_invalid');
    expectError(await upload(dbBytes(backup.id)), 422, 'backup_invalid');
    expect(notes()).toEqual(['live', 'saved']);
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
  });

  it('a backup from a newer version is 409 backup_too_new, live data unchanged, no safety copy', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    rewriteBackupDb(backup.id, (db) => {
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(latestSchemaVersion() + 1, 'future', '2030-01-01T00:00:00.000Z');
    });
    insert('notes', { body: 'live' });
    const res = await post('/api/backups/restore', { id: backup.id, confirm: true });
    expectError(res, 409, 'backup_too_new', 'This backup was made by a newer version of Burrow. Update Burrow, then try again.');
    expect(notes()).toEqual(['live', 'saved']);
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
  });

  it('a restore requested while a backup runs is 409 backup_busy', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    const release = tryAcquire('backup');
    try {
      expectError(await post('/api/backups/restore', { id: backup.id, confirm: true }), 409, 'backup_busy');
    } finally {
      release();
    }
  });

  it('a restore requested while another restore runs is 503 db_restoring', async () => {
    insert('notes', { body: 'x' });
    const backup = await manual();
    const release = tryAcquire('restore');
    try {
      const res = await post('/api/backups/restore', { id: backup.id, confirm: true });
      expectError(res, 503, 'db_restoring');
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      release();
    }
  });

  it('permanent EBUSY on the swap is 500 restore_failed with the plain message, and the live data is intact', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (/restore-aside/.test(String(to))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return real(from, to);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/backups/restore', { id: backup.id, confirm: true });
    expectError(res, 500, 'restore_failed', 'The restore did not finish. Your current data was kept.');
    expect(notes()).toEqual(['live', 'saved']);
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-/.test(n))).toEqual([]);
    // And the API still answers normally afterwards.
    expect((await request(app).get('/api/backups/status')).status).toBe(200);
  }, 20_000);

  it('the same restore works again once the lock clears', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    insert('notes', { body: 'live' });
    const release = tryAcquire('backup');
    expect((await post('/api/backups/restore', { id: backup.id, confirm: true })).status).toBe(409);
    release();
    expect((await post('/api/backups/restore', { id: backup.id, confirm: true })).status).toBe(200);
    expect(notes()).toEqual(['saved']);
  });

  it('wrong content type is 415 and nothing happens', async () => {
    insert('notes', { body: 'saved' });
    const backup = await manual();
    const res = await request(app)
      .post('/api/backups/restore')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`id=${backup.id}&confirm=true`);
    expectError(res, 415, 'unsupported_media_type');
    const res2 = await request(app).post('/api/backups/restore').set('Content-Type', 'text/plain').send(JSON.stringify({ id: backup.id, confirm: true }));
    expectError(res2, 415, 'unsupported_media_type');
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
  });
});

describe('access rules', () => {
  const routes = [
    ['get', '/api/backups'],
    ['get', '/api/backups/status'],
    ['post', '/api/backups'],
    ['put', '/api/backups/settings'],
    ['put', '/api/backups/auto'],
    ['post', '/api/backups/auto/dismiss-reminder'],
    ['post', '/api/backups/upload'],
    ['post', '/api/backups/restore'],
  ];

  it.each(routes)('without sign-in enabled, a non-loopback client is refused on %s %s (403 auth_required)', async (method, url) => {
    const remote = makeApp({ ip: '203.0.113.7' });
    const switchBefore = await getAutoBackup();
    const body = url === '/api/backups/auto' ? { enabled: false } : {};
    const res = await request(remote)[method](url).set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('auth_required');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(await listMetas(backupsDir())).toEqual([]);
    expect(await getAutoBackup()).toEqual(switchBefore);
  });

  it('with sign-in enabled the route itself does not apply the loopback rule (the auth gate in front does)', async () => {
    const remote = makeApp({ authEnabled: true, ip: '203.0.113.7' });
    expect((await request(remote).get('/api/backups/status')).status).toBe(200);
  });

  it('IPv6 loopback is allowed', async () => {
    const local6 = makeApp({ ip: '::1' });
    // supertest connects over IPv4, so the socket check still sees loopback.
    expect((await request(local6).get('/api/backups/status')).status).toBe(200);
  });
});

describe('what the API never reveals', () => {
  it('error bodies carry only the code and the fixed message', async () => {
    const res = await post('/api/backups/restore', { id: '20260101T000000Z-manual-abcdef', confirm: true });
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error', 'message']);
    expect(res.body.message).not.toMatch(/[A-Za-z]:\\|\/tmp|burrow-test/);
  });

  it('after all of the above, the API is still healthy (no leaked lock or gate)', async () => {
    expect((await request(app).get('/api/todos')).status).not.toBe(503);
    expect((await post('/api/backups', {})).status).toBe(201);
    __resetUploadsForTests();
    expect(getDb()).toBeTruthy();
  });
});
