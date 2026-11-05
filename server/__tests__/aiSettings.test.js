// Endpoint validation and settings persistence (server/ai/settings.js).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AI_SETTINGS_KEY,
  DEFAULT_OLLAMA_HOST,
  getAiSettings,
  isValidModelName,
  normalizeOllamaHost,
  resolveOllamaHost,
  resolveTokenParam,
  sanitizeAiSettings,
  updateAiSettings,
  validateEndpointUrl,
} from '../ai/settings.js';
import { setState } from '../dataAccess.js';

describe('validateEndpointUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434', true],
    ['http://localhost:11434/', 'http://localhost:11434', true],
    ['http://[::1]:11434', 'http://[::1]:11434', true],
    ['https://ollama.lan:443', 'https://ollama.lan', false],
    ['http://192.168.1.20:11434', 'http://192.168.1.20:11434', false],
    ['  http://127.0.0.2:8080  ', 'http://127.0.0.2:8080', true],
  ])('accepts %s', (raw, origin, loopback) => {
    expect(validateEndpointUrl(raw)).toMatchObject({ ok: true, origin, loopback });
  });

  it.each([
    [42, 'not_a_string'],
    ['', 'length'],
    [`http://${'a'.repeat(200)}.com`, 'length'],
    ['127.0.0.1:11434', 'unparseable'],
    ['javascript:alert(1)', 'protocol'],
    ['ftp://127.0.0.1', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['http://user:pw@127.0.0.1:11434', 'credentials'],
    ['http://127.0.0.1:11434/api', 'path'],
    ['http://127.0.0.1:11434/?x=1', 'query_or_hash'],
    ['http://127.0.0.1:11434/?', 'query_or_hash'],
    ['http://127.0.0.1:11434/#frag', 'query_or_hash'],
    ['http://0.0.0.0:11434', 'wildcard'],
    ['http://[::]:11434', 'wildcard'],
    ['http://exa mple.com', 'query_or_hash'],
    ['http://', 'unparseable'],
  ])('rejects %j (%s)', (raw, reason) => {
    expect(validateEndpointUrl(raw)).toEqual({ ok: false, reason });
  });

  it('treats a hostname that merely resolves to loopback as non-loopback', () => {
    expect(validateEndpointUrl('http://my-box.local:11434').loopback).toBe(false);
  });

  it('cloud base URLs may carry a path and must be https off this machine', () => {
    expect(validateEndpointUrl('https://api.example.com/v1/', { allowPath: true, requireHttpsForRemote: true })).toMatchObject({
      ok: true,
      url: 'https://api.example.com/v1',
    });
    expect(validateEndpointUrl('http://api.example.com/v1', { allowPath: true, requireHttpsForRemote: true })).toEqual({ ok: false, reason: 'https_required' });
    expect(validateEndpointUrl('http://127.0.0.1:8000/v1', { allowPath: true, requireHttpsForRemote: true }).ok).toBe(true);
    expect(validateEndpointUrl('https://api.example.com/v1/../x', { allowPath: true }).ok).toBe(true); // URL resolves ".." itself
  });
});

describe('normalizeOllamaHost', () => {
  it.each([
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:11434', 'http://127.0.0.1:11434'],
    ['127.0.0.1', 'http://127.0.0.1:11434'],
    ['localhost:12345', 'http://localhost:12345'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['https://ollama.example.com', 'https://ollama.example.com'],
    ['', null],
    ['http://user:pw@host', null],
  ])('%j -> %j', (raw, out) => {
    expect(normalizeOllamaHost(raw)).toBe(out);
  });
});

describe('resolveOllamaHost', () => {
  it('settings > env > default, with loopback recomputed', () => {
    expect(resolveOllamaHost({}, {})).toEqual({ host: DEFAULT_OLLAMA_HOST, hostSource: 'default', loopback: true });
    expect(resolveOllamaHost({}, { OLLAMA_HOST: '10.0.0.5' })).toEqual({ host: 'http://10.0.0.5:11434', hostSource: 'env', loopback: false });
    expect(resolveOllamaHost({ ollamaHost: 'http://localhost:9999' }, { OLLAMA_HOST: '10.0.0.5' })).toEqual({
      host: 'http://localhost:9999',
      hostSource: 'settings',
      loopback: true,
    });
    expect(resolveOllamaHost({}, { OLLAMA_HOST: 'not a url at all' }).hostSource).toBe('default');
  });
});

describe('model names and token params', () => {
  it('accepts Ollama names and rejects path tricks', () => {
    for (const ok of ['qwen2.5:7b', 'llama3', 'library/qwen2.5:3b-instruct-q4_K_M', 'hf.co/org/model:Q4']) expect(isValidModelName(ok)).toBe(true);
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(201), null, 5, '/abs']) expect(isValidModelName(bad)).toBe(false);
  });

  it('defaults to max_tokens, auto max_completion_tokens for api.openai.com', () => {
    expect(resolveTokenParam('https://cloud.example/v1', null)).toBe('max_tokens');
    expect(resolveTokenParam('https://api.openai.com/v1', null)).toBe('max_completion_tokens');
    expect(resolveTokenParam('https://api.openai.com/v1', 'max_tokens')).toBe('max_tokens');
  });
});

describe('persistence', () => {
  beforeEach(async () => {
    await setState(AI_SETTINGS_KEY, {});
  });

  it('sanitizes anything malformed', () => {
    expect(
      sanitizeAiSettings({ provider: 'bedrock', ollamaHost: 'ftp://x', chatModel: '../x', toolModel: 'qwen2.5:7b', cloud: { baseUrl: 'http://remote.example/v1', model: 'm', tokenParam: 'nope' } }),
    ).toEqual({ provider: 'ollama', ollamaHost: null, chatModel: null, toolModel: 'qwen2.5:7b', cloud: { baseUrl: null, model: 'm', tokenParam: null } });
  });

  it('round-trips a patch and merges cloud fields', async () => {
    await updateAiSettings({ chatModel: 'qwen2.5:3b', cloud: { baseUrl: 'https://cloud.example/v1' } });
    await updateAiSettings({ cloud: { model: 'gpt-x' } });
    expect(await getAiSettings()).toEqual({
      provider: 'ollama',
      ollamaHost: null,
      chatModel: 'qwen2.5:3b',
      toolModel: null,
      cloud: { baseUrl: 'https://cloud.example/v1', model: 'gpt-x', tokenParam: null },
    });
  });
});
