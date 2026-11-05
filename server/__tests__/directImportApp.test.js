// The import routes inside the REAL server.js app. This test run is a source checkout without the Store marker, so the
// offer must be off everywhere: GET says available: false and POST answers 404 import_unavailable. A direct build never
// shows or runs the import. (directImportRoutes.test.js covers the routes with the offer on.)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetLicenseForTests } from '../license/index.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { SAME_ORIGIN, freshDb } from './helpers/eraseEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR', 'BURROW_DATA_LOCATION', 'BURROW_DISTRIBUTION'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let app;
beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  app = (await import('../../server.js')).default;
});

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  resetLicenseForTests();
  cleanupBackupEnv();
});

describe('a direct build (no Store marker)', () => {
  it('never offers the import', async () => {
    const res = await request(app).get('/api/backups/direct-import');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ available: false, canOffer: false, found: false });
  });

  it('refuses to run it: 404 import_unavailable for a same-origin request, 403 for any other page', async () => {
    const ok = await request(app).post('/api/backups/direct-import').set(SAME_ORIGIN).send({ confirm: true });
    expect(ok.status).toBe(404);
    expect(ok.body.error).toBe('import_unavailable');
    const foreign = await request(app).post('/api/backups/direct-import').set({ ...SAME_ORIGIN, Origin: 'https://example.com' }).send({ confirm: true });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('import_origin_blocked');
    // No CORS headers on this path: another page cannot read the status either.
    const cors = await request(app).get('/api/backups/direct-import').set({ Origin: 'http://127.0.0.1:5174' });
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reports the data location and folder in the app info', async () => {
    const res = await request(app).get('/api/app/info');
    expect(res.body.data).toMatchObject({ dataLocation: 'appdata' });
    expect(typeof res.body.data.dataDir).toBe('string');
    expect(res.body.data.dataFolderWarning === null || typeof res.body.data.dataFolderWarning === 'object').toBe(true);
  });
});
