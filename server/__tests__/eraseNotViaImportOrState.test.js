// Import and the generic state API can add or change data but can never wipe it, and can never touch the
// protected records. Erasing has its own two-step routes (eraseRoutes.test.js); nothing here may emulate it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';
import { registerDataRoutes } from '../dataRoutes.js';
import { registerImportRoutes } from '../importRoutes.js';
import { select, upsert } from '../db/index.js';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';
import { moduleRows, rowCounts as allCounts } from './helpers/eraseEnv.js';

// An import writes its own audit row; everything else must stay exactly as it was.
const rowCounts = (handle) => ({ ...allCounts(handle), audit_log: 0 });

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

const app = () => {
  const a = express();
  a.use(express.json());
  registerDataRoutes(a);
  registerImportRoutes(a);
  return a;
};

const archive = (tables) =>
  Buffer.from(
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: Object.keys(tables).map((id) => ({ id })) }),
      ),
      ...Object.fromEntries(Object.entries(tables).map(([id, rows]) => [`json/${id}.json`, strToU8(JSON.stringify(rows))])),
    }),
  );
const importZip = (zip, query = '') => request(app()).post(`/api/import${query}`).set('Content-Type', 'application/zip').send(zip);

describe('import never deletes', () => {
  it('an archive with empty tables leaves every existing row in place (upsert, not replace)', async () => {
    seedDb(db, moduleRows());
    const before = rowCounts(db);
    const empty = Object.fromEntries(Object.keys(moduleRows()).map((t) => [t, []]));
    const res = await importZip(archive(empty));
    expect(res.status).toBe(200);
    expect(rowCounts(db)).toEqual(before);
  });

  it('a completely empty archive (manifest only) changes nothing', async () => {
    seedDb(db, moduleRows());
    const before = rowCounts(db);
    await importZip(archive({}));
    expect(rowCounts(db)).toEqual(before);
  });

  it('an archive of other rows adds to what is there instead of replacing it', async () => {
    seedDb(db, moduleRows());
    const before = rowCounts(db);
    await importZip(archive({ notes: [{ id: 'imported-1', body: 'new note' }] }));
    const after = rowCounts(db);
    expect(after.notes).toBe(before.notes + 1);
    expect(after.journal).toBe(before.journal);
  });

  it('an archive cannot carry audit_log or app_secrets rows in (they are never imported)', async () => {
    const res = await importZip(
      archive({
        audit_log: [{ id: 'a1', kind: 'auth', feature: 'data_erased', status: 'ok' }],
        app_secrets: [{ name: 'GROQ_API_KEY', ciphertext: 'x', iv: 'y', auth_tag: 'z', last4: '1234' }],
      }),
    );
    expect([200, 400, 422]).toContain(res.status);
    expect(select('audit_log', { columns: ['feature'], db }).map((r) => r.feature)).not.toContain('data_erased');
    expect(select('audit_log', { where: { id: 'a1' }, db })).toHaveLength(0);
    expect(rowCounts(db).app_secrets).toBe(0);
  });
});

describe('the state API cannot clear or fake protected records', () => {
  const PROTECTED = ['license.trial', 'license.clock', 'license.activation', 'network.optIn', 'backup.auto', 'ai.cloudConsent', 'ai.cloudCategories', 'ai.settings'];

  it.each(PROTECTED)('PUT /api/state/%s is refused, and the stored value stays', async (key) => {
    upsert('app_state', { key, value: { keep: true } }, { conflict: ['key'], db });
    const res = await request(app()).put(`/api/state/${encodeURIComponent(key)}`).send({ value: null });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'protected_key' });
    expect(select('app_state', { where: { key }, db })[0].value).toEqual({ keep: true });
  });

  it('there is no way to delete state or send an erase through it', async () => {
    seedDb(db, moduleRows());
    upsert('app_state', { key: 'theme', value: 'dark' }, { conflict: ['key'], db });
    const before = rowCounts(db);
    const a = app();
    for (const res of [
      await request(a).delete('/api/state'),
      await request(a).delete('/api/state/theme'),
      await request(a).put('/api/state').send({ phrase: 'ERASE' }),
      await request(a).post('/api/state').send({ phrase: 'ERASE', token: 'x' }),
      await request(a).put('/api/state/erase').send({ value: { phrase: 'ERASE' } }),
    ]) {
      expect([200, 404, 405]).toContain(res.status);
    }
    const after = rowCounts(db);
    expect({ ...after, app_state: undefined }).toEqual({ ...before, app_state: undefined });
    expect(select('app_state', { where: { key: 'theme' }, db })[0].value).toBe('dark');
  });

  it('writing a normal key never removes another', async () => {
    upsert('app_state', { key: 'a', value: 1 }, { conflict: ['key'], db });
    upsert('app_state', { key: 'license.trial', value: { v: 1 } }, { conflict: ['key'], db });
    await request(app()).put('/api/state/b').send({ value: 2 });
    expect(select('app_state', { columns: ['key'], db }).map((r) => r.key).sort()).toEqual(['a', 'b', 'license.trial']);
  });
});
