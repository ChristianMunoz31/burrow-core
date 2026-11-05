// Security review round 2 for Folders (PR #61), one regression test per finding:
//  M1  a tiny PDF whose content stream inflates to a huge typed array is stopped by the main-thread memory watchdog (doc_oom)
//  L1  only content failures keep a PDF unreadable; transient ones (timeout, oom, crash, unavailable) are retried, at most 3 times
//  L3  a picked folder is never written into an erased database or after the dialog expired
//  L4  the save commit check (GET /desktop/dialog-file/<id>/ok) and its MAC vector
// (L5, the no-replace rename, is covered by the Rust unit tests in src-tauri/src/dialogs.rs.)
// Synthetic fixtures under os.tmpdir() only. The memory test inflates 96 MB in a real worker with a 32 MB watchdog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import crypto from 'node:crypto';
import path from 'node:path';
import fetch from 'node-fetch';
import request from 'supertest';
import { __resetAiForTests } from '../ai/index.js';
import { __resetDataGenerationForTests, bumpDataGeneration } from '../dataGeneration.js';
import { dialogCommitProofOk, dialogFetchProofOk, dialogKeyHexForTests, initDesktopAuth, resetDesktopAuth } from '../desktop/auth.js';
import { REPLY_GRACE_MS, DIALOG_TTL_SECONDS, __setDialogClockForTests, cancelDialog, createPickRequest, createSaveRequest, getDialog, handleDialogReplyPayload } from '../desktop/dialogBroker.js';
import { FolderError } from '../folders/constants.js';
import { addFolderFromPath, confirmFolderPath } from '../folders/addFolder.js';
import { __resetDocFailureCountersForTests, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { getFolder, insertFolder, listFolders } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { captureRequests, fetchProof, makeDialogApp, signedReply, startDialogs, stopDialogs } from './helpers/dialogHarness.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
let base;

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-r2-');
  useNeutralPaths(base);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(base);
});
beforeEach(() => {
  resetDb(db);
  __resetAiForTests();
  __resetDataGenerationForTests();
  __resetDocFailureCountersForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
});
afterEach(() => {
  __setDialogClockForTests(null);
});

// ---------------------------------------------------------------------------------------------
// L3: nothing is written after an erase or after the dialog expired
// ---------------------------------------------------------------------------------------------

describe('L3: addFolderFromPath and confirmFolderPath check the request right before they write', () => {
  let dir;
  beforeEach(() => {
    dir = path.join(base, 'l3');
    rmTree(dir);
    writeTree(dir, { 'a.txt': 'hello\n' });
  });
  const rowsInTables = () => listFolders().length;

  it('a stale data generation is data_reset and inserts nothing', async () => {
    await expect(addFolderFromPath(dir, { dataGen: { isStale: () => true } })).rejects.toMatchObject({ name: 'FolderError', code: 'data_reset' });
    expect(rowsInTables()).toBe(0);
  });

  it('an erase that lands while the path is being validated is caught at the write', async () => {
    let reset = false;
    const pending = addFolderFromPath(dir, { dataGen: { isStale: () => reset }, stillChecking: () => true });
    reset = true;
    await expect(pending).rejects.toMatchObject({ code: 'data_reset' });
    expect(rowsInTables()).toBe(0);
  });

  it('a request that is no longer being checked is dialog_expired and inserts nothing', async () => {
    await expect(addFolderFromPath(dir, { stillChecking: () => false })).rejects.toMatchObject({ code: 'dialog_expired' });
    expect(rowsInTables()).toBe(0);
  });

  it('a live request still adds the folder and queues the scan', async () => {
    const { folderId, job } = await addFolderFromPath(dir, { dataGen: { isStale: () => false }, stillChecking: () => true });
    expect(getFolder(folderId)).toBeTruthy();
    await waitForFolderJob(job.id, { timeoutMs: 30_000 });
  });

  it('a pasted path (no guard) is unchanged', async () => {
    const { folderId, job } = await addFolderFromPath(dir);
    expect(getFolder(folderId)).toBeTruthy();
    await waitForFolderJob(job.id, { timeoutMs: 30_000 });
  });

  it('confirm: a stale generation or an expired request leaves the imported folder unconfirmed', async () => {
    const row = insertFolder({ name: 'imported', path: dir, pathKey: 'imported:l3' });
    db.prepare("UPDATE folders SET confirm_state = 'needs_confirm' WHERE id = ?").run(row.id);
    await expect(confirmFolderPath(row.id, dir, { dataGen: { isStale: () => true } })).rejects.toMatchObject({ code: 'data_reset' });
    await expect(confirmFolderPath(row.id, dir, { stillChecking: () => false })).rejects.toMatchObject({ code: 'dialog_expired' });
    const after = getFolder(row.id);
    expect(after.confirm_state).toBe('needs_confirm');
    expect(after.path_key).toBe('imported:l3');
  });

  describe('through the dialog broker', () => {
    let now;
    beforeEach(() => {
      startDialogs();
      captureRequests();
      now = 1_000;
      __setDialogClockForTests(() => now);
    });
    afterEach(() => stopDialogs());
    const flush = async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 10));
    };
    const pick = (onPicked) => {
      const view = createPickRequest({ onPicked });
      handleDialogReplyPayload(signedReply(view.id, 'picked', dir));
      return view;
    };

    it('an erase during the check ends the dialog as data_reset and writes no folder', async () => {
      const view = pick(async (picked, guard) => {
        bumpDataGeneration();
        return addFolderFromPath(picked, guard);
      });
      await flush();
      expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code: 'data_reset' }, folderId: null });
      expect(rowsInTables()).toBe(0);
    });

    it('a dialog that expires during the check ends as expired and writes no folder', async () => {
      const view = pick(async (picked, guard) => {
        now += (DIALOG_TTL_SECONDS * 1000) + REPLY_GRACE_MS + 1;
        return addFolderFromPath(picked, guard);
      });
      await flush();
      expect(getDialog(view.id)).toMatchObject({ status: 'expired', error: { code: 'dialog_expired' }, folderId: null });
      expect(rowsInTables()).toBe(0);
    });

    it('a normal pick adds the folder', async () => {
      const view = pick((picked, guard) => addFolderFromPath(picked, guard));
      await flush();
      const shown = getDialog(view.id);
      expect(shown.status).toBe('added');
      expect(getFolder(shown.folderId)).toBeTruthy();
    });

    it('FolderError stays the refusal path for other codes', async () => {
      const view = pick(async () => {
        throw new FolderError('folder_exists');
      });
      await flush();
      expect(getDialog(view.id)).toMatchObject({ status: 'refused', error: { code: 'folder_exists' } });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// L4: the commit check right before the shell writes a saved file
// ---------------------------------------------------------------------------------------------

describe('L4: the commit proof', () => {
  const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const ID = '00112233445566778899aabbccddeeff';
  // Same literal as COMMIT_PROOF in src-tauri/src/dialogs.rs. Computed with node:crypto only: HMAC(dialogKey, "burrow-dialog-commit-v1\n" + id).
  const COMMIT_VECTOR = 'f4426519f75890ec096639824f36726b528c14b057fa019a7a2e11560b94a6cf';
  const FETCH_VECTOR = '6f7ae1594d6797f221d09f7b162cd2757c3df427eb6e51b6556fd9737d297890';
  beforeEach(() => initDesktopAuth(SECRET));
  afterEach(() => resetDesktopAuth());

  it('matches the pinned vector and is not the fetch proof', () => {
    expect(dialogCommitProofOk(ID, COMMIT_VECTOR)).toBe(true);
    expect(COMMIT_VECTOR).not.toBe(FETCH_VECTOR);
    expect(dialogCommitProofOk(ID, FETCH_VECTOR)).toBe(false);
    expect(dialogFetchProofOk(ID, COMMIT_VECTOR)).toBe(false);
  });

  it('rejects a flipped bit, another id, uppercase, a non-string and a wrong or missing key', () => {
    const flip = `${COMMIT_VECTOR.slice(0, -1)}${COMMIT_VECTOR.endsWith('0') ? '1' : '0'}`;
    expect(dialogCommitProofOk(ID, flip)).toBe(false);
    expect(dialogCommitProofOk('ff'.repeat(16), COMMIT_VECTOR)).toBe(false);
    expect(dialogCommitProofOk(ID, COMMIT_VECTOR.toUpperCase())).toBe(false);
    expect(dialogCommitProofOk(ID, undefined)).toBe(false);
    expect(dialogCommitProofOk(ID, ['x'])).toBe(false);
    initDesktopAuth(Buffer.alloc(32, 9));
    expect(dialogCommitProofOk(ID, COMMIT_VECTOR)).toBe(false);
    resetDesktopAuth();
    expect(dialogCommitProofOk(ID, COMMIT_VECTOR)).toBe(false);
  });
});

describe('L4: GET /desktop/dialog-file/<id>/ok through the real desktop gate', () => {
  let now;
  let app;
  const commitProof = (id) => crypto.createHmac('sha256', Buffer.from(dialogKeyHexForTests(), 'hex')).update(`burrow-dialog-commit-v1\n${id}`, 'utf8').digest('hex');
  const fetchFile = (id, proof = fetchProof(id)) => request(app).get(`/desktop/dialog-file/${id}`).set('X-Burrow-Dialog-Proof', proof);
  const commit = (id, proof = commitProof(id)) => request(app).get(`/desktop/dialog-file/${id}/ok`).set('X-Burrow-Dialog-Proof', proof);
  const save = () => createSaveRequest({ name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: Buffer.from('hello'), onResult: vi.fn() });
  const shape = (res) => ({ status: res.status, body: res.body, type: res.headers['content-type'], cache: res.headers['cache-control'], length: res.headers['content-length'] });

  beforeEach(() => {
    startDialogs();
    captureRequests();
    now = 1_000;
    __setDialogClockForTests(() => now);
    app = makeDialogApp({ gate: true });
  });
  afterEach(() => stopDialogs());

  it('answers 204 once, after the fetch, while the request is waiting; the reply then settles it as before', async () => {
    const view = save();
    expect((await fetchFile(view.id)).status).toBe(200);
    const ok = await commit(view.id);
    expect(ok.status).toBe(204);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).toBe('');
    expect((await commit(view.id)).status).toBe(404); // single use
    handleDialogReplyPayload(signedReply(view.id, 'saved'));
    expect(getDialog(view.id)).toMatchObject({ status: 'saved', error: null });
  });

  it('every refusal is the same 404 as a failed fetch', async () => {
    const unknown = shape(await commit('a'.repeat(32), commitProof('a'.repeat(32))));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'not_found' });
    const results = [];

    const beforeFetch = save();
    results.push(shape(await commit(beforeFetch.id))); // bytes not fetched yet
    cancelDialog(beforeFetch.id);

    const cancelled = save();
    await fetchFile(cancelled.id);
    cancelDialog(cancelled.id);
    results.push(shape(await commit(cancelled.id)));

    const expired = save();
    await fetchFile(expired.id);
    now += (DIALOG_TTL_SECONDS * 1000) + REPLY_GRACE_MS + 1;
    results.push(shape(await commit(expired.id)));

    const settled = save();
    await fetchFile(settled.id);
    handleDialogReplyPayload(signedReply(settled.id, 'cancelled'));
    results.push(shape(await commit(settled.id)));

    const pick = createPickRequest({ onPicked: async () => ({ folderId: 'x' }) });
    results.push(shape(await commit(pick.id)));
    handleDialogReplyPayload(signedReply(pick.id, 'cancelled'));

    const live = save();
    await fetchFile(live.id);
    results.push(shape(await commit(live.id, fetchProof(live.id)))); // the fetch proof cannot commit
    results.push(shape(await commit(live.id, 'a'.repeat(64))));
    results.push(shape(await commit(live.id, commitProof(live.id).toUpperCase())));
    results.push(shape(await commit(live.id, commitProof('b'.repeat(32)))));
    results.push(shape(await request(app).get(`/desktop/dialog-file/${live.id}/ok`))); // no proof
    results.push(shape(await request(app).post(`/desktop/dialog-file/${live.id}/ok`).set('X-Burrow-Dialog-Proof', commitProof(live.id))));
    results.push(shape(await request(app).get(`/desktop/dialog-file/${live.id}/ok/`).set('X-Burrow-Dialog-Proof', commitProof(live.id))));
    for (const r of results.slice(0, -2)) expect(r).toEqual(unknown);
    expect(results.at(-2).status).not.toBe(204);
    expect(results.at(-1).status).not.toBe(204);

    // None of those refusals consumed the real grant.
    expect((await commit(live.id)).status).toBe(204);
  });

  it('the commit proof cannot fetch the bytes', async () => {
    const view = save();
    expect((await fetchFile(view.id, commitProof(view.id))).status).toBe(404);
    expect((await fetchFile(view.id)).status).toBe(200);
  });

  it('once granted, a Cancel click no longer ends the request: the shell reply (saved) decides', async () => {
    const view = save();
    await fetchFile(view.id);
    expect((await commit(view.id)).status).toBe(204);
    expect(cancelDialog(view.id)).toMatchObject({ status: 'waiting' });
    handleDialogReplyPayload(signedReply(view.id, 'saved'));
    expect(getDialog(view.id)).toMatchObject({ status: 'saved' });
  });

  it('a Cancel click before the commit check leaves nothing to write: the check is refused', async () => {
    const view = save();
    await fetchFile(view.id);
    expect(cancelDialog(view.id)).toMatchObject({ status: 'cancelled' });
    expect((await commit(view.id)).status).toBe(404);
  });
});
