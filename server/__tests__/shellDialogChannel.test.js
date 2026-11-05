// The server -> shell dialog request line: exact format and key order, refusals, and the availability matrix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { dialogRequestMac, initDesktopAuth, resetDesktopAuth } from '../desktop/auth.js';
import { DIALOG_REQUEST_PREFIX, isShellDialogAvailable, requestShellDialog } from '../desktop/shellChannel.js';

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const ID = '00112233445566778899aabbccddeeff';
const PICK_MAC = 'b2b40e2bcc003dc7f7a1e9f04ded223ce1631109d2b2fcb4e14b6d119e9fcdda';
const SAVE_MAC = '9102e87ea551fe60e7fba7ba87699f8840c6c4f315273ce3b81d966b5fc0e6fe';

const sink = () => {
  const writes = [];
  return { writes, write: (chunk) => writes.push(chunk) };
};
const pick = { kind: 'pick_folder', id: ID, ttl: 900, name: '', ext: '', bytes: 0 };
const save = { kind: 'save_file', id: ID, ttl: 900, name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: 1234 };

beforeEach(() => initDesktopAuth(SECRET));
afterEach(() => resetDesktopAuth());

describe('requestShellDialog', () => {
  it('writes exactly one line, in one call, with the documented key order (pick)', () => {
    const out = sink();
    requestShellDialog(pick, { out, desktop: true });
    expect(out.writes).toEqual([
      `BURROW_DIALOG_REQUEST {"v":1,"kind":"pick_folder","id":"${ID}","ttl":900,"name":"","ext":"","bytes":0,"mac":"${PICK_MAC}"}\n`,
    ]);
    expect(out.writes[0].startsWith(DIALOG_REQUEST_PREFIX)).toBe(true);
    expect(out.writes[0].slice(0, -1)).not.toContain('\n');
  });

  it('writes the save request with the name, extension and byte length', () => {
    const out = sink();
    requestShellDialog(save, { out, desktop: true });
    expect(out.writes).toEqual([
      `BURROW_DIALOG_REQUEST {"v":1,"kind":"save_file","id":"${ID}","ttl":900,"name":"burrow-folder-notes-2026-10-08.md","ext":"md","bytes":1234,"mac":"${SAVE_MAC}"}\n`,
    ]);
    expect(JSON.parse(out.writes[0].slice(DIALOG_REQUEST_PREFIX.length)).mac).toBe(dialogRequestMac(save));
  });

  it.each([
    ['an unknown kind', { kind: 'open_file' }],
    ['an uppercase id', { id: ID.toUpperCase() }],
    ['a short id', { id: ID.slice(2) }],
    ['a ttl under 60', { ttl: 59 }],
    ['a ttl over 3600', { ttl: 3601 }],
    ['a fractional ttl', { ttl: 900.5 }],
    ['a pick with a name', { name: 'x' }],
    ['a pick with an extension', { ext: 'md' }],
    ['a pick with bytes', { bytes: 1 }],
  ])('refuses %s and writes nothing', (_label, change) => {
    const out = sink();
    expect(() => requestShellDialog({ ...pick, ...change }, { out, desktop: true })).toThrow(TypeError);
    expect(out.writes).toEqual([]);
  });

  it.each([
    ['an extension that is not md, json or csv', { ext: 'exe', name: 'a.exe' }],
    ['a name that does not end with the extension', { name: 'notes.json' }],
    ['a name with a path separator', { name: 'a/b.md' }],
    ['a name with a backslash', { name: 'a\\b.md' }],
    ['a name with a control character', { name: 'a\u0007b.md' }],
    ['a name with a colon', { name: 'a:b.md' }],
    ['a name over 200 characters', { name: `${'a'.repeat(198)}.md` }],
    ['zero bytes', { bytes: 0 }],
    ['more than 32 MiB', { bytes: 32 * 1024 * 1024 + 1 }],
    ['a fractional length', { bytes: 1.5 }],
  ])('refuses a save with %s and writes nothing', (_label, change) => {
    const out = sink();
    expect(() => requestShellDialog({ ...save, ...change }, { out, desktop: true })).toThrow(TypeError);
    expect(out.writes).toEqual([]);
  });

  it('accepts exactly 32 MiB and a 200 character name', () => {
    const out = sink();
    requestShellDialog({ ...save, bytes: 32 * 1024 * 1024 }, { out, desktop: true });
    requestShellDialog({ ...save, name: `${'a'.repeat(197)}.md` }, { out, desktop: true });
    expect(out.writes).toHaveLength(2);
  });

  it('refuses outside desktop mode and writes nothing', () => {
    const out = sink();
    expect(() => requestShellDialog(pick, { out, desktop: false })).toThrow('desktop');
    expect(out.writes).toEqual([]);
  });
});

describe('isShellDialogAvailable', () => {
  it.each([
    [{ BURROW_DESKTOP: '1', BURROW_SHELL_DIALOGS: '1' }, true],
    [{ BURROW_DESKTOP: '1' }, false],
    [{ BURROW_DESKTOP: '1', BURROW_SHELL_DIALOGS: '0' }, false],
    [{ BURROW_DESKTOP: '1', BURROW_SHELL_DIALOGS: 'true' }, false],
    [{ BURROW_SHELL_DIALOGS: '1' }, false],
    [{ BURROW_DESKTOP: '0', BURROW_SHELL_DIALOGS: '1' }, false],
    [{}, false],
  ])('%j is %s', (env, expected) => {
    expect(isShellDialogAvailable(env)).toBe(expected);
  });
});
