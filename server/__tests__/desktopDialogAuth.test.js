// The dialog key and its three MACs (request, reply, fetch proof). The pinned vectors are the same literals as in
// src-tauri/src/secret.rs and src-tauri/src/dialogs.rs: change one side and a test fails on the other.
// Vectors come from a scratch script that imports only node:crypto (secret = bytes 0..31).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import {
  dialogFetchProofOk,
  dialogKeyHexForTests,
  dialogReplyMacOk,
  dialogRequestMac,
  initDesktopAuth,
  resetDesktopAuth,
} from '../desktop/auth.js';

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const ID = '00112233445566778899aabbccddeeff';
const UPDATE_KEY = 'd7a04009cce2a159b133fea3d6c6675258b1ad63e514b5dc6a78f8bf47dc681b';

const VECTORS = Object.freeze({
  key: '0a89a8b731cd49c6037f32cd1ea9fdc74fb725f8cb6635954b2c2c0882fcf179',
  reqPick: 'b2b40e2bcc003dc7f7a1e9f04ded223ce1631109d2b2fcb4e14b6d119e9fcdda',
  reqSave: '9102e87ea551fe60e7fba7ba87699f8840c6c4f315273ce3b81d966b5fc0e6fe',
  repPicked: '0914461379dc7f21902dc2ed0932179b6f7336892c206cb40638c2a13db2e84d',
  repPickedUtf8: '3565fc97e76d00cf15b330d8fad46a553e3c549a2ae4cdbd67395577e2c6135b',
  repCancelled: 'a766a70a194f0526f7dcb2b38eb9c68d0fa9dbfaafc9befe37ef6b8ea817d854',
  fetch: '6f7ae1594d6797f221d09f7b162cd2757c3df427eb6e51b6556fd9737d297890',
});

const PATH_ASCII = 'C:\\Users\\Example\\Documents\\Notes';
const PATH_UTF8 = 'C:\\Users\\Exämple\\Notes ✓';
const flip = (hex) => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;

beforeEach(() => initDesktopAuth(SECRET));
afterEach(() => resetDesktopAuth());

describe('dialog key', () => {
  it('matches the pinned vector and differs from the update key', () => {
    expect(dialogKeyHexForTests()).toBe(VECTORS.key);
    expect(VECTORS.key).not.toBe(UPDATE_KEY);
  });

  it('changes with the launch secret', () => {
    initDesktopAuth(Buffer.alloc(32, 7));
    expect(dialogKeyHexForTests()).not.toBe(VECTORS.key);
    expect(dialogRequestMac({ kind: 'pick_folder', id: ID, ttl: 900, name: '', ext: '', bytes: 0 })).not.toBe(VECTORS.reqPick);
  });
});

describe('request MAC', () => {
  const pick = { kind: 'pick_folder', id: ID, ttl: 900, name: '', ext: '', bytes: 0 };
  const save = { kind: 'save_file', id: ID, ttl: 900, name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: 1234 };

  it('matches the pinned vectors', () => {
    expect(dialogRequestMac(pick)).toBe(VECTORS.reqPick);
    expect(dialogRequestMac(save)).toBe(VECTORS.reqSave);
  });

  it.each([
    ['kind', { kind: 'save_file' }],
    ['id', { id: 'ff'.repeat(16) }],
    ['ttl', { ttl: 901 }],
    ['name', { name: 'x' }],
    ['ext', { ext: 'md' }],
    ['bytes', { bytes: 1 }],
  ])('changes with the %s field', (_field, change) => {
    expect(dialogRequestMac({ ...pick, ...change })).not.toBe(VECTORS.reqPick);
  });

  it('fails closed without a secret', () => {
    resetDesktopAuth();
    expect(() => dialogRequestMac(pick)).toThrow('not initialised');
  });
});

describe('reply MAC', () => {
  it('accepts the pinned vectors, including a non-ASCII path', () => {
    expect(dialogReplyMacOk({ id: ID, status: 'picked', path: PATH_ASCII, mac: VECTORS.repPicked })).toBe(true);
    expect(dialogReplyMacOk({ id: ID, status: 'picked', path: PATH_UTF8, mac: VECTORS.repPickedUtf8 })).toBe(true);
    expect(dialogReplyMacOk({ id: ID, status: 'cancelled', path: '', mac: VECTORS.repCancelled })).toBe(true);
  });

  it('rejects a flipped bit, a changed field, uppercase hex and a wrong or missing key', () => {
    const ok = { id: ID, status: 'picked', path: PATH_ASCII, mac: VECTORS.repPicked };
    expect(dialogReplyMacOk({ ...ok, mac: flip(ok.mac) })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, path: `${PATH_ASCII}2` })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, status: 'cancelled' })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, id: 'ff'.repeat(16) })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, mac: ok.mac.toUpperCase() })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, mac: ok.mac.slice(2) })).toBe(false);
    expect(dialogReplyMacOk({ ...ok, mac: undefined })).toBe(false);
    initDesktopAuth(Buffer.alloc(32, 9));
    expect(dialogReplyMacOk(ok)).toBe(false);
    resetDesktopAuth();
    expect(dialogReplyMacOk(ok)).toBe(false);
  });
});

describe('fetch proof', () => {
  it('accepts the pinned vector', () => {
    expect(dialogFetchProofOk(ID, VECTORS.fetch)).toBe(true);
  });

  it('rejects a flipped bit, another id, a non-string and a wrong key', () => {
    expect(dialogFetchProofOk(ID, flip(VECTORS.fetch))).toBe(false);
    expect(dialogFetchProofOk('ff'.repeat(16), VECTORS.fetch)).toBe(false);
    expect(dialogFetchProofOk(ID, undefined)).toBe(false);
    expect(dialogFetchProofOk(ID, ['x'])).toBe(false);
    expect(dialogFetchProofOk(ID, '')).toBe(false);
    initDesktopAuth(Buffer.alloc(32, 9));
    expect(dialogFetchProofOk(ID, VECTORS.fetch)).toBe(false);
  });
});
