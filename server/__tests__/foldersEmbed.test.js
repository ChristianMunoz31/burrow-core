// The search model behind Folders questions: the /api/embed transport (ollamaEmbed) and getEmbedClient, which only
// ever talks to Ollama (this computer, or another one with the aiLan opt-in), never to a cloud provider, and takes a
// slot in the shared AI queue for every call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { AI_REASONS, AiBusyError, AiUnavailableError, MSG_NO_EMBED_MODEL, aiErrorBody } from '../ai/gate.js';
import { EMBED_MODEL, __resetAiForTests, getAiClient, getEmbedClient, isTextModel, pickAutoModels } from '../ai/registry.js';
import { classifyAiError } from '../ai/index.js';
import { PULLABLE_MODELS, recommendModels } from '../ai/recommend.js';
import { MAX_EMBED_DIMS, OLLAMA_PATHS, ollamaEmbed } from '../ai/providers/ollama.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { setState } from '../dataAccess.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { EMBED_DIMS, EMBED_MODEL_ENTRY, MODELS, fakeEmbedding, hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';

const HOST = 'http://127.0.0.1:11434';
const ENV_KEYS = ['BURROW_AI', 'OLLAMA_HOST', 'BURROW_AI_QUEUE_MAX', 'BURROW_AI_CONCURRENCY', 'BURROW_AI_QUEUE_TIMEOUT_MS'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const hostOf = (u) => new URL(u).hostname;

/** A raw HTTP reply for fetch.mockImplementation. */
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: () => null },
});
const embedReply = (embeddings) => () => reply({ model: 'm', embeddings });

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  fetch.mockReset();
  __resetAiForTests();
  __resetNetPolicyForTests();
  await setState(AI_SETTINGS_KEY, {});
  await setState(NETWORK_STATE_KEY, {});
});
afterEach(async () => {
  await resetCloud();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetNetPolicyForTests();
});

describe('ollamaEmbed (the /api/embed transport)', () => {
  it('posts the model, the inputs and truncate:true to the fixed /api/embed path', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    await ollamaEmbed(HOST, 'nomic-embed-text', ['one', 'two']);
    expect(OLLAMA_PATHS.embed).toBe('/api/embed');
    expect(fake.urls).toEqual([`${HOST}/api/embed`]);
    expect(fake.embedBodies).toEqual([{ model: 'nomic-embed-text', input: ['one', 'two'], truncate: true }]);
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends keep_alive only when given', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    await ollamaEmbed(HOST, 'm', ['x'], { keepAlive: '10m' });
    await ollamaEmbed(HOST, 'm', ['x']);
    expect(fake.embedBodies[0].keep_alive).toBe('10m');
    expect(fake.embedBodies[1]).not.toHaveProperty('keep_alive');
  });

  it('returns one Float32Array per input, in order', async () => {
    installFakeOllama(fetch, { embedModel: true });
    const out = await ollamaEmbed(HOST, 'm', ['tomato soup', 'garden plan']);
    expect(out).toHaveLength(2);
    expect(out.every((v) => v instanceof Float32Array && v.length === EMBED_DIMS)).toBe(true);
    expect(Array.from(out[0])).toEqual(fakeEmbedding('tomato soup'));
    expect(Array.from(out[1])).toEqual(fakeEmbedding('garden plan'));
  });

  it.each([
    ['fewer vectors than inputs', embedReply([[1, 2]])],
    ['more vectors than inputs', embedReply([[1], [2], [3]])],
    ['no embeddings field', () => reply({ model: 'm' })],
    ['embeddings that is not a list', () => reply({ embeddings: 'nope' })],
    ['a vector that is not a list', embedReply([[1, 2], 'x'])],
    ['an empty vector', embedReply([[1, 2], []])],
    ['a null value (what NaN and Infinity become in JSON)', embedReply([[1, null], [1, 2]])],
    ['a string value', embedReply([[1, '2'], [1, 2]])],
    ['vectors with different dimension counts', embedReply([[1, 2], [1, 2, 3]])],
    ['an oversized vector', embedReply([new Array(MAX_EMBED_DIMS + 1).fill(0.1), new Array(MAX_EMBED_DIMS + 1).fill(0.1)])],
    ['not JSON at all', () => reply('<html>nope</html>')],
    ['no body', () => reply(null)],
  ])('refuses a reply with %s as not_ollama', async (_label, impl) => {
    fetch.mockImplementation(async () => impl());
    await expect(ollamaEmbed(HOST, 'm', ['a', 'b'])).rejects.toMatchObject({ code: 'not_ollama' });
  });

  it('accepts the largest allowed dimension count', async () => {
    fetch.mockImplementation(embedReply([new Array(MAX_EMBED_DIMS).fill(0.5)]));
    const [vec] = await ollamaEmbed(HOST, 'm', ['a']);
    expect(vec).toHaveLength(MAX_EMBED_DIMS);
    expect(MAX_EMBED_DIMS).toBe(4096);
  });

  it('a missing model is model_missing, a refused connection is unavailable, and no error carries the server text', async () => {
    fetch.mockImplementation(async () => reply('model "nomic-embed-text" not found, try pulling it first', 404));
    await expect(ollamaEmbed(HOST, 'nomic-embed-text', ['a'])).rejects.toMatchObject({ code: 'model_missing', httpStatus: 404 });
    fetch.mockImplementation(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    });
    await expect(ollamaEmbed(HOST, 'm', ['a'])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('honours an abort signal', async () => {
    fetch.mockImplementation(async (_url, init) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return reply({ embeddings: [[1]] });
    });
    const controller = new AbortController();
    controller.abort();
    await expect(ollamaEmbed(HOST, 'm', ['a'], { signal: controller.signal })).rejects.toBeTruthy();
  });
});

describe('the search model is never a chat model', () => {
  it('EMBED_MODEL is nomic-embed-text and it can be downloaded by a click', () => {
    expect(EMBED_MODEL).toBe('nomic-embed-text');
    expect(PULLABLE_MODELS.has('nomic-embed-text')).toBe(true);
    // it is offered on the Folders page, not as a recommended chat model for any memory size
    for (const gib of [2, 8, 12, 32, 64]) {
      const rec = recommendModels(gib * 1024 ** 3);
      expect([...rec.primary, ...rec.optional].map((m) => m.name)).not.toContain('nomic-embed-text');
    }
  });

  it('isTextModel is false for it, even when its capabilities are unknown', () => {
    expect(isTextModel({ name: 'nomic-embed-text:latest', capabilities: [] })).toBe(false);
    expect(isTextModel({ name: 'nomic-embed-text:latest' })).toBe(false);
    expect(isTextModel({ name: 'nomic-embed-text', capabilities: ['completion'] })).toBe(false);
    expect(isTextModel({ name: 'qwen2.5:3b', capabilities: ['completion'] })).toBe(true);
  });

  it('automatic model choice never picks it', () => {
    const asModels = [
      { name: 'nomic-embed-text:latest', sizeBytes: 2.7e8, parameterSize: '137M', parameterCount: null, capabilities: [], contextLength: 2048 },
      { name: 'qwen2.5:3b', sizeBytes: 1.9e9, parameterSize: '3.1B', parameterCount: null, capabilities: ['completion', 'tools'], contextLength: 32768 },
    ];
    expect(pickAutoModels(asModels, { maxParamsB: 14 })).toEqual({ tools: 'qwen2.5:3b', chat: 'qwen2.5:3b' });
  });

  it('chat still works and does not pick the embed model when both are installed', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true, chat: () => textReply('hello') });
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.model).toBe('qwen2.5:3b');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    expect(fake.chatBodies[0].model).toBe('qwen2.5:3b');
  });
});

describe('getEmbedClient', () => {
  it('returns a local client for the installed search model', async () => {
    installFakeOllama(fetch, { embedModel: true });
    const client = await getEmbedClient();
    expect(client).toMatchObject({ model: EMBED_MODEL_ENTRY.name, host: HOST, ai: { kind: 'local', host: null }, stats: { calls: 0 } });
    expect(client.embed).toEqual(expect.any(Function));
  });

  it('embed() returns vectors and counts one call per request, not per input', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    const client = await getEmbedClient();
    const out = await client.embed({ inputs: ['search_document: alpha', 'search_document: beta', 'search_document: gamma'] });
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(client.stats.calls).toBe(1);
    await client.embed({ inputs: ['x'] });
    expect(client.stats.calls).toBe(2);
    expect(fake.embedBodies.map((b) => b.model)).toEqual([EMBED_MODEL_ENTRY.name, EMBED_MODEL_ENTRY.name]);
    expect(fake.embedBodies[0].truncate).toBe(true);
  });

  it('no inputs gives no vectors and no request', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    const client = await getEmbedClient();
    expect(await client.embed({ inputs: [] })).toEqual([]);
    expect(await client.embed({})).toEqual([]);
    expect(client.stats.calls).toBe(0);
    expect(fake.embedBodies).toEqual([]);
  });

  it('an already aborted signal rejects before any request', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    const client = await getEmbedClient();
    await expect(client.embed({ inputs: ['x'], signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.embedBodies).toEqual([]);
  });

  describe('when the search model is not installed', () => {
    it('throws ai_not_configured with reason no_embed_model and the fixed copy, and sends no embed request', async () => {
      const fake = installFakeOllama(fetch); // chat models only
      let caught;
      try {
        await getEmbedClient();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AiUnavailableError);
      expect(caught).toMatchObject({ code: 'ai_not_configured', reason: 'no_embed_model', httpStatus: 503 });
      expect(AI_REASONS.noEmbedModel).toBe('no_embed_model');
      expect(MSG_NO_EMBED_MODEL).toBe('Questions need the nomic-embed-text model. Download it on the Folders page, then click Re-scan.');
      expect(caught.publicMessage).toBe(MSG_NO_EMBED_MODEL);
      expect(aiErrorBody(caught)).toMatchObject({ error: 'ai_not_configured', reason: 'no_embed_model', message: MSG_NO_EMBED_MODEL });
      expect(classifyAiError(caught)).toMatchObject({ code: 'ai_not_configured', reason: 'no_embed_model', httpStatus: 503, message: MSG_NO_EMBED_MODEL });
      expect(fake.embedBodies).toEqual([]);
    });

    it('a model removed after the client was made becomes the same error', async () => {
      installFakeOllama(fetch, { embedModel: true });
      const client = await getEmbedClient();
      fetch.mockImplementation(async () => reply('model "nomic-embed-text:latest" not found, try pulling it first', 404));
      await expect(client.embed({ inputs: ['x'] })).rejects.toMatchObject({ code: 'ai_not_configured', reason: 'no_embed_model' });
    });
  });

  it('AI turned off is ai_not_configured (disabled) and nothing is requested', async () => {
    const fake = installFakeOllama(fetch, { embedModel: true });
    process.env.BURROW_AI = '0';
    __resetAiForTests();
    await expect(getEmbedClient()).rejects.toMatchObject({ code: 'ai_not_configured', reason: AI_REASONS.disabled });
    expect(fake.urls).toEqual([]);
  });

  it('Ollama not running is ollama_unavailable', async () => {
    installFakeOllama(fetch, { embedModel: true, down: true });
    await expect(getEmbedClient()).rejects.toMatchObject({ code: 'ollama_unavailable', reason: 'ollama_unavailable' });
  });

  it('Ollama going away during a call is ollama_unavailable', async () => {
    installFakeOllama(fetch, { embedModel: true });
    const client = await getEmbedClient();
    fetch.mockImplementation(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    await expect(client.embed({ inputs: ['x'] })).rejects.toMatchObject({ code: 'ollama_unavailable' });
  });

  describe('never a cloud provider', () => {
    it('with cloud AI configured and consented, embeddings still go to the local Ollama only', async () => {
      await configureCloud({ categories: { folders: true } });
      const { cloud, local } = installCloudAndOllama(fetch, { ollama: { embedModel: true } });
      const client = await getEmbedClient();
      expect(client.ai).toEqual({ kind: 'local', host: null });
      const vectors = await client.embed({ inputs: ['search_query: where are the tomatoes'] });
      expect(vectors).toHaveLength(1);
      expect(cloud.requests).toEqual([]);
      expect(local.embedBodies).toHaveLength(1);
      expect(local.urls.every((u) => hostOf(u) === '127.0.0.1')).toBe(true);
      expect(fetch.mock.calls.every(([url]) => hostOf(String(url)) === '127.0.0.1')).toBe(true);
    });

    it('with cloud configured and the local Ollama down it fails; it does not fall back to the cloud', async () => {
      await configureCloud({ categories: { folders: true } });
      const { cloud } = installCloudAndOllama(fetch, { ollama: { embedModel: true, down: true } });
      await expect(getEmbedClient()).rejects.toMatchObject({ code: 'ollama_unavailable' });
      expect(cloud.requests).toEqual([]);
    });

    it('with cloud configured and no search model installed it is no_embed_model, not a cloud call', async () => {
      await configureCloud({ categories: { folders: true } });
      const { cloud } = installCloudAndOllama(fetch, { ollama: { embedModel: false } });
      await expect(getEmbedClient()).rejects.toMatchObject({ reason: 'no_embed_model' });
      expect(cloud.requests).toEqual([]);
    });
  });

  describe('another computer on the network', () => {
    const LAN = 'http://192.0.2.50:11434';

    it('is refused without the aiLan opt-in and never contacted', async () => {
      process.env.OLLAMA_HOST = LAN;
      const fake = installFakeOllama(fetch, { embedModel: true });
      __resetAiForTests();
      await expect(getEmbedClient()).rejects.toMatchObject({
        code: 'ollama_unavailable',
        reason: AI_REASONS.optInRequired,
        message: `Using Ollama at ${LAN} needs the "Ollama on another computer" switch in Settings > Network.`,
        hint: 'This Ollama is on another computer. Turn on "Ollama on another computer" in Settings > Network.',
      });
      expect(fake.urls).toEqual([]);
    });

    it('with the opt-in the client says `lan` and names the host', async () => {
      process.env.OLLAMA_HOST = LAN;
      await setState(NETWORK_STATE_KEY, { aiLan: true });
      __resetNetPolicyForTests();
      const fake = installFakeOllama(fetch, { embedModel: true });
      __resetAiForTests();
      const client = await getEmbedClient();
      expect(client.ai).toEqual({ kind: 'lan', host: '192.0.2.50' });
      await client.embed({ inputs: ['x'] });
      expect(fake.urls.every((u) => hostOf(u) === '192.0.2.50')).toBe(true);
    });
  });

  describe('goes through the shared AI queue', () => {
    /** A chat call that holds the single slot until release(). */
    async function holdSlot() {
      let release = () => {};
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let first = true;
      const fake = installFakeOllama(fetch, {
        embedModel: true,
        chat: (body, init) => {
          if (!first) return textReply('later');
          first = false;
          return new Promise((resolve, reject) => {
            held.then(() => resolve(textReply('held')));
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          });
        },
      });
      const chatClient = await getAiClient({ purpose: 'chat' });
      const call = chatClient.complete({ messages: [{ role: 'user', content: 'hold' }], maxTokens: 5 });
      call.catch(() => {});
      await vi.waitFor(() => expect(fake.chatBodies).toHaveLength(1));
      return { fake, release: () => release(), call };
    }

    it('waits for a running chat call and only then sends the embed request', async () => {
      const held = await holdSlot();
      const client = await getEmbedClient();
      const pending = client.embed({ inputs: ['x'] });
      await new Promise((r) => setTimeout(r, 60));
      expect(held.fake.embedBodies).toEqual([]);
      expect(client.stats.calls).toBe(0);
      held.release();
      await held.call;
      expect(await pending).toHaveLength(1);
      expect(held.fake.embedBodies).toHaveLength(1);
      expect(client.stats.calls).toBe(1);
    });

    it('a chat call waits for a running embed call (one slot for everything)', async () => {
      installFakeOllama(fetch, { embedModel: true, chat: () => textReply('chat done') });
      const order = [];
      let letEmbedFinish = () => {};
      const gate = new Promise((resolve) => {
        letEmbedFinish = resolve;
      });
      const base = fetch.getMockImplementation();
      fetch.mockImplementation(async (url, init) => {
        const { pathname } = new URL(url);
        if (pathname === '/api/embed') {
          order.push('embed:start');
          await gate;
          order.push('embed:end');
        }
        if (pathname === '/api/chat') order.push('chat:start');
        return base(url, init);
      });
      const embedClient = await getEmbedClient();
      const chatClient = await getAiClient({ purpose: 'chat' });
      const e = embedClient.embed({ inputs: ['x'] });
      await vi.waitFor(() => expect(order).toContain('embed:start'));
      const c = chatClient.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
      await new Promise((r) => setTimeout(r, 60));
      expect(order).toEqual(['embed:start']);
      letEmbedFinish();
      await Promise.all([e, c]);
      expect(order).toEqual(['embed:start', 'embed:end', 'chat:start']);
    });

    it('a full queue refuses the embed call with AiBusyError', async () => {
      process.env.BURROW_AI_QUEUE_MAX = '0';
      __resetAiForTests();
      const held = await holdSlot();
      const client = await getEmbedClient();
      await expect(client.embed({ inputs: ['x'] })).rejects.toBeInstanceOf(AiBusyError);
      expect(held.fake.embedBodies).toEqual([]);
      held.release();
      await held.call;
    });

    it('aborting while waiting leaves the queue without sending anything', async () => {
      const held = await holdSlot();
      const client = await getEmbedClient();
      const controller = new AbortController();
      const pending = client.embed({ inputs: ['x'], signal: controller.signal });
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      held.release();
      await held.call;
      expect(held.fake.embedBodies).toEqual([]);
    });

    it('the slot is released after a failed call', async () => {
      installFakeOllama(fetch, { embedModel: true, chat: () => textReply('ok') });
      const client = await getEmbedClient();
      const base = fetch.getMockImplementation();
      fetch.mockImplementationOnce(async () => {
        throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      });
      await expect(client.embed({ inputs: ['x'] })).rejects.toBeTruthy();
      fetch.mockImplementation(base);
      const chat = await getAiClient({ purpose: 'chat' });
      expect((await chat.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 })).content).toBe('ok');
    });
  });
});

describe('the fake Ollama used by these tests', () => {
  it('lists the search model only on request, and knows the chat models', () => {
    expect(MODELS.map((m) => m.name)).not.toContain('nomic-embed-text:latest');
    const fake = installFakeOllama(fetch, { embedModel: true });
    expect(fake.embedBodies).toEqual([]);
    expect(hangingChat).toEqual(expect.any(Function));
  });
});
