// End-to-end check of loadEnv.js with real env files. The rest of the suite sets BURROW_NO_DOTENV=1
// (vitest.config.js), so dotenv.config() never runs there. Here a child process imports a copy of
// loadEnv.js from a temp dir that holds synthetic .env / .env.local files. Synthetic values only.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEYS = [
  'BURROW_TEST_DOTENV_A',
  'BURROW_TEST_DOTENV_B',
  'BURROW_TEST_DOTENV_C',
  'BURROW_TEST_DOTENV_D',
  'BURROW_TEST_DOTENV_E',
  'BURROW_TEST_DOTENV_ML',
];

const PRIMARY = [
  'BURROW_TEST_DOTENV_A=alpha',
  'BURROW_TEST_DOTENV_B=from_primary',
  'BURROW_TEST_DOTENV_D=primary_d',
  'BURROW_TEST_DOTENV_ML="first line\nsecond line"',
  '',
].join('\n');

const LOCAL = [
  'BURROW_TEST_DOTENV_C=local_c',
  'BURROW_TEST_DOTENV_D=local_d',
  'BURROW_TEST_DOTENV_E=local_e',
  '',
].join('\n');

const PROBE = `await import('./loadEnv.js');
const keys = ${JSON.stringify(KEYS)};
const out = {};
for (const k of keys) if (process.env[k] !== undefined) out[k] = process.env[k];
process.stdout.write(JSON.stringify(out));
`;

const tmpDirs = [];

function makeSandbox({ primary = PRIMARY, local = LOCAL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-loadenv-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.copyFileSync(path.join(repoRoot, 'loadEnv.js'), path.join(dir, 'loadEnv.js'));
  // runtime.js only imports node builtins and reads ../package.json lazily (try/catch), so no stubs needed.
  fs.copyFileSync(path.join(repoRoot, 'server', 'runtime.js'), path.join(dir, 'server', 'runtime.js'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'probe.mjs'), PROBE);
  if (primary !== null) fs.writeFileSync(path.join(dir, '.env'), primary);
  if (local !== null) fs.writeFileSync(path.join(dir, '.env.local'), local);
  return dir;
}

function runProbe(dir, extraEnv = {}) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extraEnv };
  const res = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: res.stdout ? JSON.parse(res.stdout) : null };
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('loadEnv.js with real env files', () => {
  it('loads a key from the primary file', () => {
    const r = runProbe(makeSandbox());
    expect(r.status).toBe(0);
    expect(r.json.BURROW_TEST_DOTENV_A).toBe('alpha');
  });

  it('lets the primary file win over a value in the spawn env (override: true)', () => {
    const r = runProbe(makeSandbox(), { BURROW_TEST_DOTENV_B: 'from_spawn' });
    expect(r.json.BURROW_TEST_DOTENV_B).toBe('from_primary');
  });

  it('adds new keys from the local file without overriding primary or spawn env values', () => {
    const r = runProbe(makeSandbox(), { BURROW_TEST_DOTENV_E: 'from_spawn' });
    expect(r.json.BURROW_TEST_DOTENV_C).toBe('local_c');
    expect(r.json.BURROW_TEST_DOTENV_D).toBe('primary_d');
    expect(r.json.BURROW_TEST_DOTENV_E).toBe('from_spawn');
  });

  it('lets the local file fill a key that nothing else set', () => {
    const r = runProbe(makeSandbox());
    expect(r.json.BURROW_TEST_DOTENV_E).toBe('local_e');
  });

  it('parses a multiline double-quoted value', () => {
    const r = runProbe(makeSandbox());
    expect(r.json.BURROW_TEST_DOTENV_ML).toBe('first line\nsecond line');
  });

  it('prints nothing but the probe JSON (quiet: true)', () => {
    const r = runProbe(makeSandbox());
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(JSON.stringify(r.json));
    expect(Object.keys(r.json).sort()).toEqual(KEYS);
  });

  it('loads nothing when BURROW_NO_DOTENV=1', () => {
    const r = runProbe(makeSandbox(), { BURROW_NO_DOTENV: '1' });
    expect(r.status).toBe(0);
    expect(r.json).toEqual({});
  });

  it('loads nothing in desktop mode (BURROW_DESKTOP=1)', () => {
    const r = runProbe(makeSandbox(), { BURROW_DESKTOP: '1' });
    expect(r.status).toBe(0);
    expect(r.json).toEqual({});
  });

  it('does not throw when the env files are missing', () => {
    const r = runProbe(makeSandbox({ primary: null, local: null }), { BURROW_TEST_DOTENV_B: 'from_spawn' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.json).toEqual({ BURROW_TEST_DOTENV_B: 'from_spawn' });
  });
});
