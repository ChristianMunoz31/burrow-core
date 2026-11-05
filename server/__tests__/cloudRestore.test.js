// Restore never moves cloud AI back on: consent, categories, provider/base URL and the saved key all
// keep their LIVE values (the snapshot's rows for them are discarded). Plus guards that every
// cloud app_state key is listed for restore, and that a broken cloud setup falls back to local.
// Fakes only: api.example.com, sk-test-fake, the per-file temp data dir.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

// Real secrets module, except getSecret can be told to fail (real failure injection at the seam
// the registry reads the cloud key through).
const secretsFault = vi.hoisted(() => ({ fail: false }));
vi.mock('../secrets/index.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    getSecret: (...args) => (secretsFault.fail ? Promise.reject(new Error('secrets unavailable')) : real.getSecret(...args)),
  };
});

import fetch from 'node-fetch';
import * as consentModule from '../ai/consent.js';
import { clearCloudConsent } from '../ai/consent.js';
import { __resetAiForTests, getAiClient } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { createBackup } from '../backup/service.js';
import { RESTORE_CARRY_KEYS, restoreBackup } from '../backup/restore.js';
import { getDb } from '../db/index.js';
import { getState, setState } from '../dataAccess.js';
import { CLOUD_APP_STATE_KEYS } from '../import/importExport.js';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import { encryptSecret, last4, loadEncryptionKey } from '../secrets/crypto.js';
import { __resetSecretsForTests, invalidateSecrets } from '../secrets/getSecret.js';
import { cleanupBackupEnv, day, resetBackupEnv, rewriteBackupDb } from './helpers/backupEnv.js';
import { CLOUD_BASE_URL, CLOUD_HOST, CLOUD_KEY, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OTHER_BASE_URL = 'https://llm.example.org/v1';
const KEY_NAME = 'AI_CLOUD_API_KEY';
const savedEnv = { enc: process.env.SECRETS_ENCRYPTION_KEY };

const touchedCloud = () => fetch.mock.calls.some(([url]) => String(url).includes(CLOUD_HOST));
const stateRow = (key) => getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key);
const backUp = async () => (await createBackup({ kind: 'manual', now: day(1) })).meta;
const restore = (id) => restoreBackup({ id, now: day(2) });

function freshClientState() {
  __resetNetPolicyForTests();
  __resetAiForTests();
  invalidateSecrets();
}

/** Save the cloud key as an encrypted app_secrets row (the way Settings stores it), no env key. */
function saveDbKey(value = CLOUD_KEY) {
  const enc = loadEncryptionKey(process.env);
  if (!enc.ok) throw new Error('test encryption key missing');
  const e = encryptSecret(value, KEY_NAME, enc.key);
  getDb()
    .prepare('INSERT OR REPLACE INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(KEY_NAME, e.ciphertext, e.iv, e.authTag, last4(value), '2026-06-01T00:00:00.000Z');
  invalidateSecrets();
}
function deleteDbKey() {
  getDb().prepare('DELETE FROM app_secrets WHERE name = ?').run(KEY_NAME);
  invalidateSecrets(KEY_NAME);
}

beforeEach(async () => {
  fetch.mockReset();
  secretsFault.fail = false;
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  __resetSecretsForTests();
  resetBackupEnv();
  await resetCloud();
  installCloudAndOllama(fetch);
});
afterAll(async () => {
  secretsFault.fail = false;
  await resetCloud();
  __resetSecretsForTests();
  cleanupBackupEnv();
  if (savedEnv.enc === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEnv.enc;
});

describe('restore keeps the live cloud AI decisions', () => {
  it('precondition: the fully configured fake cloud is on', async () => {
    await configureCloud({ categories: { journal: true } });
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(true);
    expect(client.ai).toEqual({ kind: 'cloud', host: CLOUD_HOST });
  });

  it('(a) consent revoked after the backup stays revoked: cloud off, no consent row', async () => {
    await configureCloud();
    const backup = await backUp();
    expect(stateRow('ai.cloudConsent')).toBeTruthy();

    await clearCloudConsent();
    freshClientState();
    await restore(backup.id);
    freshClientState();

    expect(stateRow('ai.cloudConsent')).toBeUndefined();
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(client.provider).toBe('ollama');
    expect(touchedCloud()).toBe(false);
  });

  it('(b) categories narrowed after the backup stay narrowed (journal on at backup, off now)', async () => {
    await configureCloud({ categories: { journal: true } });
    const backup = await backUp();
    await setState('ai.cloudCategories', { journal: false });
    freshClientState();

    await restore(backup.id);
    freshClientState();

    expect(await getState('ai.cloudCategories', null)).toEqual({ journal: false });
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(true);
    expect(client.policy.allows('journal')).toBe(false);
  });

  it('(c) provider and base URL changed after the backup keep their current values', async () => {
    await configureCloud();
    const backup = await backUp();
    await setState(AI_SETTINGS_KEY, { provider: 'ollama', cloud: { baseUrl: OTHER_BASE_URL, model: 'other-model', tokenParam: null } });
    freshClientState();

    await restore(backup.id);
    freshClientState();

    const settings = await getState(AI_SETTINGS_KEY, null);
    expect(settings.provider).toBe('ollama');
    expect(settings.cloud.baseUrl).toBe(OTHER_BASE_URL);
    expect(settings.cloud.baseUrl).not.toBe(CLOUD_BASE_URL);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(touchedCloud()).toBe(false);
  });

  it('(d) a cloud key deleted after the backup stays deleted and cloud stays off', async () => {
    await configureCloud({ key: null });
    saveDbKey();
    freshClientState();
    expect((await getAiClient({ purpose: 'chat' })).isCloud).toBe(true);

    const backup = await backUp();
    expect(getDb().prepare('SELECT name FROM app_secrets WHERE name = ?').get(KEY_NAME)).toBeTruthy();

    deleteDbKey();
    freshClientState();
    await restore(backup.id);
    freshClientState();

    expect(getDb().prepare('SELECT name FROM app_secrets WHERE name = ?').get(KEY_NAME)).toBeUndefined();
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(client.provider).toBe('ollama');
    expect(touchedCloud()).toBe(false);
  });

  it('(e) a snapshot that holds ai.cloudConsent while live has none restores to no consent', async () => {
    await configureCloud();
    const consentValue = stateRow('ai.cloudConsent').value;
    await clearCloudConsent();
    const backup = await backUp();
    rewriteBackupDb(backup.id, (db) => {
      db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(
        'ai.cloudConsent',
        consentValue,
        '2026-06-01T00:00:00.000Z',
      );
    });
    freshClientState();

    await restore(backup.id);
    freshClientState();

    expect(stateRow('ai.cloudConsent')).toBeUndefined();
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(touchedCloud()).toBe(false);
  });

  it('also keeps live ai.cloudHint, and carries every cloud key through RESTORE_CARRY_KEYS', async () => {
    await configureCloud();
    await setState('ai.cloudHint', { lastShownAt: '2026-06-01T00:00:00.000Z' });
    const backup = await backUp();
    await setState('ai.cloudHint', { dismissedAt: '2026-06-02T00:00:00.000Z' });
    await restore(backup.id);
    expect(await getState('ai.cloudHint', null)).toEqual({ dismissedAt: '2026-06-02T00:00:00.000Z' });
    for (const key of CLOUD_APP_STATE_KEYS) expect(RESTORE_CARRY_KEYS).toContain(key);
  });
});

describe('a broken cloud setup falls back to local', () => {
  it('getAiClient returns a local client, with no request to the cloud host, when reading the cloud key throws', async () => {
    await configureCloud();
    expect((await getAiClient({ purpose: 'chat' })).isCloud).toBe(true);

    secretsFault.fail = true;
    freshClientState();
    fetch.mockClear();
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(client.provider).toBe('ollama');
    expect(touchedCloud()).toBe(false);
  });
});

describe('guard: every cloud app_state key is carried through restore', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const sources = walk(path.join(ROOT, 'server')).map((f) => ({
    file: path.relative(ROOT, f).split(path.sep).join('/'),
    text: fs.readFileSync(f, 'utf8'),
  }));
  const read = (file) => sources.find((s) => s.file === file).text;

  it('every CLOUD_APP_STATE_KEYS entry starts with ai.cloud and is in RESTORE_CARRY_KEYS', () => {
    expect(CLOUD_APP_STATE_KEYS.length).toBeGreaterThan(0);
    for (const key of CLOUD_APP_STATE_KEYS) {
      expect(key.startsWith('ai.cloud')).toBe(true);
      expect(RESTORE_CARRY_KEYS).toContain(key);
    }
  });

  it('no server source names an ai.cloud* app_state key that is not listed', () => {
    const found = new Map();
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/(['"`])(ai\.cloud[A-Za-z0-9_.]+)\1/g)) found.set(m[2], [...(found.get(m[2]) || []), file]);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const [key, files] of found) expect({ key, files, listed: CLOUD_APP_STATE_KEYS.includes(key) }).toMatchObject({ listed: true });
  });

  it('every ai.cloud* constant exported by consent.js is listed', () => {
    const values = Object.values(consentModule).filter((v) => typeof v === 'string' && v.startsWith('ai.cloud'));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(CLOUD_APP_STATE_KEYS).toContain(v);
  });

  it('consent.js and privacy.js only write app_state keys that are listed', () => {
    const consentKeys = Object.fromEntries(Object.entries(consentModule).filter(([, v]) => typeof v === 'string'));
    for (const file of ['server/ai/consent.js', 'server/ai/privacy.js']) {
      const text = read(file);
      const refs = [
        ...[...text.matchAll(/\bsetState\(\s*([A-Za-z_]\w*|'[^']+')/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bkey:\s*([A-Za-z_]\w*|'[^']+')/g)].map((m) => m[1]),
      ];
      for (const ref of refs) {
        const value = ref.startsWith("'") ? ref.slice(1, -1) : consentKeys[ref];
        expect({ file, ref, value, listed: CLOUD_APP_STATE_KEYS.includes(value) }).toMatchObject({ listed: true });
      }
    }
    expect(/\bsetState\(/.test(read('server/ai/consent.js'))).toBe(true);
  });
});
