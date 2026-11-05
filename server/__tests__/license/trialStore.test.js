// The local trial record (docs/LICENSING.md 7.8): MAC'd, two copies, one trial per data directory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { select, upsert } from '../../db/query.js';
import { LEGACY_TRIAL_MS, TRIAL_FILE_NAME, TRIAL_MS, TRIAL_STATE_KEY } from '../../license/constants.js';
import { checkTrialRecord, createTrialStore, deriveTrialKey, makeTrialRecord, trialMac } from '../../license/trialStore.js';
import { closeTestDb, createTestDb } from '../helpers/testDb.js';
import { DAY, T0 } from './helpers.js';

let dir;
let db;
let logs;
let ikm;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-trial-'));
  db = createTestDb();
  logs = [];
  ikm = randomBytes(32);
});
afterEach(() => {
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const START = Math.floor(T0 / 1000) * 1000;
const make = (extra = {}) =>
  createTrialStore({
    dataDir: dir,
    getDb: () => db,
    loadKey: () => ({ ok: true, key: ikm }),
    now: () => T0,
    log: (m) => logs.push(m),
    ...extra,
  });
const filePath = () => path.join(dir, TRIAL_FILE_NAME);
const readFileCopy = () => JSON.parse(fs.readFileSync(filePath(), 'utf8'));
const readDbCopy = () => select('app_state', { where: { key: TRIAL_STATE_KEY }, db })[0]?.value ?? null;
const writeDbCopy = (value) =>
  upsert('app_state', { key: TRIAL_STATE_KEY, value, updated_at: new Date(T0).toISOString() }, { conflict: ['key'], db });
const key = () => deriveTrialKey(ikm);

describe('trial record', () => {
  it('round trips: a made record verifies and carries the 14 day end', () => {
    const rec = makeTrialRecord(key(), START);
    expect(Object.keys(rec)).toEqual(['v', 'startedAt', 'endsAt', 'mac']);
    expect(rec.endsAt).toBe(START + TRIAL_MS);
    expect(rec.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkTrialRecord(rec, key())).toEqual({ startedAt: START, endsAt: START + TRIAL_MS });
  });

  it('uses its own key label: the clock key and the trial key differ', () => {
    expect(deriveTrialKey(ikm).equals(deriveTrialKey(ikm))).toBe(true);
    expect(deriveTrialKey(ikm).equals(deriveTrialKey(randomBytes(32)))).toBe(false);
    expect(trialMac(key(), START, START + TRIAL_MS)).not.toBe(trialMac(key(), START, START + TRIAL_MS + 1));
  });

  it('rejects bad shapes even with a matching MAC', () => {
    const k = key();
    const signed = (startedAt, endsAt, extra = {}) => ({ v: 1, startedAt, endsAt, mac: trialMac(k, startedAt, endsAt), ...extra });
    expect(checkTrialRecord(signed(START, START + TRIAL_MS, { extra: 1 }), k)).toBeNull();
    expect(checkTrialRecord(signed(START, START + TRIAL_MS + 1000), k)).toBeNull();
    expect(checkTrialRecord(signed(START + 500, START + 500 + TRIAL_MS), k)).toBeNull();
    const early = Date.parse('2020-01-01T00:00:00Z');
    expect(checkTrialRecord(signed(early, early + TRIAL_MS), k)).toBeNull();
    const late = Date.parse('3100-01-01T00:00:00Z');
    expect(checkTrialRecord(signed(late, late + TRIAL_MS), k)).toBeNull();
    expect(checkTrialRecord({ ...signed(START, START + TRIAL_MS), v: 2 }, k)).toBeNull();
    expect(checkTrialRecord({ ...signed(START, START + TRIAL_MS), mac: 'x' }, k)).toBeNull();
    for (const days of [1, 6, 8, 10, 13, 15, 30]) {
      expect(checkTrialRecord(signed(START, START + days * DAY), k)).toBeNull();
    }
    expect(checkTrialRecord(null, k)).toBeNull();
    expect(checkTrialRecord([], k)).toBeNull();
    expect(checkTrialRecord(makeTrialRecord(deriveTrialKey(randomBytes(32)), START), k)).toBeNull();
  });
});

describe('legacy 7-day records', () => {
  const legacy = () => ({ v: 1, startedAt: START, endsAt: START + LEGACY_TRIAL_MS, mac: trialMac(key(), START, START + LEGACY_TRIAL_MS) });

  it('a MAC-valid 7-day record verifies and keeps its own 7-day end', () => {
    expect(LEGACY_TRIAL_MS).toBe(7 * DAY);
    expect(TRIAL_MS).toBe(14 * DAY);
    expect(checkTrialRecord(legacy(), key())).toEqual({ startedAt: START, endsAt: START + 7 * DAY });
  });

  it('the legacy end is not accepted with a mismatched MAC (the MAC covers endsAt)', () => {
    expect(checkTrialRecord({ ...legacy(), mac: trialMac(key(), START, START + TRIAL_MS) }, key())).toBeNull();
  });

  it('load returns a legacy record unchanged and does not rewrite it', () => {
    const rec = legacy();
    fs.writeFileSync(filePath(), `${JSON.stringify(rec)}
`);
    writeDbCopy(rec);
    expect(make().load()).toEqual({ kind: 'valid', startedAt: START, endsAt: START + 7 * DAY });
    expect(readFileCopy()).toEqual(rec);
    expect(readDbCopy()).toEqual(rec);
  });
});

describe('legacy 7-day records are never lengthened by a repair', () => {
  const legacyRec = (startedAt = START) => {
    const endsAt = startedAt + LEGACY_TRIAL_MS;
    return { v: 1, startedAt, endsAt, mac: trialMac(key(), startedAt, endsAt) };
  };
  const seed = (rec) => {
    fs.writeFileSync(filePath(), `${JSON.stringify(rec)}
`);
    writeDbCopy(rec);
  };
  const expected = { kind: 'valid', startedAt: START, endsAt: START + 7 * DAY };

  it('a deleted file copy is repaired as the 7-day record, twice', () => {
    const rec = legacyRec();
    seed(rec);
    fs.rmSync(filePath());
    const store = make();
    expect(store.load()).toEqual(expected);
    expect(store.load()).toEqual(expected);
    expect(readFileCopy()).toEqual(rec);
    expect(readDbCopy()).toEqual(rec);
  });

  it('a deleted DB row is repaired as the 7-day record, twice', () => {
    const rec = legacyRec();
    seed(rec);
    db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_STATE_KEY);
    const store = make();
    expect(store.load()).toEqual(expected);
    expect(store.load()).toEqual(expected);
    expect(readFileCopy()).toEqual(rec);
    expect(readDbCopy()).toEqual(rec);
  });

  it('a tampered file copy is repaired back to the 7-day record', () => {
    const rec = legacyRec();
    seed(rec);
    fs.writeFileSync(filePath(), JSON.stringify({ ...rec, startedAt: START + 5 * DAY }));
    expect(make().load()).toEqual(expected);
    expect(readFileCopy()).toEqual(rec);
    expect(readDbCopy()).toEqual(rec);
  });

  it('same startedAt, different lengths: the earlier end wins and both copies are repaired to it', () => {
    const short = legacyRec();
    const long = makeTrialRecord(key(), START);
    fs.writeFileSync(filePath(), `${JSON.stringify(long)}
`);
    writeDbCopy(short);
    expect(make().load()).toEqual(expected);
    expect(readFileCopy()).toEqual(short);
    expect(readDbCopy()).toEqual(short);
    fs.writeFileSync(filePath(), `${JSON.stringify(short)}
`);
    writeDbCopy(long);
    expect(make().load()).toEqual(expected);
    expect(readFileCopy()).toEqual(short);
    expect(readDbCopy()).toEqual(short);
  });
});

describe('createTrialStore', () => {
  it('both copies absent reads as none', () => {
    expect(make().load()).toEqual({ kind: 'none' });
  });

  it('start writes both copies and load reads them back', () => {
    const store = make();
    expect(store.start(START)).toBe(true);
    expect(readFileCopy()).toEqual(readDbCopy());
    expect(store.load()).toEqual({ kind: 'valid', startedAt: START, endsAt: START + TRIAL_MS });
  });

  it('a deleted file is restored from the DB copy and repaired', () => {
    const store = make();
    store.start(START);
    fs.rmSync(filePath());
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
    expect(readFileCopy()).toEqual(readDbCopy());
  });

  it('a deleted DB row is restored from the file and repaired', () => {
    const store = make();
    store.start(START);
    db.prepare('DELETE FROM app_state WHERE key = ?').run(TRIAL_STATE_KEY);
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
    expect(readDbCopy()).toEqual(readFileCopy());
  });

  it('an edited file fails its MAC: the DB copy wins, the file is repaired, the log has no values', () => {
    const store = make();
    store.start(START);
    const forged = { ...readFileCopy(), startedAt: START + 5 * DAY, endsAt: START + 5 * DAY + TRIAL_MS };
    fs.writeFileSync(filePath(), JSON.stringify(forged));
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
    expect(logs).toEqual(['license: trial record ignored (invalid)']);
    expect(logs.join('')).not.toMatch(/\d{6}/);
    expect(readFileCopy().startedAt).toBe(START);
  });

  it('both copies tampered counts as used', () => {
    const store = make();
    store.start(START);
    const forged = { ...readFileCopy(), startedAt: START + 1000, endsAt: START + 1000 + TRIAL_MS };
    fs.writeFileSync(filePath(), JSON.stringify(forged));
    writeDbCopy(forged);
    expect(store.load()).toEqual({ kind: 'used' });
    expect(logs).toEqual(['license: trial record ignored (invalid)']);
  });

  it('an unreadable or oversized file with no DB copy counts as used', () => {
    fs.writeFileSync(filePath(), '{ not json');
    expect(make().load()).toEqual({ kind: 'used' });
    fs.writeFileSync(filePath(), ' '.repeat(2048));
    expect(make().load()).toEqual({ kind: 'used' });
  });

  it('a replaced secrets.key invalidates both copies: used', () => {
    make().start(START);
    const other = make({ loadKey: () => ({ ok: true, key: randomBytes(32) }) });
    expect(other.load()).toEqual({ kind: 'used' });
  });

  it('two valid but different copies: the earliest start wins and both are repaired to it', () => {
    const store = make();
    store.start(START);
    const later = makeTrialRecord(key(), START + 2 * DAY);
    writeDbCopy(later);
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
    expect(readDbCopy().startedAt).toBe(START);
    expect(readFileCopy().startedAt).toBe(START);
  });

  it('with no key, start fails and any present copy is used', () => {
    const noKey = make({ loadKey: () => ({ ok: false }) });
    expect(noKey.start(START)).toBe(false);
    expect(noKey.load()).toEqual({ kind: 'none' });
    make().start(START);
    expect(noKey.load()).toEqual({ kind: 'used' });
  });

  it('start with only the file writable still succeeds', () => {
    const store = make({ getDb: () => null });
    expect(store.start(START)).toBe(true);
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
  });

  it('load never throws, even when the key loader does', () => {
    make().start(START);
    const broken = make({
      loadKey: () => {
        throw new Error('boom');
      },
    });
    expect(broken.load()).toEqual({ kind: 'used' });
    expect(broken.start(START)).toBe(false);
  });

  const brokenDb = () => ({
    prepare() {
      throw new Error('database is locked');
    },
    exec() {
      throw new Error('database is locked');
    },
  });

  it('a DB read error is a present but unreadable copy: used, even with no file', () => {
    expect(make({ getDb: brokenDb }).load()).toEqual({ kind: 'used' });
  });

  it('a DB read error does not hide a valid file copy: the file still wins', () => {
    make().start(START);
    expect(make({ getDb: brokenDb }).load()).toMatchObject({ kind: 'valid', startedAt: START });
  });

  it('start refuses when the DB cannot be read, and writes nothing', () => {
    expect(make({ getDb: brokenDb }).start(START)).toBe(false);
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('start refuses to overwrite an unvalidated file copy', () => {
    fs.writeFileSync(filePath(), '{ not json');
    expect(make().start(START)).toBe(false);
    expect(fs.readFileSync(filePath(), 'utf8')).toBe('{ not json');
    expect(readDbCopy()).toBeNull();
  });

  it('start refuses to overwrite an unvalidated DB row', () => {
    const forged = { v: 1, startedAt: START, endsAt: START + TRIAL_MS, mac: 'A'.repeat(43) };
    writeDbCopy(forged);
    expect(make().start(START + DAY)).toBe(false);
    expect(readDbCopy()).toEqual(forged);
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('start refuses to overwrite a valid existing record too', () => {
    const store = make();
    store.start(START);
    expect(store.start(START + 3 * DAY)).toBe(false);
    expect(store.load()).toMatchObject({ kind: 'valid', startedAt: START });
  });
});
