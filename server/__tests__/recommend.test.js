// Pure model recommendation and Ollama install detection; plus a guard that a recommended
// install is what pickAutoModels will actually choose for chat and tools.
import { describe, expect, it } from 'vitest';
import { PULLABLE_MODELS, detectOllamaInstall, recommendModels } from '../ai/recommend.js';
import { pickAutoModels } from '../ai/registry.js';

const GIB = 1024 ** 3;
const names = (list) => list.map((r) => r.name);

describe('recommendModels tiers', () => {
  it.each([
    [5.9, 'tiny', ['llama3.2:1b'], []],
    [6, 'small', ['llama3.2:3b'], []],
    [7.8, 'small', ['llama3.2:3b'], []],
    [10, 'medium', ['llama3.2:3b'], ['qwen2.5:7b']],
    [12, 'medium', ['llama3.2:3b'], ['qwen2.5:7b']],
    [14.5, 'large', ['qwen2.5:7b', 'llama3.2:3b'], []],
    [15.7, 'large', ['qwen2.5:7b', 'llama3.2:3b'], []],
  ])('%s GiB -> %s', (gib, tier, primary, optional) => {
    const rec = recommendModels(gib * GIB);
    expect(rec.tier).toBe(tier);
    expect(names(rec.primary)).toEqual(primary);
    expect(names(rec.optional)).toEqual(optional);
    expect(rec.ramGb).toBeCloseTo(gib, 1);
  });

  it('large tier: qwen for tools, llama for fast chat', () => {
    const rec = recommendModels(16 * GIB);
    expect(rec.primary.map((r) => [r.name, r.purpose])).toEqual([
      ['qwen2.5:7b', 'tools'],
      ['llama3.2:3b', 'chat'],
    ]);
  });

  it('treats a bad value as tiny and never throws', () => {
    for (const v of [0, -1, NaN, undefined, null, 'x']) expect(recommendModels(v).tier).toBe('tiny');
  });

  it('every recommendation is allowlisted, complete and free of dashes', () => {
    for (const gib of [2, 8, 12, 32]) {
      const rec = recommendModels(gib * GIB);
      for (const r of [...rec.primary, ...rec.optional]) {
        expect(PULLABLE_MODELS.has(r.name)).toBe(true);
        expect(r.downloadGb).toBeGreaterThan(0);
        expect(['chat', 'tools', 'both']).toContain(r.purpose);
        expect(r.reason.length).toBeGreaterThan(10);
        expect(r.reason).not.toMatch(/\u2014|\u2013/);
      }
    }
    expect([...PULLABLE_MODELS].sort()).toEqual(['llama3.2:1b', 'llama3.2:3b', 'nomic-embed-text', 'qwen2.5:7b']);
    // The search model for Folders is pullable on a click only: no tier ever recommends it.
    for (const gib of [2, 8, 12, 32]) {
      const rec = recommendModels(gib * GIB);
      expect([...rec.primary, ...rec.optional].map((r) => r.name)).not.toContain('nomic-embed-text');
    }
  });

  it('returns fresh objects (callers cannot mutate the tables)', () => {
    recommendModels(16 * GIB).primary[0].name = 'x';
    expect(recommendModels(16 * GIB).primary[0].name).toBe('qwen2.5:7b');
  });
});

describe('a recommended install becomes the chat and tools model (pickAutoModels)', () => {
  const MODEL = {
    'llama3.2:1b': { name: 'llama3.2:1b', capabilities: ['completion', 'tools'], parameterSize: '1.2B', sizeBytes: 1.3e9 },
    'llama3.2:3b': { name: 'llama3.2:3b', capabilities: ['completion', 'tools'], parameterSize: '3.2B', sizeBytes: 2e9 },
    'qwen2.5:7b': { name: 'qwen2.5:7b', capabilities: ['completion', 'tools'], parameterSize: '7.6B', sizeBytes: 4.7e9 },
  };
  const installed = (rec, withOptional) => [...rec.primary, ...(withOptional ? rec.optional : [])].map((r) => MODEL[r.name]);

  it('tiny and small: the single model serves both', () => {
    expect(pickAutoModels(installed(recommendModels(4 * GIB)))).toEqual({ tools: 'llama3.2:1b', chat: 'llama3.2:1b' });
    expect(pickAutoModels(installed(recommendModels(8 * GIB)))).toEqual({ tools: 'llama3.2:3b', chat: 'llama3.2:3b' });
  });

  it('medium with the optional model, and large: qwen tools, llama chat', () => {
    expect(pickAutoModels(installed(recommendModels(12 * GIB), true))).toEqual({ tools: 'qwen2.5:7b', chat: 'llama3.2:3b' });
    expect(pickAutoModels(installed(recommendModels(16 * GIB)))).toEqual({ tools: 'qwen2.5:7b', chat: 'llama3.2:3b' });
  });
});

describe('detectOllamaInstall', () => {
  const only =
    (...paths) =>
    (p) =>
      paths.includes(p);
  const LAD = 'C:\\Users\\user\\AppData\\Local';

  it('windows: %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe', () => {
    const exe = `${LAD}\\Programs\\Ollama\\ollama.exe`;
    expect(detectOllamaInstall({ platform: 'win32', env: { LOCALAPPDATA: LAD }, exists: only(exe) })).toBe(true);
    expect(detectOllamaInstall({ platform: 'win32', env: { LOCALAPPDATA: `${LAD}\\` }, exists: only(exe) })).toBe(true);
    expect(detectOllamaInstall({ platform: 'win32', env: { LOCALAPPDATA: LAD }, exists: only() })).toBe(false);
    expect(detectOllamaInstall({ platform: 'win32', env: {}, exists: () => true })).toBe(false);
    expect(detectOllamaInstall({ platform: 'win32', env: { LOCALAPPDATA: LAD }, exists: only('/usr/bin/ollama') })).toBe(false);
  });

  it('macOS: the app, /usr/local/bin, or homebrew', () => {
    for (const p of ['/Applications/Ollama.app', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']) {
      expect(detectOllamaInstall({ platform: 'darwin', env: {}, exists: only(p) })).toBe(true);
    }
    expect(detectOllamaInstall({ platform: 'darwin', env: {}, exists: only('/usr/bin/ollama') })).toBe(false);
    expect(detectOllamaInstall({ platform: 'darwin', env: {}, exists: only() })).toBe(false);
  });

  it('linux: /usr/local/bin or /usr/bin only', () => {
    for (const p of ['/usr/local/bin/ollama', '/usr/bin/ollama']) {
      expect(detectOllamaInstall({ platform: 'linux', env: {}, exists: only(p) })).toBe(true);
    }
    expect(detectOllamaInstall({ platform: 'linux', env: {}, exists: only('/opt/homebrew/bin/ollama', '/Applications/Ollama.app') })).toBe(false);
  });

  it('unknown platform, missing probe, or a throwing probe is false', () => {
    expect(detectOllamaInstall({ platform: 'freebsd', env: {}, exists: () => true })).toBe(false);
    expect(detectOllamaInstall({ platform: 'linux', env: {} })).toBe(false);
    const boom = () => {
      throw new Error('denied');
    };
    expect(detectOllamaInstall({ platform: 'linux', env: {}, exists: boom })).toBe(false);
  });
});

describe('recommendModels as os.totalmem reports real machines', () => {
  it.each([
    ['an 8 GiB machine', 8 * GIB, 'small'],
    ['an 8 GiB machine reporting 7.8 GiB usable', Math.floor(7.8 * GIB), 'small'],
    ['a 16 GiB machine', 16 * GIB, 'large'],
    ['a 16 GiB machine reporting 15.7 GiB usable', Math.floor(15.7 * GIB), 'large'],
    ['just below the medium ceiling', 14.49 * GIB, 'medium'],
    ['a 4 GiB machine', 4 * GIB, 'tiny'],
    ['a huge machine', 1024 * GIB, 'large'],
  ])('%s -> %s', (_label, bytes, tier) => {
    expect(recommendModels(bytes).tier).toBe(tier);
  });
});
