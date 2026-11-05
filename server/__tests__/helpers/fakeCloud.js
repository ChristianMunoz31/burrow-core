// A fake OpenAI-compatible cloud provider for tests, behind a mocked node-fetch
// (vi.mock('node-fetch')). Nothing real is ever contacted: the host is api.example.com and the
// key is an obviously fake string. Records every request body so tests can assert exactly what
// would have left the machine.
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { installFakeOllama } from './fakeOllama.js';
import { clearCloudConsent, recordCloudConsent } from '../../ai/consent.js';
import { __resetAiForTests } from '../../ai/index.js';
import { AI_SETTINGS_KEY } from '../../ai/settings.js';
import { setState } from '../../dataAccess.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../../netPolicy.js';

export const CLOUD_HOST = 'api.example.com';
export const CLOUD_BASE_URL = `https://${CLOUD_HOST}/v1`;
export const CLOUD_KEY = 'sk-test-fake';

/** Unique strings planted in withheld data; none may ever appear in a cloud request or an audit row. */
export const SENTINELS = Object.freeze({
  journal: 'SENTINEL_JOURNAL_zq81',
  notes: 'SENTINEL_NOTE_zq82',
  health: 'SENTINEL_HEALTH_zq83',
  memory: 'SENTINEL_MEMORY_zq84',
  todo: 'SENTINEL_TODO_zq85',
  habit: 'SENTINEL_HABIT_zq86',
});

const saved = { key: process.env.AI_CLOUD_API_KEY, optin: process.env.BURROW_NETWORK_OPTIN };

/**
 * Save a complete, consented cloud setup (or a deliberately broken one).
 * @param {{ categories?: object, consent?: boolean | object, optIn?: boolean, baseUrl?: string, model?: string | null,
 *   provider?: string, key?: string | null }} [opts]
 */
export async function configureCloud({
  categories = {},
  consent = true,
  optIn = true,
  baseUrl = CLOUD_BASE_URL,
  model = 'cloud-model',
  provider = 'openai_compat',
  key = CLOUD_KEY,
} = {}) {
  if (key) process.env.AI_CLOUD_API_KEY = key;
  else delete process.env.AI_CLOUD_API_KEY;
  delete process.env.BURROW_NETWORK_OPTIN;
  await setState(AI_SETTINGS_KEY, { provider, cloud: { baseUrl, model, tokenParam: null } });
  await setState(NETWORK_STATE_KEY, optIn ? { cloudAi: true } : {});
  await setState('ai.cloudCategories', categories);
  if (consent === true) await recordCloudConsent({ host: new URL(baseUrl).hostname, baseUrl: baseUrl.replace(/\/+$/, '') });
  else if (consent) await setState('ai.cloudConsent', consent);
  else await clearCloudConsent();
  __resetNetPolicyForTests();
  __resetAiForTests();
}

/** Undo configureCloud: local provider, no opt-in, no consent, env restored. */
export async function resetCloud() {
  if (saved.key === undefined) delete process.env.AI_CLOUD_API_KEY;
  else process.env.AI_CLOUD_API_KEY = saved.key;
  if (saved.optin === undefined) delete process.env.BURROW_NETWORK_OPTIN;
  else process.env.BURROW_NETWORK_OPTIN = saved.optin;
  await setState(AI_SETTINGS_KEY, {});
  await setState(NETWORK_STATE_KEY, {});
  await setState('ai.cloudCategories', {});
  await clearCloudConsent();
  await setState('ai.cloudHint', {});
  __resetNetPolicyForTests();
  __resetAiForTests();
}

const sse = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });

/**
 * Install the fake on a mocked node-fetch.
 * Each reply is a string (a text answer) or `{ toolCalls: [{ name, arguments }] }`. The last reply
 * repeats once the queue is down to one entry.
 * @param {import('vitest').Mock} fetchMock
 * @param {{ replies?: Array<string | { toolCalls: Array<{ name: string, arguments?: object }> }> }} [opts]
 * @returns {{ requests: Array<{ url: string, body: object, headers: object, agent: unknown }>, bodies: object[], sent: () => string }}
 */
export function installFakeCloud(fetchMock, { replies = ['Cloud reply.'] } = {}) {
  const queue = [...replies];
  const state = {
    requests: [],
    get bodies() {
      return state.requests.map((r) => r.body);
    },
    /** Everything that was sent to the provider, as one string. */
    sent: () => state.requests.map((r) => JSON.stringify(r.body)).join('\n'),
  };
  fetchMock.mockImplementation(async (url, init = {}) => {
    const body = JSON.parse(init.body);
    state.requests.push({ url: String(url), body, headers: init.headers, agent: init.agent });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply && typeof reply === 'object' && Array.isArray(reply.toolCalls)) {
      return json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: reply.toolCalls.map((c, i) => ({
                id: `call_c${state.requests.length}_${i}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }
    const text = String(reply);
    if (body.stream === false) return json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
    return { ok: true, status: 200, body: Readable.from([Buffer.from(sse(text))]), headers: { get: () => null } };
  });
  return state;
}

/**
 * Both providers behind one mocked node-fetch: api.example.com is the fake cloud, everything
 * else is the fake Ollama (so a fall-back to local still has something to talk to).
 * @param {import('vitest').Mock} fetchMock
 * @param {{ replies?: Array<string | object>, ollama?: object }} [opts] `ollama` is passed to installFakeOllama.
 */
export function installCloudAndOllama(fetchMock, { replies, ollama = {} } = {}) {
  const cloudFn = vi.fn();
  const ollamaFn = vi.fn();
  const cloud = installFakeCloud(cloudFn, { replies });
  const local = installFakeOllama(ollamaFn, ollama);
  fetchMock.mockImplementation((url, init) => (new URL(String(url)).hostname === CLOUD_HOST ? cloudFn(url, init) : ollamaFn(url, init)));
  return { cloud, local };
}
