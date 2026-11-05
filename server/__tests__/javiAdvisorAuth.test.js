// The advisor route sits behind the login gate. Env is set before importing the app
// because server.js reads APP_PASSWORD/AUTH_SECRET at module-evaluation time.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn() }));
// The route health-probes Ollama before generateAdvice; keep that probe on a fake, never the real host.
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { generateAdvice } from '../javi/advisorService.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';

let fake;

let app;
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
});

beforeEach(() => {
  __resetAiForTests();
  fake = installFakeOllama(fetch);
  generateAdvice.mockReset();
  generateAdvice.mockResolvedValue({ content: 'advice', model: 'm', provider: 'p' });
});

describe('POST /api/jarvis/advice auth gate', () => {
  it('returns 401 without a session cookie and does not call the service', async () => {
    const res = await request(app).post('/api/jarvis/advice').set('X-Forwarded-For', '192.0.2.10').send({ page: 'todos' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it.each(['/API/JARVIS/ADVICE', '/api/jarvis/advice/', '/Api/Jarvis/Advice'])(
    'returns 401 for path variant %s',
    async (path) => {
      const res = await request(app).post(path).set('X-Forwarded-For', '192.0.2.13').send({ page: 'todos' });
      expect(res.status).toBe(401);
      expect(generateAdvice).not.toHaveBeenCalled();
    },
  );

  it('returns 401 before validating the body', async () => {
    const res = await request(app).post('/api/jarvis/advice').set('X-Forwarded-For', '192.0.2.11').send({ page: 'nope' });
    expect(res.status).toBe(401);
  });

  it('succeeds after login', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/login').set('X-Forwarded-For', '192.0.2.12').send({ password: 'sekret-pass' });
    expect(login.status).toBe(200);
    const res = await agent.post('/api/jarvis/advice').set('X-Forwarded-For', '192.0.2.12').send({ page: 'todos' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { content: 'advice', model: 'm', provider: 'p' } });
    expect(generateAdvice).toHaveBeenCalledTimes(1);
    for (const u of fake.urls) expect(u.startsWith('http://127.0.0.1:11434/'), u).toBe(true);
  });
});
