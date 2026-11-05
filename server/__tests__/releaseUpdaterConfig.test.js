import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MISSING_SIGNING_MESSAGE,
  PUBKEY_PLACEHOLDER,
  RELEASE_OVERLAY,
  assertSigningEnv,
  isUpdaterEnabled,
  readReleaseOverlay,
  signingEnvForTauri,
  updaterState,
  withoutSigningEnv,
} from '../../scripts/release/updaterConfig.js';
import { makeOverlayRoot, makeTestKey } from './helpers/updaterSigning.js';

const KEY = 'TAURI_SIGNING_PRIVATE_KEY';
const KEY_PATH = 'TAURI_SIGNING_PRIVATE_KEY_PATH';
const PASSWORD = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';

describe('release overlay: placeholder or real key', () => {
  const cleanups = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
  const overlay = (pubkey) => {
    const made = makeOverlayRoot(pubkey);
    cleanups.push(made.cleanup);
    return made.root;
  };

  it('the placeholder means the updater is off', () => {
    const root = overlay(PUBKEY_PLACEHOLDER);
    expect(readReleaseOverlay(root)).toMatchObject({ enabled: false, pubkey: PUBKEY_PLACEHOLDER });
    expect(isUpdaterEnabled(root)).toBe(false);
    expect(updaterState(root)).toEqual({ enabled: false, pubkey: null });
  });

  it('a valid minisign public key means it is on', () => {
    const { pubkeyB64 } = makeTestKey();
    const root = overlay(pubkeyB64);
    expect(isUpdaterEnabled(root)).toBe(true);
    expect(updaterState(root)).toEqual({ enabled: true, pubkey: pubkeyB64 });
  });

  it('a missing overlay file is off (a checkout without the feature)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-noov-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    expect(readReleaseOverlay(root)).toBeNull();
    expect(isUpdaterEnabled(root)).toBe(false);
  });

  it('a malformed key, missing key or broken JSON throws instead of silently turning the updater off', () => {
    expect(() => readReleaseOverlay(overlay('garbage-not-base64!'))).toThrow(/neither the placeholder nor a valid minisign public key/);
    expect(() => readReleaseOverlay(overlay(Buffer.from('untrusted comment: x\nAAAA\n').toString('base64')))).toThrow(/valid minisign public key/);
    expect(() => readReleaseOverlay(overlay(''))).toThrow(/no plugins.updater.pubkey/);
    const root = overlay(PUBKEY_PLACEHOLDER);
    fs.writeFileSync(path.join(root, ...RELEASE_OVERLAY.split('/')), '{ not json');
    expect(() => readReleaseOverlay(root)).toThrow(/not valid JSON/);
  });

  it('the committed overlay is either the placeholder or a valid key', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(() => readReleaseOverlay(repoRoot)).not.toThrow();
  });
});

describe('assertSigningEnv', () => {
  let root;
  let outside;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sign-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sign-out-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const keyFile = (dir) => {
    const file = path.join(dir, 'signing-test.pem-less');
    fs.writeFileSync(file, 'placeholder text, not a key');
    return file;
  };

  it('has the owner-facing message for nothing, a key without a password, and a password without a key', () => {
    for (const env of [{}, { [KEY]: 'k' }, { [KEY_PATH]: keyFile(outside) }, { [PASSWORD]: 'p' }, { [KEY]: 'k', [PASSWORD]: '' }, { [KEY]: '  ', [PASSWORD]: 'p' }]) {
      expect(() => assertSigningEnv(env, { root }), JSON.stringify(Object.keys(env))).toThrow(MISSING_SIGNING_MESSAGE);
    }
    expect(MISSING_SIGNING_MESSAGE).toContain('TAURI_SIGNING_PRIVATE_KEY (or TAURI_SIGNING_PRIVATE_KEY_PATH) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are not both set');
    expect(MISSING_SIGNING_MESSAGE).not.toContain(String.fromCharCode(0x2014));
  });

  it('accepts key text with a password', () => {
    expect(assertSigningEnv({ [KEY]: 'a-key-text', [PASSWORD]: 'pw' }, { root })).toEqual({ privateKey: 'a-key-text', password: 'pw' });
  });

  it('accepts a key file path outside the repo', () => {
    const file = keyFile(outside);
    expect(assertSigningEnv({ [KEY_PATH]: file, [PASSWORD]: 'pw' }, { root })).toEqual({ privateKey: path.resolve(file), password: 'pw' });
    expect(signingEnvForTauri({ [KEY_PATH]: file, [PASSWORD]: 'pw' })).toEqual({ [KEY]: path.resolve(file), [PASSWORD]: 'pw' });
  });

  it('refuses a key file path inside the repo, a missing path and a folder', () => {
    expect(() => assertSigningEnv({ [KEY_PATH]: keyFile(root), [PASSWORD]: 'pw' }, { root })).toThrow(/inside the repository/);
    expect(() => assertSigningEnv({ [KEY_PATH]: path.join(outside, 'nope'), [PASSWORD]: 'pw' }, { root })).toThrow(/does not exist/);
    expect(() => assertSigningEnv({ [KEY_PATH]: outside, [PASSWORD]: 'pw' }, { root })).toThrow(/must be a file/);
  });

  it('applies the same rule when TAURI_SIGNING_PRIVATE_KEY names a file', () => {
    expect(() => assertSigningEnv({ [KEY]: keyFile(root), [PASSWORD]: 'pw' }, { root })).toThrow(/inside the repository/);
    const file = keyFile(outside);
    expect(assertSigningEnv({ [KEY]: file, [PASSWORD]: 'pw' }, { root }).privateKey).toBe(path.resolve(file));
  });

  it('refuses both key variables at once', () => {
    expect(() => assertSigningEnv({ [KEY]: 'k', [KEY_PATH]: keyFile(outside), [PASSWORD]: 'pw' }, { root })).toThrow(/only one of/);
  });
});

describe('withoutSigningEnv', () => {
  it('strips every signing variable, whatever its case, and keeps the rest', () => {
    const env = {
      PATH: '/bin', BURROW_CHANNEL: 'stable',
      [KEY]: 'a', [KEY_PATH]: 'b', [PASSWORD]: 'c',
      tauri_signing_private_key: 'd', TAURI_PRIVATE_KEY: 'e', TAURI_KEY_PASSWORD: 'f', TAURI_SIGNING_ANYTHING: 'g',
    };
    expect(withoutSigningEnv(env)).toEqual({ PATH: '/bin', BURROW_CHANNEL: 'stable' });
    expect(env[KEY]).toBe('a');
  });
});
