// The AI eval prepares a local trial in its own temp data dir (scripts/lib/evalTrial.js) so Javi
// tools work there. Tested against a temp dir with an in-memory DB and an injected key: no Ollama,
// no store, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

vi.mock('node-fetch', () => ({ default: vi.fn(async () => { throw new Error('real fetch must not be used'); }) }));

import { TRIAL_FILE_NAME } from '../license/constants.js';
import { getEntitlements, resetLicenseForTests } from '../license/index.js';
import { hasProRequiredRow, startEvalTrial } from '../../scripts/lib/evalTrial.js';
import { closeTestDb, createTestDb } from './helpers/testDb.js';

const ikm = randomBytes(32);
let dir;
let db;
const opts = () => ({
  env: {},
  getDb: () => db,
  loadKey: () => ({ ok: true, key: ikm }),
  gatherEvidence: () => null,
  allowTest: false,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-evaltrial-'));
  db = createTestDb();
  resetLicenseForTests();
});
afterEach(() => {
  resetLicenseForTests();
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startEvalTrial', () => {
  it('refuses to report Pro when the trial did not start', () => {
    expect(() => startEvalTrial(dir, { ...opts(), autoStartTrial: false })).toThrow('eval_trial_not_pro');
  });

  it('is Pro (local trial) after, with the trial written only to the given dir', () => {
    const out = startEvalTrial(dir, opts());
    expect(out.pro).toBe(true);
    expect(getEntitlements()).toMatchObject({ pro: true, reasons: expect.arrayContaining(['local_trial']) });
    expect(fs.existsSync(path.join(dir, TRIAL_FILE_NAME))).toBe(true);
  });
});

describe('hasProRequiredRow', () => {
  it('detects a pro_required row in any model and ignores other errors', () => {
    expect(hasProRequiredRow({ a: { rows: [{ error: null }, { error: 'pro_required' }] } })).toBe(true);
    expect(hasProRequiredRow({ a: { rows: [{ error: 'ai_busy' }] }, b: { rows: [{}] } })).toBe(false);
  });
});
