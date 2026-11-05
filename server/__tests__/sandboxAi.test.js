// Sandbox AI isolation: a sandbox must never reach the real Ollama on 127.0.0.1:11434 unless the
// owner passes --real-ai. The pure builders are unit-tested; the integration tests start the real
// server.js as a child on a temp data dir with the env the sandbox would give it, and assert on the
// env, the child's own reported Ollama host and the fake's request log. (The network guard only
// covers this process, and 11434 may be occupied by a real Ollama, so nothing here binds it.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeOllama, FAKE_MODEL_NAME } from '../../scripts/lib/fakeOllamaServer.js';
import {
  REAL_OLLAMA_PORT,
  SandboxSafetyError,
  assertAiEnvSafe,
  buildAiEnv,
  buildChildEnv,
  freePort,
  resolveAiMode,
  savedOllamaHost,
} from '../../scripts/lib/sandboxSafety.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostOf = (env) => new URL(env.OLLAMA_HOST);

describe('resolveAiMode', () => {
  it('defaults to the fake and maps the flags', () => {
    expect(resolveAiMode({})).toBe('fake');
    expect(resolveAiMode()).toBe('fake');
    expect(resolveAiMode({ realAi: true })).toBe('real');
    expect(resolveAiMode({ noAi: true })).toBe('none');
  });

  it('rejects contradictory flags', () => {
    expect(() => resolveAiMode({ realAi: true, noAi: true })).toThrow(SandboxSafetyError);
  });
});

describe('buildAiEnv and assertAiEnvSafe', () => {
  it('never targets port 11434 without --real-ai', () => {
    const fake = buildAiEnv({ mode: 'fake', fakeUrl: 'http://127.0.0.1:47123' });
    const none = buildAiEnv({ mode: 'none', deadPort: 47124 });
    for (const env of [fake, none]) {
      expect(hostOf(env).port).not.toBe(String(REAL_OLLAMA_PORT));
      expect(env.OLLAMA_HOST).not.toMatch(/11434/);
    }
    expect(() => assertAiEnvSafe('fake', fake)).not.toThrow();
    expect(() => assertAiEnvSafe('none', none)).not.toThrow();
  });

  it('only real mode targets 127.0.0.1:11434', () => {
    const real = buildAiEnv({ mode: 'real' });
    expect(real.OLLAMA_HOST).toBe('http://127.0.0.1:11434');
    expect(() => assertAiEnvSafe('real', real)).not.toThrow();
  });

  it('asserts before spawn: every spelling of the real Ollama is refused outside real mode', () => {
    const bad = [
      undefined,
      '',
      'http://127.0.0.1:11434',
      'http://localhost:11434',
      'http://localhost:11434/',
      'http://[::1]:11434',
      'http://user:pw@127.0.0.1:47000',
      '127.0.0.1:11434',
      'localhost',
      'http://127.0.0.1',
      'http://192.168.1.4:47000',
      'https://127.0.0.1:47000',
      'http://127.0.0.1:80',
    ];
    for (const value of bad) {
      for (const mode of ['fake', 'none']) {
        expect(() => assertAiEnvSafe(mode, { OLLAMA_HOST: value }), `${mode} ${value}`).toThrow(SandboxSafetyError);
      }
    }
    expect(() => assertAiEnvSafe('fake', {})).toThrow(SandboxSafetyError);
    expect(() => assertAiEnvSafe('bogus', { OLLAMA_HOST: 'http://127.0.0.1:47000' })).toThrow(SandboxSafetyError);
  });

  it('real mode must really point at 11434', () => {
    expect(() => assertAiEnvSafe('real', { OLLAMA_HOST: 'http://127.0.0.1:47000' })).toThrow(SandboxSafetyError);
  });

  it('refuses incomplete inputs', () => {
    expect(() => buildAiEnv({ mode: 'fake' })).toThrow(SandboxSafetyError);
    expect(() => buildAiEnv({ mode: 'none' })).toThrow(SandboxSafetyError);
    expect(() => buildAiEnv({ mode: 'other' })).toThrow(SandboxSafetyError);
  });

  it('does not inherit the developer OLLAMA_HOST into the child env', () => {
    const env = buildChildEnv({ source: { PATH: '/bin', OLLAMA_HOST: 'http://127.0.0.1:11434' }, platform: 'linux', extra: buildAiEnv({ mode: 'fake', fakeUrl: 'http://127.0.0.1:47123' }) });
    expect(env.OLLAMA_HOST).toBe('http://127.0.0.1:47123');
  });
});

describe('savedOllamaHost', () => {
  it('is null for a missing file or an unreadable one', () => {
    expect(savedOllamaHost(path.join(os.tmpdir(), 'burrow-no-such-file.db'))).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-savedhost-'));
    try {
      const file = path.join(dir, 'burrow.db');
      fs.writeFileSync(file, 'not a database');
      expect(savedOllamaHost(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sandbox server with the AI env (child process)', () => {
  let dir;
  let fake;
  let child;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sandboxai-'));
  });
  afterEach(async () => {
    child?.kill();
    await new Promise((resolve) => (child && child.exitCode === null ? child.once('exit', resolve) : resolve()));
    child = null;
    await fake?.close();
    fake = null;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  async function startServer(mode, aiEnv) {
    const env = buildChildEnv({
      homeDir: path.join(dir, 'home'),
      extra: {
        ...aiEnv,
        BURROW_NO_DOTENV: '1',
        BURROW_DATA_DIR: dir,
        BURROW_HOST: '127.0.0.1',
        BURROW_PORT: String(await freePort()),
        BURROW_SCHEDULER: '0',
        BURROW_NETWORK_OPTIN: '',
      },
    });
    assertAiEnvSafe(mode, env);
    child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 20_000);
      child.once('exit', (code) => reject(new Error(`server exited (${code})`)));
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('Data: ')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return { env, base: `http://127.0.0.1:${env.BURROW_PORT}` };
  }

  it('fake mode: setup reports Ollama running with the fake model and the child uses the fake host', async () => {
    fake = await startFakeOllama();
    const { env, base } = await startServer('fake', buildAiEnv({ mode: 'fake', fakeUrl: fake.url }));
    expect(env.OLLAMA_HOST).toBe(fake.url);

    const setup = (await (await fetch(`${base}/api/settings/ai/setup`)).json()).data;
    expect(setup.ollama).toBe('running');
    expect(setup.host).toBe(fake.url);
    expect(setup.host).not.toMatch(/11434/);
    expect(setup.models.map((m) => m.name)).toContain(FAKE_MODEL_NAME);
    expect(setup.ready).toBe(true);
    expect(setup.canPull).toBe(true);

    const status = (await (await fetch(`${base}/api/settings/ai`)).json()).data;
    expect(status.ollama.host).toBe(fake.url);
    expect(status.ollama.hostSource).toBe('env');
    expect(fake.requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/api/version', '/api/tags']));
  });

  it('none mode: the child points at a dead port, reports Ollama not running and the fake sees nothing', async () => {
    fake = await startFakeOllama();
    const deadPort = await freePort();
    const aiEnv = buildAiEnv({ mode: 'none', deadPort });
    const { base } = await startServer('none', aiEnv);
    const setup = (await (await fetch(`${base}/api/settings/ai/setup`)).json()).data;
    expect(setup.host).toBe(`http://127.0.0.1:${deadPort}`);
    expect(setup.host).not.toMatch(/11434/);
    expect(setup.ollama).not.toBe('running');
    expect(setup.canPull).toBe(false);
    expect(fake.requests).toEqual([]);
  });
});
