// Local secrets.key fallback: created once, reused, env var wins, never overwritten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { KEY_FILE_NAME, loadOrCreateKeyFile, resolveEncryptionKey } from '../secrets/keyFile.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-keyfile-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateKeyFile', () => {
  it('creates a base64 32-byte key once and reuses it', () => {
    const first = loadOrCreateKeyFile({ dir });
    expect(first.ok).toBe(true);
    expect(first.key).toHaveLength(32);
    const file = path.join(dir, KEY_FILE_NAME);
    const stored = fs.readFileSync(file, 'utf8');
    expect(Buffer.from(stored.trim(), 'base64')).toEqual(first.key);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const second = loadOrCreateKeyFile({ dir });
    expect(second.ok && second.key.equals(first.key)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(stored);
  });

  it('never overwrites a corrupt key file', () => {
    const file = path.join(dir, KEY_FILE_NAME);
    fs.writeFileSync(file, 'garbage');
    expect(loadOrCreateKeyFile({ dir })).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.readFileSync(file, 'utf8')).toBe('garbage');
  });

  it('reports unavailable when the directory cannot be written', () => {
    expect(loadOrCreateKeyFile({ dir: path.join(dir, 'missing', 'nested') })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('resolveEncryptionKey', () => {
  it('falls back to the key file when the env var is unset', () => {
    const res = resolveEncryptionKey({}, { dir });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(true);
  });

  it('env var wins and no file is created', () => {
    const key = randomBytes(32);
    const res = resolveEncryptionKey({ SECRETS_ENCRYPTION_KEY: key.toString('base64') }, { dir });
    expect(res.ok && res.key.equals(key)).toBe(true);
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
  });

  it('an invalid env var is reported, not replaced by the file', () => {
    expect(resolveEncryptionKey({ SECRETS_ENCRYPTION_KEY: 'short' }, { dir })).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
  });

  it('useKeyFile=false keeps the missing state', () => {
    expect(resolveEncryptionKey({}, { dir, useKeyFile: false })).toEqual({ ok: false, reason: 'missing' });
  });
});
