import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../exportService', () => ({
  filenameFrom: (d) => /filename="([^"]+)"/.exec(d ?? '')?.[1] ?? 'fallback.bin',
  saveBlob: vi.fn(),
}));

import { foldersService } from '../foldersService';
import { saveBlob } from '../exportService';

const json = (body, status = 200, headers = {}) => ({
  ok: status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
  blob: async () => new Blob(['x']),
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('foldersService', () => {
  it('unwraps the data envelope', async () => {
    fetchMock.mockResolvedValue(json({ data: { folders: [], limits: {} } }));
    await expect(foldersService.list()).resolves.toEqual({ folders: [], limits: {} });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/folders');
  });

  it('posts the path and name', async () => {
    fetchMock.mockResolvedValue(json({ data: { folder: {}, job: {} } }, 201));
    await foldersService.add({ path: 'C:\\A', name: 'A' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/folders');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ path: 'C:\\A', name: 'A' });
  });

  it('keeps the folder error code and shows the server message', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'folder_missing', code: 'folder_missing', message: "Burrow can't find that folder." }, 422),
    );
    const err = await foldersService.add({ path: 'C:\\A' }).catch((e) => e);
    expect(err.code).toBe('folder_missing');
    expect(err.status).toBe(422);
    expect(err.message).toBe("Burrow can't find that folder.");
    expect(err.userFacing).toBe(true);
  });

  it('builds the file list query', async () => {
    fetchMock.mockResolvedValue(json({ data: { files: [], total: 0, offset: 100, limit: 100 } }));
    await foldersService.files('abc', { offset: 100, sort: 'size', dir: 'desc' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/folders/abc/files?offset=100&limit=100&sort=size&dir=desc');
  });

  it('saves an export through the shared saver', async () => {
    fetchMock.mockResolvedValue(json(null, 200, { 'Content-Disposition': 'attachment; filename="burrow-folder-x.csv"' }));
    const out = await foldersService.exportFile('abc', 'csv');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ format: 'csv' });
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'burrow-folder-x.csv');
    expect(out.filename).toBe('burrow-folder-x.csv');
  });

  it('opens, follows and cancels the native window', async () => {
    fetchMock.mockResolvedValue(json({ data: { dialog: { id: 'd'.repeat(32), status: 'waiting' } } }, 202));
    await foldersService.pick();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/folders/pick');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    await foldersService.pick('f1');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ folderId: 'f1' });
    await foldersService.dialog('abc');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/folders/dialogs/abc');
    expect(fetchMock.mock.calls[2][1].method).toBe('GET');
    await foldersService.cancelDialog('abc');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/folders/dialogs/abc/cancel');
    expect(fetchMock.mock.calls[3][1].method).toBe('POST');
  });

  it('confirms an imported folder and asks for a chosen save location', async () => {
    fetchMock.mockResolvedValue(json({ data: {} }));
    await foldersService.confirm('f1', 'C:\\A');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/folders/f1/confirm');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ path: 'C:\\A' });
    await foldersService.exportToChosen('f1', 'md');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/folders/f1/export');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ format: 'md', target: 'choose' });
  });

  it('keeps the code of a 413 save_too_large', async () => {
    fetchMock.mockResolvedValue(json({ error: 'save_too_large', code: 'save_too_large', message: 'Too large.' }, 413));
    const err = await foldersService.exportToChosen('f1', 'json').catch((e) => e);
    expect(err.code).toBe('save_too_large');
    expect(err.status).toBe(413);
  });
});
