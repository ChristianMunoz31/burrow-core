// SSRF guard on the Google Sheets CSV proxy. Every rejection happens before any
// outbound fetch, so these never touch the network.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

let app;
// The shell may export SECRETS_ENCRYPTION_KEY; keep these tests independent of it.
const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
const savedOptIn = process.env.BURROW_NETWORK_OPTIN;
afterAll(() => {
  if (savedOptIn === undefined) delete process.env.BURROW_NETWORK_OPTIN;
  else process.env.BURROW_NETWORK_OPTIN = savedOptIn;
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  process.env.BURROW_NETWORK_OPTIN = 'sheets'; // the route is opt-in; these tests exercise the SSRF guard behind it
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});

describe('SSRF guard on /api/sheets/csv', () => {
  it('400 when the url param is missing', async () => {
    const res = await request(app).get('/api/sheets/csv');
    expect(res.status).toBe(400);
  });

  it('400 for a non docs.google.com host', async () => {
    const res = await request(app).get('/api/sheets/csv').query({ url: 'https://evil.example.com/x.csv' });
    expect(res.status).toBe(400);
  });

  it('400 for an internal/metadata host', async () => {
    const res = await request(app).get('/api/sheets/csv').query({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(res.status).toBe(400);
  });

  it('400 for an http (non-https) docs.google.com url', async () => {
    const res = await request(app).get('/api/sheets/csv').query({ url: 'http://docs.google.com/x.csv' });
    expect(res.status).toBe(400);
  });
});
