import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_UPLOAD_MAX_BYTES,
  copyFromStable,
  createBackup,
  getBackupStatus,
  getStableCopyStatus,
  listBackups,
  restoreBackup,
  updateBackupSettings,
  uploadBackupFile,
} from '../backupService';

const jsonResponse = (status, body, statusText = '') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
});

afterEach(() => vi.unstubAllGlobals());

describe('backupService requests', () => {
  it('lists backups with no-store and unwraps data', async () => {
    const data = { backups: [], status: { health: 'none' }, settings: {}, location: 'x', desktop: false };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listBackups()).resolves.toEqual(data);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/backups');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBeUndefined();
  });

  it('reads the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: { health: 'ok' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getBackupStatus()).resolves.toEqual({ health: 'ok' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/backups/status');
  });

  it('reads the stable-copy status', async () => {
    const data = { found: true, dataDir: 'x', overridden: false, lastChangedAt: null, busy: false, sameFolder: false };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getStableCopyStatus()).resolves.toEqual(data);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/backups/stable-copy');
    expect(init.method).toBe('GET');
  });

  it('copies from stable with a confirm body and surfaces the server message and code', async () => {
    const ok = vi.fn().mockResolvedValue(jsonResponse(200, { data: { copiedFrom: 'x', safetyBackupId: 's' } }));
    vi.stubGlobal('fetch', ok);
    await expect(copyFromStable()).resolves.toEqual({ copiedFrom: 'x', safetyBackupId: 's' });
    const [url, init] = ok.mock.calls[0];
    expect(url).toBe('/api/backups/stable-copy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ confirm: true });
    const refused = {
      error: 'stable_not_found',
      code: 'stable_not_found',
      message: 'No Burrow data was found on this computer to copy.',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, refused)));
    await expect(copyFromStable()).rejects.toMatchObject({ status: 404, code: 'stable_not_found', message: refused.message });
  });

  it('creates a backup with a JSON body and returns the summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { data: { backup: { id: 'a' } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createBackup()).resolves.toEqual({ id: 'a' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/backups');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{}');
  });

  it('saves settings with PUT', async () => {
    const settings = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: settings }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(updateBackupSettings(settings)).resolves.toEqual(settings);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/backups/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual(settings);
  });

  it('restores by id with confirm:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: { restoredFrom: 'a' } }));
    vi.stubGlobal('fetch', fetchMock);
    await restoreBackup({ id: 'a' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/backups/restore');
    expect(JSON.parse(init.body)).toEqual({ id: 'a', confirm: true });
  });

  it('restores by upload token and sends exactly one reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await restoreBackup({ uploadToken: 'tok', id: 'ignored' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uploadToken: 'tok', confirm: true });
  });
});

describe('backupService errors', () => {
  it('shows the server message and code for a too-new backup (409)', async () => {
    const message = 'This backup was made by a newer version of Burrow. Update Burrow, then try again.';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'backup_too_new', message })));
    await expect(restoreBackup({ id: 'a' })).rejects.toMatchObject({ message, code: 'backup_too_new', status: 409 });
  });

  it('falls back to plain copy when the body has no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, {}, '')));
    await expect(createBackup()).rejects.toThrow('Too many tries');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, null, '')));
    await expect(createBackup()).rejects.toThrow('Something went wrong');
  });

  it('reports an unreachable server in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(listBackups()).rejects.toThrow("Couldn't reach the server");
  });

  it('rethrows aborts untouched', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(listBackups()).rejects.toBe(abort);
  });

  it('rejects a success body with no data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));
    await expect(getBackupStatus()).rejects.toThrow('Something went wrong');
  });
});

class FakeXhr {
  static last = null;
  constructor() {
    this.upload = {};
    this.headers = {};
    this.aborted = false;
    FakeXhr.last = this;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status, body) {
    this.status = status;
    this.statusText = '';
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload();
  }
}

describe('uploadBackupFile', () => {
  const file = () => new File([new Uint8Array(4)], 'burrow.db');

  it('posts raw bytes, reports progress and unwraps the inspection', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const onProgress = vi.fn();
    const f = file();
    const promise = uploadBackupFile(f, { onProgress });
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/backups/upload');
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.body).toBe(f);
    xhr.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(0.25);
    xhr.respond(200, { data: { uploadToken: 'tok', totalRows: 3 } });
    await expect(promise).resolves.toEqual({ uploadToken: 'tok', totalRows: 3 });
  });

  it('rejects an oversize file without a request', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.last = null;
    await expect(uploadBackupFile({ size: BACKUP_UPLOAD_MAX_BYTES + 1 })).rejects.toThrow('too large');
    expect(FakeXhr.last).toBeNull();
  });

  it('surfaces the server message for an invalid file (422)', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = uploadBackupFile(file());
    FakeXhr.last.respond(422, { error: 'backup_invalid', message: 'That is not a Burrow backup file.' });
    await expect(promise).rejects.toMatchObject({ message: 'That is not a Burrow backup file.', code: 'backup_invalid' });
  });

  it('handles a non-JSON error body and network failure', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const first = uploadBackupFile(file());
    FakeXhr.last.respond(413, '<html>');
    await expect(first).rejects.toThrow('too large');
    const second = uploadBackupFile(file());
    FakeXhr.last.onerror();
    await expect(second).rejects.toThrow("Couldn't reach the server");
  });

  it('aborts the request when the signal fires', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController();
    const promise = uploadBackupFile(file(), { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last.aborted).toBe(true);
  });
});
