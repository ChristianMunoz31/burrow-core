// Secrets through the real server.js and the real SQLite store (no injected store):
// the stored row holds ciphertext only, status reflects it, delete removes it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

const VALID = `gsk_${'a'.repeat(30)}`;
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  OURA_TOKEN: process.env.OURA_TOKEN,
};

let app;
let db;
let reset;

beforeAll(async () => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  delete process.env.OURA_TOKEN;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  db = createTestDb();
  app = (await import('../../server.js')).default;
  ({ __resetSecretsForTests: reset } = await import('../secrets/getSecret.js'));
});
afterAll(() => {
  reset();
  closeTestDb(db);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  reset();
});

describe('secrets on SQLite', () => {
  it('stores ciphertext only and reports the key as configured from settings', async () => {
    const put = await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: 'OURA_TOKEN', configured: true, source: 'settings', last4: VALID.slice(-4) });
    expect(put.text).not.toContain(VALID);

    const rows = rowsOf(db, 'app_secrets');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('OURA_TOKEN');
    expect(JSON.stringify(rows[0])).not.toContain(VALID);
    expect(rows[0].ciphertext).not.toBe('');

    const list = await request(app).get('/api/secrets');
    expect(list.body.storage).toEqual({ available: true });
    expect(list.body.writable).toBe(true);
    expect(list.body.secrets.find((s) => s.name === 'OURA_TOKEN')).toMatchObject({ source: 'settings' });
  });

  it('overwrites on a second PUT (one row) and removes on DELETE', async () => {
    await request(app).put('/api/secrets/OURA_TOKEN').send({ value: VALID });
    await request(app).put('/api/secrets/OURA_TOKEN').send({ value: `gsk_${'b'.repeat(30)}` });
    expect(rowsOf(db, 'app_secrets')).toHaveLength(1);
    const del = await request(app).delete('/api/secrets/OURA_TOKEN');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ configured: false, source: 'none' });
    expect(rowsOf(db, 'app_secrets')).toHaveLength(0);
  });
});
