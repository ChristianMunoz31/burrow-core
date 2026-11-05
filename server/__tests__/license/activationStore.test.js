// The stored activation (docs/LICENSING.md 5.1 to 5.3): MAC'd, two copies, repaired from each other,
// tombstones, key binding. Same shape as trialStore.test.js.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { select, upsert } from '../../db/query.js';
import {
  checkActivationRecord,
  createActivationStore,
  deriveActivationKey,
  deriveKeyHashKey,
  keyHashOf,
} from '../../license/activationStore.js';
import { ACTIVATION_FILE_NAME, ACTIVATION_STATE_KEY, MAX_ACTIVATION_FILE_BYTES } from '../../license/constants.js';
import { closeTestDb, createTestDb } from '../helpers/testDb.js';
import { DAY, T0, iso } from './helpers.js';

let dir;
let db;
let logs;
let ikm;
let hasKey;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-act-'));
  db = createTestDb();
  logs = [];
  ikm = randomBytes(32);
  hasKey = true;
});
afterEach(() => {
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (extra = {}) =>
  createActivationStore({
    dataDir: dir,
    getDb: () => db,
    loadKey: () => (hasKey ? { ok: true, key: ikm } : { ok: false }),
    now: () => T0,
    log: (m) => logs.push(m),
    ...extra,
  });
const filePath = () => path.join(dir, ACTIVATION_FILE_NAME);
const readFileCopy = () => JSON.parse(fs.readFileSync(filePath(), 'utf8'));
const readDbCopy = () => select('app_state', { where: { key: ACTIVATION_STATE_KEY }, db })[0]?.value ?? null;
const writeDbCopy = (value) =>
  upsert('app_state', { key: ACTIVATION_STATE_KEY, value, updated_at: iso(T0) }, { conflict: ['key'], db });
const writeFileCopy = (value) => fs.writeFileSync(filePath(), `${JSON.stringify(value)}\n`);
const deleteDbCopy = () => db.prepare('DELETE FROM app_state WHERE key = ?').run(ACTIVATION_STATE_KEY);
const macKey = () => deriveActivationKey(ikm);

const fields = (store, over = {}) => ({
  store: 'gumroad',
  productId: 'prod_test_123',
  variantId: null,
  edition: 'standard',
  purchaseDate: '2026-09-30T14:02:11Z',
  updatesUntil: '2027-09-30T14:02:11Z',
  expiresAt: null,
  activatedAt: iso(T0),
  keyHash: store.keyHash('gumroad', '00000000-11111111-22222222-33333333'),
  keyLast4: '3333',
  email: 'buyer@example.com',
  instanceId: null,
  test: false,
  ...over,
});

describe('record shape and MAC', () => {
  it('round trips: a saved record carries the documented keys in order and verifies', () => {
    const store = make();
    const record = store.save(fields(store));
    expect(Object.keys(record)).toEqual([
      'v', 'state', 'store', 'productId', 'variantId', 'edition', 'purchaseDate', 'updatesUntil', 'expiresAt',
      'activatedAt', 'keyHash', 'keyLast4', 'email', 'instanceId', 'test', 'mac',
    ]);
    expect(record.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkActivationRecord(record, macKey())).toMatchObject({ cleared: false, ts: T0 });
    expect(store.load()).toEqual({ kind: 'active', record });
    expect(readFileCopy()).toEqual(record);
    expect(readDbCopy()).toEqual(record);
  });

  it('writes the file with mode 0600 data dir semantics and no temp files left behind', () => {
    const store = make();
    store.save(fields(store));
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['v', 2],
    ['state', 'cleared'],
    ['store', 'lemonsqueezy'],
    ['productId', 'other'],
    ['variantId', '1001'],
    ['edition', 'founding'],
    ['purchaseDate', '2026-09-29T14:02:11Z'],
    ['updatesUntil', '2030-09-30T14:02:11Z'],
    ['expiresAt', '2027-09-30T14:02:11Z'],
    ['activatedAt', '2026-10-06T12:00:00Z'],
    ['keyHash', 'x'.repeat(43)],
    ['keyLast4', 'ABCD'],
    ['email', 'other@example.com'],
    ['instanceId', 'abc'],
    ['test', true],
    ['mac', 'y'.repeat(43)],
  ])('an edit to %s makes the record invalid', (field, value) => {
    const store = make();
    const record = store.save(fields(store));
    expect(checkActivationRecord({ ...record, [field]: value }, macKey())).toBeNull();
  });

  it('extra, missing and mistyped fields are invalid even with a matching shape', () => {
    const store = make();
    const record = store.save(fields(store));
    expect(checkActivationRecord({ ...record, extra: 1 }, macKey())).toBeNull();
    const missing = { ...record };
    delete missing.email;
    expect(checkActivationRecord(missing, macKey())).toBeNull();
    expect(checkActivationRecord({ ...record, test: 'false' }, macKey())).toBeNull();
    expect(checkActivationRecord({ ...record, v: '1' }, macKey())).toBeNull();
    for (const bad of [null, [], 'x', 5, undefined]) expect(checkActivationRecord(bad, macKey())).toBeNull();
    // an inherited key never counts as present
    const proto = Object.create({ ...record });
    expect(checkActivationRecord(proto, macKey())).toBeNull();
  });

  it('enforces field rules even when the MAC would be right', () => {
    const store = make();
    const resign = (over) => {
      const record = { v: 1, state: 'active', ...fields(store), ...over };
      return store.save(record) && readFileCopy();
    };
    const ok = (over) => checkActivationRecord(resign(over), macKey()) !== null;
    expect(ok({})).toBe(true);
    expect(ok({ email: null })).toBe(true);
    expect(ok({ store: 'lemonsqueezy', variantId: '1001', instanceId: 'a1b2-c3' })).toBe(true);
    expect(ok({ edition: 'student', expiresAt: '2027-09-30T14:02:11Z' })).toBe(true);
    expect(ok({ edition: 'student', expiresAt: null })).toBe(false);
    expect(ok({ edition: 'student', expiresAt: '2026-09-30T14:02:11Z' })).toBe(false);
    expect(ok({ expiresAt: '2027-09-30T14:02:11Z' })).toBe(false);
    expect(ok({ updatesUntil: '2026-09-29T14:02:11Z' })).toBe(false);
    expect(ok({ edition: 'trial' })).toBe(false);
    expect(ok({ store: 'paypal' })).toBe(false);
    expect(ok({ productId: '' })).toBe(false);
    expect(ok({ productId: 'p'.repeat(65) })).toBe(false);
    expect(ok({ keyLast4: 'abc' })).toBe(false);
    expect(ok({ email: 'ab' })).toBe(false);
    expect(ok({ email: `${'a'.repeat(250)}@example.com` })).toBe(false);
    expect(ok({ email: 'a\nb@example.com' })).toBe(false);
    expect(ok({ instanceId: 'has space' })).toBe(false);
    expect(ok({ activatedAt: '2026-10-05' })).toBe(false);
    expect(ok({ purchaseDate: '2026-10-05T12:00:00.000Z' })).toBe(false);
  });

  it('the tombstone has exactly v, state, clearedAt and mac', () => {
    const store = make();
    const tomb = store.clear(T0 + 789);
    expect(tomb).toEqual({ v: 1, state: 'cleared', clearedAt: '2026-10-05T12:00:00Z', mac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(Object.keys(tomb)).toEqual(['v', 'state', 'clearedAt', 'mac']);
    expect(checkActivationRecord(tomb, macKey())).toMatchObject({ cleared: true, ts: T0 });
    expect(checkActivationRecord({ ...tomb, clearedAt: '2026-10-06T12:00:00Z' }, macKey())).toBeNull();
    expect(checkActivationRecord({ ...tomb, extra: 1 }, macKey())).toBeNull();
    expect(store.load()).toEqual({ kind: 'none' });
    expect(readFileCopy()).toEqual(tomb);
    expect(readDbCopy()).toEqual(tomb);
  });
});

describe('keys', () => {
  it('uses its own labels: activation key and key-hash key differ from each other and per secrets.key', () => {
    expect(deriveActivationKey(ikm).equals(deriveActivationKey(ikm))).toBe(true);
    expect(deriveActivationKey(ikm).equals(deriveKeyHashKey(ikm))).toBe(false);
    expect(deriveActivationKey(ikm).equals(deriveActivationKey(randomBytes(32)))).toBe(false);
  });

  it('keyHash is a keyed hash bound to the store, the key and secrets.key', () => {
    const store = make();
    const hash = store.keyHash('gumroad', 'KEY-A');
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(keyHashOf(deriveKeyHashKey(ikm), 'gumroad', 'KEY-A'));
    expect(store.keyHash('lemonsqueezy', 'KEY-A')).not.toBe(hash);
    expect(store.keyHash('gumroad', 'KEY-B')).not.toBe(hash);
    expect(keyHashOf(deriveKeyHashKey(randomBytes(32)), 'gumroad', 'KEY-A')).not.toBe(hash);
  });

  it('hasKey and keyHash follow the key loader', () => {
    const store = make();
    expect(store.hasKey()).toBe(true);
    hasKey = false;
    expect(store.hasKey()).toBe(false);
    expect(store.keyHash('gumroad', 'x')).toBeNull();
    expect(store.save(fields(make({ loadKey: () => ({ ok: true, key: ikm }) })))).toBeNull();
    expect(store.clear(T0)).toBeNull();
  });

  it('a loader that throws means no key', () => {
    const store = make({
      loadKey: () => {
        throw new Error('boom');
      },
    });
    expect(store.hasKey()).toBe(false);
    expect(store.load()).toEqual({ kind: 'none' });
  });
});

describe('load', () => {
  it('none when both copies are absent', () => {
    expect(make().load()).toEqual({ kind: 'none' });
  });

  it('a deleted file copy is restored from the DB copy and repaired', () => {
    const store = make();
    const record = store.save(fields(store));
    fs.rmSync(filePath());
    expect(store.load()).toEqual({ kind: 'active', record });
    expect(readFileCopy()).toEqual(record);
    expect(logs).toEqual([]);
  });

  it('a deleted DB copy is restored from the file and repaired', () => {
    const store = make();
    const record = store.save(fields(store));
    deleteDbCopy();
    expect(store.load()).toEqual({ kind: 'active', record });
    expect(readDbCopy()).toEqual(record);
  });

  it('a tampered file copy is ignored, logged without values, and repaired from the DB copy', () => {
    const store = make();
    const record = store.save(fields(store));
    writeFileCopy({ ...record, edition: 'founding' });
    expect(store.load()).toEqual({ kind: 'active', record });
    expect(readFileCopy()).toEqual(record);
    expect(logs).toEqual(['license: activation record ignored (invalid)']);
    expect(JSON.stringify(logs)).not.toContain('founding');
  });

  it('a tampered DB copy is ignored and repaired from the file', () => {
    const store = make();
    const record = store.save(fields(store));
    writeDbCopy({ ...record, updatesUntil: '2099-01-01T00:00:00Z' });
    expect(store.load()).toEqual({ kind: 'active', record });
    expect(readDbCopy()).toEqual(record);
    expect(logs).toEqual(['license: activation record ignored (invalid)']);
  });

  it('both copies tampered is invalid / tampered', () => {
    const store = make();
    const record = store.save(fields(store));
    writeFileCopy({ ...record, test: true });
    writeDbCopy({ ...record, edition: 'family' });
    expect(store.load()).toEqual({ kind: 'invalid', reason: 'tampered' });
    expect(logs).toEqual(['license: activation record ignored (invalid)']);
  });

  it('a tampered copy with the other missing is invalid / tampered', () => {
    const store = make();
    const record = store.save(fields(store));
    deleteDbCopy();
    writeFileCopy({ ...record, edition: 'family' });
    expect(store.load()).toEqual({ kind: 'invalid', reason: 'tampered' });
  });

  it('garbage in the file (not JSON) is a tampered copy', () => {
    const store = make();
    store.save(fields(store));
    fs.writeFileSync(filePath(), '{not json');
    expect(store.load().kind).toBe('active');
    deleteDbCopy();
    fs.writeFileSync(filePath(), '{not json');
    expect(store.load()).toEqual({ kind: 'invalid', reason: 'tampered' });
  });

  it('no MAC key with any copy present is invalid / no_key, and activate-side checks see no key', () => {
    const store = make();
    store.save(fields(store));
    hasKey = false;
    expect(store.load()).toEqual({ kind: 'invalid', reason: 'no_key' });
    expect(store.hasKey()).toBe(false);
  });

  it('a record from another secrets.key is invalid', () => {
    const store = make();
    store.save(fields(store));
    ikm = randomBytes(32);
    expect(make().load()).toEqual({ kind: 'invalid', reason: 'tampered' });
  });

  it('a file copy over 2 KiB is invalid', () => {
    const store = make();
    const record = store.save(fields(store));
    deleteDbCopy();
    fs.writeFileSync(filePath(), `${JSON.stringify(record)}${' '.repeat(MAX_ACTIVATION_FILE_BYTES)}`);
    expect(fs.statSync(filePath()).size).toBeGreaterThan(MAX_ACTIVATION_FILE_BYTES);
    expect(store.load()).toEqual({ kind: 'invalid', reason: 'tampered' });
  });

  it('two valid but different copies: the later timestamp wins and both are repaired to it', () => {
    const store = make();
    const older = store.save(fields(store, { activatedAt: iso(T0) }));
    const newer = store.save(fields(store, { activatedAt: iso(T0 + DAY), edition: 'family', updatesUntil: '2027-09-30T14:02:11Z' }));
    writeFileCopy(older);
    expect(readDbCopy()).toEqual(newer);
    expect(store.load()).toEqual({ kind: 'active', record: newer });
    expect(readFileCopy()).toEqual(newer);
    // and the other way round
    writeDbCopy(older);
    writeFileCopy(newer);
    expect(store.load()).toEqual({ kind: 'active', record: newer });
    expect(readDbCopy()).toEqual(newer);
  });

  it('on a timestamp tie the DB copy wins', () => {
    const store = make();
    const a = store.save(fields(store, { edition: 'standard' }));
    const b = store.save(fields(store, { edition: 'family' }));
    writeFileCopy(a);
    writeDbCopy(b);
    expect(store.load()).toEqual({ kind: 'active', record: b });
    expect(readFileCopy()).toEqual(b);
  });

  it('a newer tombstone beats an older restored file copy (seat recycler)', () => {
    const store = make();
    const active = store.save(fields(store, { activatedAt: iso(T0) }));
    const tomb = store.clear(T0 + DAY);
    writeFileCopy(active);
    expect(store.load()).toEqual({ kind: 'none' });
    expect(readFileCopy()).toEqual(tomb);
    expect(readDbCopy()).toEqual(tomb);
  });

  it('an activation newer than a tombstone beats it', () => {
    const store = make();
    const tomb = store.clear(T0);
    const active = store.save(fields(store, { activatedAt: iso(T0 + DAY) }));
    writeFileCopy(tomb);
    expect(store.load()).toEqual({ kind: 'active', record: active });
  });

  it('deleting both copies reads none (accepted: deterrence, not DRM)', () => {
    const store = make();
    store.save(fields(store));
    fs.rmSync(filePath());
    deleteDbCopy();
    expect(store.load()).toEqual({ kind: 'none' });
  });

  it('never throws, whatever the DB does', () => {
    const store = make({
      getDb: () => {
        throw new Error('db gone');
      },
    });
    expect(store.load()).toEqual({ kind: 'none' });
    expect(() => store.save(fields(make()))).not.toThrow();
  });
});

describe('save and clear', () => {
  it('succeed when only the DB copy can be written', () => {
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'x');
    const store = make({ dataDir: blocker });
    const record = store.save(fields(store));
    expect(record).not.toBeNull();
    expect(readDbCopy()).toEqual(record);
    expect(store.clear(T0)).not.toBeNull();
  });

  it('succeed when only the file copy can be written', () => {
    const store = make({
      getDb: () => {
        throw new Error('db gone');
      },
    });
    const record = store.save(fields(store));
    expect(record).not.toBeNull();
    expect(readFileCopy()).toEqual(record);
  });

  it('return null when neither copy can be written', () => {
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'x');
    const store = make({
      dataDir: blocker,
      getDb: () => {
        throw new Error('db gone');
      },
    });
    expect(store.save(fields(store))).toBeNull();
    expect(store.clear(T0)).toBeNull();
  });
});
