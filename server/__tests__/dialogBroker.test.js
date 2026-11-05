// The dialog broker: one request at a time, strict reply parsing, the MAC check, expiry on an injected clock,
// cancel, reset, the single-use file fetch and the once-only result callback. No shell, no stdout: requests are captured.
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { __resetDataGenerationForTests, bumpDataGeneration } from '../dataGeneration.js';
import { dialogKeyHexForTests, initDesktopAuth, resetDesktopAuth } from '../desktop/auth.js';
import {
  DIALOG_TTL_SECONDS,
  DialogError,
  KEEP_FINISHED_MS,
  MAX_SAVE_BYTES,
  REPLY_GRACE_MS,
  __clearDialogsForTests,
  __setDialogClockForTests,
  __setDialogWriterForTests,
  cancelDialog,
  createPickRequest,
  createSaveRequest,
  getDialog,
  handleDialogReplyPayload,
  resetDialogs,
  serveDialogFile,
} from '../desktop/dialogBroker.js';
import { FOLDER_MESSAGES, FolderError } from '../folders/constants.js';

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

let now;
let sent;
const hmac = (message) => crypto.createHmac('sha256', Buffer.from(dialogKeyHexForTests(), 'hex')).update(message, 'utf8').digest('hex');
const replyMac = (id, status, path) => hmac(`burrow-dialog-reply-v1\n${id}\n${status}\n${path}`);
const proofFor = (id) => hmac(`burrow-dialog-fetch-v1\n${id}`);
const reply = (id, status, path = '', over = {}) => JSON.stringify({ v: 1, id, status, path, mac: replyMac(id, status, path), ...over });

const fakeRes = () => {
  const r = {
    headers: {},
    statusCode: null,
    body: undefined,
    set(k, v) {
      r.headers[k.toLowerCase()] = v;
      return r;
    },
    status(c) {
      r.statusCode = c;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
    send(b) {
      r.body = b;
      return r;
    },
  };
  return r;
};
const fetchFile = (id, proof = proofFor(id)) => {
  const res = fakeRes();
  serveDialogFile({ path: `/desktop/dialog-file/${id}`, get: (h) => (h.toLowerCase() === 'x-burrow-dialog-proof' ? proof : undefined) }, res);
  return res;
};

const startPick = (onPicked = async () => ({ folderId: 'folder-1', job: null })) => createPickRequest({ onPicked });
const startSave = (over = {}) => createSaveRequest({ name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: Buffer.from('hello'), onResult: vi.fn(), ...over });
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  initDesktopAuth(SECRET);
  __resetDataGenerationForTests();
  __clearDialogsForTests();
  now = 1_000;
  sent = [];
  __setDialogClockForTests(() => now);
  __setDialogWriterForTests((request) => sent.push(request));
});
afterEach(() => {
  __clearDialogsForTests();
  __setDialogClockForTests(null);
  __setDialogWriterForTests(null);
  resetDesktopAuth();
});

describe('creating requests', () => {
  it('writes a pick request with the documented fields and returns a waiting view', () => {
    const view = startPick();
    expect(view).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), kind: 'pick_folder', status: 'waiting', folderId: null, error: null });
    expect(sent).toEqual([{ kind: 'pick_folder', id: view.id, ttl: DIALOG_TTL_SECONDS, name: '', ext: '', bytes: 0 }]);
    expect(getDialog(view.id)).toEqual(view);
  });

  it('writes a save request with the name, extension and exact byte length', () => {
    const view = startSave({ bytes: Buffer.from('h\u00e9llo') });
    expect(sent).toEqual([{ kind: 'save_file', id: view.id, ttl: 900, name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: 6 }]);
  });

  it('answers dialog_busy while another request is waiting, for either kind', () => {
    startPick();
    expect(() => startPick()).toThrow(expect.objectContaining({ name: 'DialogError', code: 'dialog_busy' }));
    expect(() => startSave()).toThrow(expect.objectContaining({ code: 'dialog_busy' }));
    expect(sent).toHaveLength(1);
  });

  it('frees the slot when the request line cannot be written', () => {
    __setDialogWriterForTests(() => {
      throw new Error('stdout closed');
    });
    expect(() => startPick()).toThrow(expect.objectContaining({ code: 'dialog_failed' }));
    __setDialogWriterForTests((request) => sent.push(request));
    expect(() => startPick()).not.toThrow();
  });

  it('refuses empty and oversized exports without opening anything', () => {
    expect(() => startSave({ bytes: Buffer.alloc(0) })).toThrow(expect.objectContaining({ code: 'dialog_failed' }));
    expect(() => startSave({ bytes: Buffer.alloc(MAX_SAVE_BYTES + 1) })).toThrow(expect.objectContaining({ code: 'save_too_large' }));
    expect(sent).toEqual([]);
    expect(() => startSave()).not.toThrow();
  });

  it('carries fixed copy on the error', () => {
    startPick();
    try {
      startPick();
    } catch (err) {
      expect(err).toBeInstanceOf(DialogError);
      expect(err.message).toBe(FOLDER_MESSAGES.dialog_busy);
    }
  });
});

describe('replies that must be ignored', () => {
  it.each([
    ['a bad MAC', (id) => reply(id, 'cancelled', '', { mac: 'a'.repeat(64) })],
    ['an uppercase MAC', (id) => reply(id, 'cancelled', '', { mac: replyMac(id, 'cancelled', '').toUpperCase() })],
    ['an unknown id', () => reply('f'.repeat(32), 'cancelled')],
    ['an uppercase id', (id) => reply(id.toUpperCase(), 'cancelled')],
    ['a save status for a pick', (id) => reply(id, 'saved')],
    ['a path on a status that is not picked', (id) => reply(id, 'cancelled', 'C:\\x')],
    ['picked with no path', (id) => reply(id, 'picked', '')],
    ['an extra key', (id) => reply(id, 'cancelled', '', { extra: 1 })],
    ['a missing key', (id) => JSON.stringify({ v: 1, id, status: 'cancelled', mac: replyMac(id, 'cancelled', '') })],
    ['v 2', (id) => reply(id, 'cancelled', '', { v: 2 })],
    ['a path over 1024 units', (id) => reply(id, 'picked', `C:\\${'a'.repeat(1030)}`)],
    ['a path with a lone surrogate', (id) => reply(id, 'picked', 'C:\\\ud800')],
    ['not JSON', () => 'nope'],
    ['an array', () => '[]'],
    ['a string status number', (id) => reply(id, 7)],
  ])('%s', (_label, make) => {
    const view = startPick();
    handleDialogReplyPayload(make(view.id));
    expect(getDialog(view.id)).toMatchObject({ status: 'waiting', error: null });
  });

  it('a pick status for a save', () => {
    const view = startSave();
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    handleDialogReplyPayload(reply(view.id, 'unusable'));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it('a reply after the request settled', async () => {
    const onPicked = vi.fn(async () => ({ folderId: 'f1' }));
    const view = startPick(onPicked);
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\Users\\Example\\Notes'));
    await flush();
    expect(getDialog(view.id).status).toBe('added');
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\Users\\Other'));
    handleDialogReplyPayload(reply(view.id, 'cancelled'));
    await flush();
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(getDialog(view.id).status).toBe('added');
  });
});

describe('settling a pick', () => {
  it('runs onPicked with the path, shows checking, then added with the folder id', async () => {
    let release;
    const onPicked = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const view = startPick(onPicked);
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\Users\\Exämple\\Notes ✓'));
    expect(onPicked).toHaveBeenCalledWith(
      'C:\\Users\\Exämple\\Notes ✓',
      expect.objectContaining({ stillChecking: expect.any(Function) }),
    );
    expect(getDialog(view.id).status).toBe('checking');
    expect(() => startPick()).toThrow(expect.objectContaining({ code: 'dialog_busy' }));
    release({ folderId: 'folder-9', job: { id: 'j' } });
    await flush();
    expect(getDialog(view.id)).toEqual({ id: view.id, kind: 'pick_folder', status: 'added', folderId: 'folder-9', error: null });
    expect(() => startPick()).not.toThrow();
  });

  it('a FolderError becomes refused with its code and fixed copy', async () => {
    const view = startPick(async () => {
      throw new FolderError('folder_is_link');
    });
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    await flush();
    expect(getDialog(view.id)).toMatchObject({
      status: 'refused',
      folderId: null,
      error: { code: 'folder_is_link', message: FOLDER_MESSAGES.folder_is_link },
    });
  });

  it('any other error becomes failed with folder_failed and shows no detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = startPick(async () => {
      throw new Error('C:\\secret\\place is broken');
    });
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    await flush();
    const dialog = getDialog(view.id);
    expect(dialog).toMatchObject({ status: 'failed', error: { code: 'folder_failed', message: FOLDER_MESSAGES.folder_failed } });
    expect(JSON.stringify(dialog)).not.toContain('secret');
    expect(console.error).toHaveBeenCalledWith('Folder dialog failed:', 'Error');
    vi.restoreAllMocks();
  });

  it.each([
    ['unusable', 'refused', 'folder_path_invalid'],
    ['cancelled', 'cancelled', null],
    ['busy', 'busy', 'dialog_busy'],
    ['expired', 'expired', 'dialog_expired'],
    ['failed', 'failed', 'pick_failed'],
  ])('the reply %s ends as %s', (status, expected, code) => {
    const view = startPick();
    handleDialogReplyPayload(reply(view.id, status));
    expect(getDialog(view.id)).toMatchObject({ status: expected, error: code ? { code, message: FOLDER_MESSAGES[code] } : null });
    expect(() => startPick()).not.toThrow();
  });

  it('drops a pick when the data was erased before the reply, without calling onPicked', async () => {
    const onPicked = vi.fn();
    const view = startPick(onPicked);
    bumpDataGeneration();
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    await flush();
    expect(onPicked).not.toHaveBeenCalled();
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code: 'data_reset' } });
  });

  it('drops the result when the data was erased while the path was being checked', async () => {
    let release;
    const view = startPick(() => new Promise((resolve) => (release = resolve)));
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    bumpDataGeneration();
    release({ folderId: 'gone' });
    await flush();
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', folderId: null, error: { code: 'data_reset' } });
  });
});

describe('settling a save', () => {
  it.each([
    ['saved', 'saved', null],
    ['cancelled', 'cancelled', null],
    ['exists', 'failed', 'save_exists'],
    ['too_large', 'failed', 'save_too_large'],
    ['fetch_failed', 'failed', 'save_failed'],
    ['write_failed', 'failed', 'save_failed'],
    ['busy', 'busy', 'dialog_busy'],
    ['expired', 'expired', 'dialog_expired'],
  ])('the reply %s ends as %s and reports once', (status, expected, code) => {
    const onResult = vi.fn();
    const view = startSave({ onResult });
    handleDialogReplyPayload(reply(view.id, status));
    handleDialogReplyPayload(reply(view.id, 'saved'));
    expect(getDialog(view.id)).toMatchObject({ status: expected, folderId: null, error: code ? { code, message: FOLDER_MESSAGES[code] } : null });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expected, code);
  });

  it('a failing result callback never breaks the request', async () => {
    const view = startSave({ onResult: async () => Promise.reject(new Error('audit down')) });
    handleDialogReplyPayload(reply(view.id, 'saved'));
    await flush();
    expect(getDialog(view.id).status).toBe('saved');
  });
});

describe('expiry', () => {
  it('stays waiting until ttl plus the grace period, then expires and frees the slot', () => {
    const onResult = vi.fn();
    const view = startSave({ onResult });
    const limit = DIALOG_TTL_SECONDS * 1000 + REPLY_GRACE_MS;
    now += limit - 1;
    expect(getDialog(view.id).status).toBe('waiting');
    now += 1;
    expect(getDialog(view.id)).toMatchObject({ status: 'expired', error: { code: 'dialog_expired' } });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('expired', 'dialog_expired');
    expect(() => startPick()).not.toThrow();
  });

  it('ignores a reply that arrives after the deadline', () => {
    const view = startPick();
    now += DIALOG_TTL_SECONDS * 1000 + REPLY_GRACE_MS;
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    expect(getDialog(view.id).status).toBe('expired');
  });

  it('forgets a finished request after the keep time', () => {
    const view = startPick();
    handleDialogReplyPayload(reply(view.id, 'cancelled'));
    now += KEEP_FINISHED_MS - 1;
    expect(getDialog(view.id)).not.toBeNull();
    now += 1;
    expect(getDialog(view.id)).toBeNull();
  });

  it('knows nothing about an id it never issued', () => {
    expect(getDialog('0'.repeat(32))).toBeNull();
    expect(getDialog(undefined)).toBeNull();
    expect(cancelDialog('0'.repeat(32))).toBeNull();
  });
});

describe('cancel and reset', () => {
  it('cancels a waiting request, frees the slot and ignores the late reply', () => {
    const onResult = vi.fn();
    const view = startSave({ onResult });
    expect(cancelDialog(view.id)).toMatchObject({ status: 'cancelled', error: null });
    expect(onResult).toHaveBeenCalledWith('cancelled', null);
    expect(() => startPick()).not.toThrow();
    handleDialogReplyPayload(reply(view.id, 'saved'));
    expect(getDialog(view.id).status).toBe('cancelled');
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('returns a finished request unchanged', () => {
    const view = startPick();
    handleDialogReplyPayload(reply(view.id, 'failed'));
    expect(cancelDialog(view.id)).toMatchObject({ status: 'failed' });
  });

  it('a request being checked cannot be cancelled', async () => {
    let release;
    const view = startPick(() => new Promise((resolve) => (release = resolve)));
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    expect(cancelDialog(view.id).status).toBe('checking');
    release({ folderId: 'f' });
    await flush();
    expect(getDialog(view.id).status).toBe('added');
  });

  it.each(['data_reset', 'shutdown'])('resetDialogs(%s) fails a waiting request and reports a save', (code) => {
    const onResult = vi.fn();
    const view = startSave({ onResult });
    resetDialogs(code);
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code, message: FOLDER_MESSAGES[code] } });
    expect(onResult).toHaveBeenCalledWith('failed', code);
    expect(fetchFile(view.id).statusCode).toBe(404);
    expect(() => startPick()).not.toThrow();
  });

  it('resetDialogs also ends a request being checked, and its late result changes nothing', async () => {
    let release;
    const view = startPick(() => new Promise((resolve) => (release = resolve)));
    handleDialogReplyPayload(reply(view.id, 'picked', 'C:\\x'));
    resetDialogs('shutdown');
    release({ folderId: 'f' });
    await flush();
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code: 'shutdown' }, folderId: null });
  });
});

describe('serveDialogFile', () => {
  it('serves the bytes once with the right proof, then answers 404', () => {
    const view = startSave({ bytes: Buffer.from('# Notes\n') });
    const first = fetchFile(view.id);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/octet-stream');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(first.body).toString('utf8')).toBe('# Notes\n');
    const second = fetchFile(view.id);
    expect(second.statusCode).toBe(404);
    expect(second.body).toEqual({ error: 'not_found' });
  });

  it('answers the same 404 for a wrong proof, no proof, an unknown id and a pick request', () => {
    const view = startSave();
    const wrong = `${proofFor(view.id).slice(0, -1)}${proofFor(view.id).endsWith('0') ? '1' : '0'}`;
    for (const res of [fetchFile(view.id, wrong), fetchFile(view.id, null), fetchFile('e'.repeat(32), proofFor('e'.repeat(32)))]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
    expect(fetchFile(view.id).statusCode).toBe(200);
    cancelDialog(view.id);
    const pick = startPick();
    expect(fetchFile(pick.id).statusCode).toBe(404);
  });

  it('answers 404 after cancel and after expiry', () => {
    const a = startSave();
    cancelDialog(a.id);
    expect(fetchFile(a.id).statusCode).toBe(404);
    const b = startSave();
    now += DIALOG_TTL_SECONDS * 1000 + REPLY_GRACE_MS;
    expect(fetchFile(b.id).statusCode).toBe(404);
  });

  it('answers 404 once the request is settled', () => {
    const view = startSave();
    handleDialogReplyPayload(reply(view.id, 'saved'));
    expect(fetchFile(view.id).statusCode).toBe(404);
  });

  it('a fetch does not settle the request: the reply still does', () => {
    const onResult = vi.fn();
    const view = startSave({ onResult });
    fetchFile(view.id);
    expect(getDialog(view.id).status).toBe('waiting');
    expect(onResult).not.toHaveBeenCalled();
    handleDialogReplyPayload(reply(view.id, 'saved'));
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
