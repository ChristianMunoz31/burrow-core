// Gaps left by the per-module dialog tests: the stdin inbox wired to the real broker (a reply racing the EOF that shuts
// the server down, byte-exact line cap), replies that are authentic but do not fit the request, and the uniform 404 of
// the file fetch through the real desktop gate for every way it can fail.
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));

import { __resetDataGenerationForTests } from '../dataGeneration.js';
import {
  __setDialogClockForTests,
  createPickRequest,
  createSaveRequest,
  getDialog,
  handleDialogReplyPayload,
  resetDialogs,
} from '../desktop/dialogBroker.js';
import { MAX_INBOX_LINE_BYTES, attachShellInbox } from '../desktop/shellInbox.js';
import { captureRequests, fetchProof, gateCookie, makeDialogApp, signedReply, startDialogs, stopDialogs } from './helpers/dialogHarness.js';

const PREFIX = 'BURROW_DIALOG_REPLY ';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const startPick = (onPicked = async () => ({ folderId: 'f1', job: null })) => createPickRequest({ onPicked });
const startSave = (over = {}) => createSaveRequest({ name: 'burrow-folder-notes-2026-10-08.md', ext: 'md', bytes: Buffer.from('hello'), onResult: vi.fn(), ...over });

let now;

beforeEach(() => {
  __resetDataGenerationForTests();
  startDialogs();
  captureRequests();
  now = 1_000;
  __setDialogClockForTests(() => now);
});
afterEach(() => {
  __setDialogClockForTests(null);
  stopDialogs();
});

/** The server's stdin wiring in miniature: the inbox on `data`, and a shutdown that resets the broker on `end`. */
function wireStdin() {
  const stdin = new PassThrough();
  attachShellInbox(stdin);
  const shutdown = vi.fn(() => resetDialogs('shutdown'));
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  return { stdin, shutdown };
}
const endOf = (stream) => new Promise((resolve) => stream.once('close', resolve));

describe('a reply racing the shutdown when stdin closes', () => {
  it('a reply written just before EOF settles the request, and the shutdown does not overwrite it', async () => {
    const { stdin, shutdown } = wireStdin();
    const onResult = vi.fn();
    const view = startSave({ onResult });
    stdin.write(`${PREFIX}${signedReply(view.id, 'saved')}\n`);
    stdin.end();
    await endOf(stdin);
    await flush();
    expect(shutdown).toHaveBeenCalled();
    expect(getDialog(view.id)).toMatchObject({ status: 'saved', error: null });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toBe('saved');
  });

  it('the reply and the EOF in one write behave the same', async () => {
    const { stdin } = wireStdin();
    const view = startPick();
    stdin.end(`${PREFIX}${signedReply(view.id, 'cancelled')}\n`);
    await endOf(stdin);
    await flush();
    expect(getDialog(view.id)).toMatchObject({ status: 'cancelled', error: null });
  });

  it('a reply cut off by EOF (no newline) is never acted on, and the shutdown fails the request', async () => {
    const { stdin } = wireStdin();
    const onResult = vi.fn();
    const view = startSave({ onResult });
    stdin.end(`${PREFIX}${signedReply(view.id, 'saved')}`);
    await endOf(stdin);
    await flush();
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code: 'shutdown' } });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls.map((c) => c[0])).not.toContain('saved');
  });

  it('a pick being checked when EOF arrives ends as shutdown and its late result changes nothing', async () => {
    const { stdin } = wireStdin();
    let release;
    const onPicked = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const view = startPick(onPicked);
    stdin.write(`${PREFIX}${signedReply(view.id, 'picked', 'C:\\Users\\Example\\Notes')}\n`);
    await flush();
    expect(getDialog(view.id).status).toBe('checking');
    stdin.end();
    await endOf(stdin);
    const afterShutdown = getDialog(view.id);
    expect(afterShutdown).toMatchObject({ status: 'failed', error: { code: 'shutdown' } });
    release({ folderId: 'late', job: null });
    await flush();
    expect(getDialog(view.id)).toEqual(afterShutdown);
  });

  it('replies after the shutdown (a stray write after EOF) are ignored', async () => {
    const { stdin } = wireStdin();
    const view = startPick();
    stdin.end();
    await endOf(stdin);
    handleDialogReplyPayload(signedReply(view.id, 'cancelled'));
    expect(getDialog(view.id)).toMatchObject({ status: 'failed', error: { code: 'shutdown' } });
  });

  it('two replies on one line break are each handled once, in order', async () => {
    const { stdin } = wireStdin();
    const first = startSave();
    stdin.write(`${PREFIX}${signedReply(first.id, 'cancelled')}\n`);
    const second = startPick();
    stdin.write(`${PREFIX}${signedReply(first.id, 'saved')}\n${PREFIX}${signedReply(second.id, 'cancelled')}\n`);
    await flush();
    expect(getDialog(first.id).status).toBe('cancelled'); // the replay of the same id was ignored
    expect(getDialog(second.id).status).toBe('cancelled');
  });
});

describe('the inbox line cap is exact', () => {
  const lineOfBytes = (n) => `${PREFIX}${'x'.repeat(n - PREFIX.length)}`;
  it('keeps a line of exactly the cap and drops one byte more', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, { onReply: (p) => seen.push(p.length) });
    stream.write(`${lineOfBytes(MAX_INBOX_LINE_BYTES)}\n`);
    stream.write(`${lineOfBytes(MAX_INBOX_LINE_BYTES + 1)}\n`);
    stream.write(`${lineOfBytes(MAX_INBOX_LINE_BYTES)}\n`);
    expect(seen).toEqual([MAX_INBOX_LINE_BYTES - PREFIX.length, MAX_INBOX_LINE_BYTES - PREFIX.length]);
  });

  it('applies the same cap when the line arrives in small chunks', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, { onReply: (p) => seen.push(p.length) });
    const feed = (text) => {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 1000) stream.write(bytes.subarray(i, i + 1000));
    };
    feed(`${lineOfBytes(MAX_INBOX_LINE_BYTES)}\n`);
    feed(`${lineOfBytes(MAX_INBOX_LINE_BYTES + 1)}\n`);
    feed(`${PREFIX}ok\n`);
    expect(seen).toEqual([MAX_INBOX_LINE_BYTES - PREFIX.length, 2]);
  });

  it('counts bytes, not characters: a multi-byte line over the cap is dropped', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, { onReply: (p) => seen.push(p) });
    const chars = Math.floor(MAX_INBOX_LINE_BYTES / 3);
    stream.write(`${PREFIX}${'\u20ac'.repeat(chars)}\n`); // 3 bytes each: over the cap in bytes, under in characters
    stream.write(`${PREFIX}ok\n`);
    expect(seen).toEqual(['ok']);
  });

  it('survives a lone invalid byte, an overlong form and an encoded surrogate in the middle of the stream', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, { onReply: (p) => seen.push(p) });
    stream.write(Buffer.concat([Buffer.from(PREFIX), Buffer.from([0xc0, 0xaf]), Buffer.from('\n')]));
    stream.write(Buffer.concat([Buffer.from(PREFIX), Buffer.from([0x80]), Buffer.from('\n')]));
    stream.write(Buffer.concat([Buffer.from(PREFIX), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('\n')])); // encoded surrogate
    stream.write(`${PREFIX}ok\n`);
    expect(seen).toEqual(['ok']);
  });

  // Regression: the inbox decoder keeps a leading BOM (ignoreBOM), so the exact-prefix check refuses the line.
  it('does not accept a line that has a UTF-8 BOM in front of the prefix', () => {
    const stream = new PassThrough();
    const seen = [];
    attachShellInbox(stream, { onReply: (p) => seen.push(p) });
    stream.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${PREFIX}bom\n`)]));
    expect(seen).toEqual([]);
  });
});

describe('authentic replies that do not fit the request', () => {
  it('a MAC for one status presented with another status is ignored', () => {
    const view = startPick();
    const cancelled = JSON.parse(signedReply(view.id, 'cancelled'));
    handleDialogReplyPayload(JSON.stringify({ ...cancelled, status: 'unusable' }));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it('a MAC for one path presented with another path is ignored', () => {
    const view = startPick(vi.fn());
    const picked = JSON.parse(signedReply(view.id, 'picked', 'C:\\Users\\Example\\Notes'));
    handleDialogReplyPayload(JSON.stringify({ ...picked, path: 'C:\\Windows' }));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it('a reply signed for an earlier request cannot settle the one that is waiting now', async () => {
    const old = startPick();
    handleDialogReplyPayload(signedReply(old.id, 'cancelled'));
    const current = startPick();
    const replay = JSON.parse(signedReply(old.id, 'cancelled'));
    handleDialogReplyPayload(JSON.stringify({ ...replay, id: current.id }));
    expect(getDialog(current.id).status).toBe('waiting');
    handleDialogReplyPayload(signedReply(old.id, 'cancelled'));
    expect(getDialog(current.id).status).toBe('waiting');
  });

  it.each(['saved', 'exists', 'too_large', 'fetch_failed', 'write_failed'])('the save-only status %s is ignored for a pick', (status) => {
    const view = startPick();
    handleDialogReplyPayload(signedReply(view.id, status));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it.each(['picked', 'unusable', 'failed'])('the pick-only status %s is ignored for a save', (status) => {
    const view = startSave();
    handleDialogReplyPayload(signedReply(view.id, status, status === 'picked' ? 'C:\\x' : ''));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it('a save reply that carries a path is ignored, even when the MAC covers the path', () => {
    const view = startSave();
    handleDialogReplyPayload(signedReply(view.id, 'saved', 'C:\\Users\\Example\\out.md'));
    expect(getDialog(view.id).status).toBe('waiting');
  });

  it('a reply replayed after the request expired changes nothing', () => {
    const view = startSave();
    now += (900 + 60) * 1000 + 1;
    handleDialogReplyPayload(signedReply(view.id, 'saved'));
    expect(getDialog(view.id)).toMatchObject({ status: 'expired', error: { code: 'dialog_expired' } });
  });
});

describe('the file fetch answers one 404 for every failure, through the real desktop gate', () => {
  const app = () => makeDialogApp({ gate: true });
  const get = (id, proof) => {
    const r = request(app()).get(`/desktop/dialog-file/${id}`);
    return proof === undefined ? r : r.set('X-Burrow-Dialog-Proof', proof);
  };
  const shape = (res) => ({ status: res.status, body: res.body, type: res.headers['content-type'], cache: res.headers['cache-control'], length: res.headers['content-length'] });

  it('wrong proof, no proof, unknown id, a pick id, a fetched id, a cancelled id and an expired id look identical', async () => {
    const unknown = shape(await get('a'.repeat(32), fetchProof('a'.repeat(32))));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'not_found' });

    const results = [];

    // A pick request is never a file, whatever the proof.
    const pick = startPick();
    results.push(shape(await get(pick.id, fetchProof(pick.id))));
    handleDialogReplyPayload(signedReply(pick.id, 'cancelled'));

    const cancelledSave = startSave();
    handleDialogReplyPayload(signedReply(cancelledSave.id, 'cancelled'));
    results.push(shape(await get(cancelledSave.id, fetchProof(cancelledSave.id))));

    const lateSave = startSave();
    now += (900 + 60) * 1000 + 1;
    results.push(shape(await get(lateSave.id, fetchProof(lateSave.id))));

    const live = startSave();
    results.push(shape(await get(live.id)));
    results.push(shape(await get(live.id, 'a'.repeat(64))));
    results.push(shape(await get(live.id, fetchProof(live.id).toUpperCase())));
    results.push(shape(await get(live.id, fetchProof('b'.repeat(32)))));
    results.push(shape(await get(live.id, '')));
    // The one real fetch, then the replay.
    const first = await get(live.id, fetchProof(live.id));
    expect(first.status).toBe(200);
    results.push(shape(await get(live.id, fetchProof(live.id))));

    for (const r of results) expect(r).toEqual(unknown);
  });

  it('is refused one last time at the grace boundary and served just before it', async () => {
    const early = startSave();
    now += (900 + 60) * 1000 - 1;
    expect((await get(early.id, fetchProof(early.id))).status).toBe(200);
    handleDialogReplyPayload(signedReply(early.id, 'saved'));
    const late = startSave();
    now += (900 + 60) * 1000 + 1;
    expect((await get(late.id, fetchProof(late.id))).status).toBe(404);
  });

  it('is a GET only and needs no cookie, while a normal API route behind the gate still does', async () => {
    const view = startSave();
    expect((await request(app()).post(`/desktop/dialog-file/${view.id}`).set('X-Burrow-Dialog-Proof', fetchProof(view.id))).status).not.toBe(200);
    expect((await get(view.id, fetchProof(view.id))).status).toBe(200);
    const api = await request(app()).get('/api/folders');
    expect(api.status).toBe(401);
    expect((await request(app()).get('/api/folders').set('Cookie', gateCookie())).status).toBe(200);
  });
});
