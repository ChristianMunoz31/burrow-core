// Exporting a folder report through the native save dialog: the request line, the one-time byte fetch through the real
// desktop gate, the audit row (never a path or file name), the size limit and the unchanged download behaviour.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

import path from 'node:path';
import { listAudit } from '../audit.js';
import { bumpDataGeneration, __resetDataGenerationForTests } from '../dataGeneration.js';
import { select } from '../db/index.js';
import { getDialog } from '../desktop/dialogBroker.js';
import { upsertFileRows } from '../folders/store.js';
import { COPY, addFolderRow, errorBody, makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { SAME_ORIGIN, captureRequests, deliver, fetchProof, gateCookie, makeDialogApp, startDialogs, stopDialogs } from './helpers/dialogHarness.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
let root;
let dir;
let folder;
let app;
let captured;

const exportReq = (body) => request(app).post(`/api/folders/${folder.id}/export`).set(SAME_ORIGIN).set('Cookie', gateCookie()).send(body);
const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
};
const fetchBytes = (id, proof = fetchProof(id)) => {
  const req = request(app).get(`/desktop/dialog-file/${id}`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return proof === null ? req : req.set('X-Burrow-Dialog-Proof', proof);
};
const folderAudit = async () => (await listAudit({ limit: 100 })).entries.filter((r) => r.feature === 'folder_export');
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(async () => {
  db = createTestDb();
  root = makeTmp('burrow-folders-save-');
  dir = path.join(root, 'notes');
  writeTree(dir, { 'plan.txt': 'tomatoes' });
});
afterAll(() => {
  __setPathOptionsForTests(null);
  closeTestDb(db);
  rmTree(root);
});
beforeEach(async () => {
  resetDb(db);
  __resetDataGenerationForTests();
  startDialogs();
  captured = captureRequests();
  app = makeDialogApp({ gate: true });
  __setPathOptionsForTests(neutralPathOptions(root));
  folder = await addFolderRow(dir, 'Garden notes');
  upsertFileRows(folder.id, [
    { rel_path: 'plan.txt', ext: 'txt', kind: 'text', status: 'ok', size_bytes: 8, mtime: '2026-01-02T03:04:05.000Z', sha256: 'a'.repeat(64), seen_at: '2026-10-08T00:00:00.000Z' },
    { rel_path: 'sub/caf\u00e9, "notes".md', ext: 'md', kind: 'text', status: 'ok', size_bytes: 12, mtime: '2026-01-03T03:04:05.000Z', sha256: 'b'.repeat(64), seen_at: '2026-10-08T00:00:00.000Z' },
  ]);
});
afterEach(() => {
  stopDialogs();
  vi.restoreAllMocks();
});

describe('POST /api/folders/:id/export with target "choose"', () => {
  it.each(['md', 'json', 'csv'])('answers 202 with a dialog and prints a %s save request line', async (format) => {
    const res = await exportReq({ format, target: 'choose' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data.dialog).toMatchObject({ kind: 'save_file', status: 'waiting', folderId: null, error: null, folder: null, job: null });
    const [line] = captured.requests();
    expect(line).toMatchObject({ v: 1, kind: 'save_file', id: res.body.data.dialog.id, ttl: 900, ext: format });
    expect(line.name).toMatch(new RegExp(`^burrow-folder-garden-notes-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
    expect(line.bytes).toBeGreaterThan(0);
    expect(line.mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves bytes identical to the download response, once, through the real desktop gate', async () => {
    const download = await exportReq({ format: 'json' });
    expect(download.status).toBe(200);
    const res = await exportReq({ format: 'json', target: 'choose' });
    const [line] = captured.requests();
    expect(line.bytes).toBe(Buffer.byteLength(download.text, 'utf8'));
    // The shell has no cookie: only the proof header opens the route.
    const first = await fetchBytes(res.body.data.dialog.id);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(first.body.length).toBe(line.bytes);
    // exportedAt differs by the second; compare the rows.
    expect(JSON.parse(first.body.toString('utf8')).files).toEqual(JSON.parse(download.text).files);
    const second = await fetchBytes(res.body.data.dialog.id);
    expect(second.status).toBe(404);
    expect(second.body.toString()).toContain('not_found');
  });

  it('does not serve the bytes without the proof, with a wrong proof or for another id', async () => {
    const res = await exportReq({ format: 'md', target: 'choose' });
    const id = res.body.data.dialog.id;
    expect((await fetchBytes(id, null)).status).toBe(404);
    expect((await fetchBytes(id, 'a'.repeat(64))).status).toBe(404);
    expect((await fetchBytes('b'.repeat(32))).status).toBe(404);
    expect((await fetchBytes(id)).status).toBe(200);
  });

  it('writes exactly one audit row on "saved", with the target and result and no path or file name anywhere', async () => {
    const res = await exportReq({ format: 'csv', target: 'choose' });
    expect(await folderAudit()).toEqual([]);
    deliver(res.body.data.dialog.id, 'saved');
    await flush();
    const rows = await folderAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'export', feature: 'folder_export', page: 'folders', status: 'ok', meta: { format: 'csv', files: 2, target: 'chosen', result: 'saved' } });
    const everything = JSON.stringify(select('audit_log'));
    expect(everything).not.toContain('burrow-folder');
    expect(everything).not.toContain(dir);
    expect(everything).not.toContain('Garden');
    expect(everything).not.toContain('caf');
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['exists', 'failed'],
    ['write_failed', 'failed'],
    ['fetch_failed', 'failed'],
  ])('writes one error audit row for the reply %s', async (reply, status) => {
    const res = await exportReq({ format: 'md', target: 'choose' });
    deliver(res.body.data.dialog.id, reply);
    await flush();
    const rows = await folderAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', meta: { target: 'chosen', result: status } });
    expect((await request(app).get(`/api/folders/dialogs/${res.body.data.dialog.id}`).set('Cookie', gateCookie())).body.data.dialog.status).toBe(status);
  });

  it('writes no audit row when the data was erased before the request ended', async () => {
    const res = await exportReq({ format: 'md', target: 'choose' });
    bumpDataGeneration();
    deliver(res.body.data.dialog.id, 'saved');
    await flush();
    expect(getDialog(res.body.data.dialog.id).status).toBe('saved');
    expect(await folderAudit()).toEqual([]);
  });

  it('answers 413 save_too_large above the limit, prints no line and writes no row', async () => {
    app = makeDialogApp({ gate: true, maxSaveBytes: 50 });
    expectError(await exportReq({ format: 'json', target: 'choose' }), 'save_too_large');
    expect(captured.lines).toEqual([]);
    expect(await folderAudit()).toEqual([]);
    // The download of the same export still works.
    expect((await exportReq({ format: 'json' })).status).toBe(200);
  });

  it('answers 409 dialog_unavailable without the dialogs and 409 dialog_busy while one is open', async () => {
    const open = await exportReq({ format: 'md', target: 'choose' });
    expect(open.status).toBe(202);
    expectError(await exportReq({ format: 'csv', target: 'choose' }), 'dialog_busy');
    app = makeDialogApp({ gate: true, dialogsAvailable: false });
    expectError(await exportReq({ format: 'md', target: 'choose' }), 'dialog_unavailable');
  });

  it('is allowed for a folder that still waits for confirmation', async () => {
    db.prepare("UPDATE folders SET confirm_state = 'needs_confirm' WHERE id = ?").run(folder.id);
    expect((await exportReq({ format: 'md', target: 'choose' })).status).toBe(202);
  });
});

describe('POST /api/folders/:id/export without a target, or with a bad one', () => {
  it('keeps the download behaviour and audits it as a download', async () => {
    for (const body of [{ format: 'md' }, { format: 'md', target: 'download' }]) {
      const res = await exportReq(body);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="burrow-folder-garden-notes-\d{4}-\d{2}-\d{2}\.md"$/);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
    }
    expect(captured.lines).toEqual([]);
    const rows = await folderAudit();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'ok' && r.meta.target === 'download' && r.meta.format === 'md' && r.meta.files === 2)).toBe(true);
  });

  it.each([
    ['an unknown target', { format: 'md', target: 'email' }],
    ['a non-string target', { format: 'md', target: true }],
    ['an extra key', { format: 'md', target: 'choose', path: 'C:\\x' }],
    ['no format', { target: 'choose' }],
    ['an unknown format', { format: 'pdf', target: 'choose' }],
  ])('rejects %s with 400 invalid_request', async (_label, body) => {
    expectError(await exportReq(body), 'invalid_request');
    expect(captured.lines).toEqual([]);
  });
});
