// POST /api/settings/updates/install: every row of the error table, the success order (check, backup, write,
// audit), the single-flight lease, and the refusals (dev channel, not desktop, opt-in off). Every step is an
// injected fake: no network, no real backup, nothing written to stdout.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ store: new Map() }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn(async () => { throw new Error('real fetch must not be used'); }) }));
vi.mock('../dataAccess.js', () => ({
  getState: vi.fn(async (key, fallback = null) => (h.store.has(key) ? h.store.get(key) : fallback)),
  setState: vi.fn(async (key, value) => {
    h.store.set(key, value);
    return { key, value };
  }),
}));

import fetch from 'node-fetch';
import { BackupError } from '../backup/errors.js';
import { __resetNetPolicyForTests, networkRequiredBody } from '../netPolicy.js';
import { DbError } from '../db/index.js';
import {
  HANDOFF_LEASE_MS,
  INSTALL_PATH,
  MANUAL_PATH,
  registerManualDownloadRoute,
  registerUpdateInstallRoute,
  releaseUpdateInstallLease,
} from '../updateInstallRoutes.js';

const available = (over = {}) => ({ status: 'available', current: '1.0.0', latest: '1.2.0', channel: 'stable', ...over });
const passLimiter = (_req, _res, next) => next();

/** Builds an app with fakes that record call order. */
function setup(over = {}) {
  const order = [];
  const deps = {
    isInstallSupported: vi.fn(() => true),
    checkForUpdate: vi.fn(async () => {
      order.push('check');
      return available();
    }),
    createBackup: vi.fn(async () => {
      order.push('backup');
      return { created: true, meta: { id: 'manual-20261007' } };
    }),
    requestShellUpdate: vi.fn(() => {
      order.push('write');
      return { nonce: 'n' };
    }),
    recordNetworkCall: vi.fn(async () => {
      order.push('audit');
    }),
    licenseStatus: vi.fn(() => ({ proSource: null })),
    now: vi.fn(() => 1_000_000),
    limiter: passLimiter,
    ...over,
  };
  const app = express();
  app.use(express.json());
  registerUpdateInstallRoute(app, deps);
  return { app, deps, order };
}

const post = (app, body = { version: '1.2.0' }, type = 'application/json') =>
  request(app).post(INSTALL_PATH).set('Content-Type', type).send(typeof body === 'string' ? body : JSON.stringify(body));

beforeEach(() => {
  h.store.clear();
  process.env.BURROW_NETWORK_OPTIN = 'updates';
  __resetNetPolicyForTests();
  fetch.mockClear();
});

describe('success', () => {
  it('hands off with 202 and runs check, backup, write, audit in that order', async () => {
    const { app, deps, order } = setup();
    const res = await post(app);
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { status: 'handed_off', version: '1.2.0', backupId: 'manual-20261007' } });
    expect(order).toEqual(['check', 'backup', 'write', 'audit']);
    expect(deps.checkForUpdate).toHaveBeenCalledWith({ refresh: true });
    expect(deps.createBackup).toHaveBeenCalledWith({ kind: 'manual', skipIfUnchanged: false });
    expect(deps.requestShellUpdate).toHaveBeenCalledWith('1.2.0');
    expect(deps.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://github.com', 'ok', { result: 'started', by: 'app' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('refusals before any work', () => {
  it('403s with the opt-in body while updates are off, and does nothing', async () => {
    process.env.BURROW_NETWORK_OPTIN = '';
    __resetNetPolicyForTests();
    const { app, deps } = setup({ gate: undefined });
    const res = await post(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(networkRequiredBody('updates'));
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
  });

  it('403s when the opt-in turns off between the click and the check', async () => {
    const { app, deps } = setup({
      checkForUpdate: vi.fn(async () => {
        throw Object.assign(new Error('off'), { status: 403 });
      }),
    });
    const res = await post(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(networkRequiredBody('updates'));
    expect(deps.createBackup).not.toHaveBeenCalled();
  });

  it('415s a body that is not JSON', async () => {
    const { app, deps } = setup();
    const res = await post(app, 'version=1.2.0', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: 'unsupported_media_type', code: 'unsupported_media_type' });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['no version', {}],
    ['an extra key', { version: '1.2.0', force: true }],
    ['a prerelease', { version: '1.2.0-rc.1' }],
    ['a dev version', { version: '0.2.0-dev.20261001.abc1234' }],
    ['a leading zero', { version: '01.2.0' }],
    ['a v prefix', { version: 'v1.2.0' }],
    ['two parts', { version: '1.2' }],
    ['a number', { version: 1.2 }],
    ['an array', ['1.2.0']],
  ])('400s %s without doing anything', async (_label, body) => {
    const { app, deps } = setup();
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_request',
      code: 'invalid_request',
      message: 'That request was not valid. Close and reopen Settings, then try again.',
    });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
  });

  it('409s update_install_unsupported outside the stable desktop app (web, Dev, no shell updater)', async () => {
    const { app, deps } = setup({ isInstallSupported: vi.fn(() => false) });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'update_install_unsupported',
      code: 'update_install_unsupported',
      message: "This copy of Burrow can't install updates by itself. Download the new version from the releases page.",
    });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
  });

  it('uses the real capability check by default: not desktop, so 409 and nothing runs', async () => {
    const saved = { d: process.env.BURROW_DESKTOP, u: process.env.BURROW_SHELL_UPDATER, c: process.env.BURROW_CHANNEL };
    try {
      delete process.env.BURROW_DESKTOP;
      process.env.BURROW_SHELL_UPDATER = '1';
      const { app, deps } = setup({ isInstallSupported: undefined });
      expect((await post(app)).status).toBe(409);
      process.env.BURROW_DESKTOP = '1';
      process.env.BURROW_CHANNEL = 'dev';
      expect((await post(app)).body.code).toBe('update_install_unsupported');
      expect(deps.checkForUpdate).not.toHaveBeenCalled();
    } finally {
      for (const [k, v] of [['BURROW_DESKTOP', saved.d], ['BURROW_SHELL_UPDATER', saved.u], ['BURROW_CHANNEL', saved.c]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('fresh check', () => {
  it.each([
    ['a different newest version', available({ latest: '1.3.0' })],
    ['no update any more', { status: 'current', current: '1.2.0', latest: '1.2.0', channel: 'stable' }],
  ])('409s update_not_available for %s and saves no backup', async (_label, status) => {
    const { app, deps } = setup({ checkForUpdate: vi.fn(async () => status) });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'update_not_available',
      code: 'update_not_available',
      message: 'That update is no longer the newest one. Check again to see the current update.',
    });
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
  });

  it('503s update_check_unavailable when GitHub cannot be reached, and when the check throws', async () => {
    for (const check of [
      vi.fn(async () => ({ status: 'unavailable', reason: 'network', current: '1.0.0', channel: 'stable' })),
      vi.fn(async () => {
        throw new Error('boom');
      }),
    ]) {
      const { app, deps } = setup({ checkForUpdate: check });
      const res = await post(app);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'update_check_unavailable',
        code: 'update_check_unavailable',
        message: "Burrow couldn't reach GitHub to confirm the update. Check your connection and try again.",
      });
      expect(deps.createBackup).not.toHaveBeenCalled();
    }
  });
});

describe('backup first', () => {
  it.each([
    [new BackupError('backup_busy'), 409, 'backup_busy', 'Burrow is busy with a backup. Try again in a minute.'],
    [
      new BackupError('disk_low'),
      507,
      'disk_low',
      "There isn't enough free disk space to save a backup first, so the update was not started. Free some space and try again.",
    ],
    [
      new BackupError('disk_full'),
      507,
      'disk_full',
      "There isn't enough free disk space to save a backup first, so the update was not started. Free some space and try again.",
    ],
    [new DbError('db_restoring', 'x'), 503, 'db_restoring', 'Burrow is restoring a backup. This takes a few seconds.'],
    [
      new BackupError('backup_failed'),
      500,
      'update_backup_failed',
      "Burrow couldn't save a backup first, so the update was not started. Your data is unchanged.",
    ],
    [
      new Error('EPERM at C:\\secret\\path'),
      500,
      'update_backup_failed',
      "Burrow couldn't save a backup first, so the update was not started. Your data is unchanged.",
    ],
  ])('maps a failed backup (%#) to %i %s and never writes to the shell', async (error, status, code, message) => {
    const { app, deps, order } = setup({
      createBackup: vi.fn(async () => {
        order.push('backup');
        throw error;
      }),
    });
    const res = await post(app);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code, code, message });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
    expect(deps.recordNetworkCall).not.toHaveBeenCalled();
    expect(order).toEqual(['check', 'backup']);
  });

  it('a failed backup releases the lease at once, so the user can retry', async () => {
    let fail = true;
    const { app, deps } = setup({
      createBackup: vi.fn(async () => {
        if (fail) throw new BackupError('backup_busy');
        return { created: true, meta: { id: 'b' } };
      }),
    });
    expect((await post(app)).status).toBe(409);
    fail = false;
    expect((await post(app)).status).toBe(202);
    expect(deps.requestShellUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('handoff', () => {
  it('500s update_handoff_failed when the stdout write throws, writes no audit row and frees the lease', async () => {
    let fail = true;
    const { app, deps } = setup({
      requestShellUpdate: vi.fn(() => {
        if (fail) throw new Error('EPIPE');
      }),
    });
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'update_handoff_failed',
      code: 'update_handoff_failed',
      message: "Burrow couldn't start the update. Close and reopen Burrow, then try again.",
    });
    expect(deps.recordNetworkCall).not.toHaveBeenCalled();
    fail = false;
    expect((await post(app)).status).toBe(202);
  });

  it('still answers 202 when the audit write fails after the handoff, and logs a safe line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, deps } = setup({
      recordNetworkCall: vi.fn(async () => {
        throw new Error('disk secret detail');
      }),
    });
    const res = await post(app);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { status: 'handed_off', version: '1.2.0', backupId: 'manual-20261007' } });
    expect(deps.requestShellUpdate).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Update install audit failed:', 'Error');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('disk secret detail');
    spy.mockRestore();
  });
});

describe('single-flight lease', () => {
  it('refuses a second request while one is running with 409 update_in_progress', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { app, deps } = setup({
      checkForUpdate: vi.fn(async () => {
        await gate;
        return available();
      }),
    });
    const first = post(app).then((r) => r);
    await vi.waitFor(() => expect(deps.checkForUpdate).toHaveBeenCalledTimes(1));
    const second = await post(app);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: 'update_in_progress',
      code: 'update_in_progress',
      message: 'An update is already starting. Wait a moment.',
    });
    release();
    expect((await first).status).toBe(202);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('holds the lease past the shell download timeout (15 min), then frees it', async () => {
    expect(HANDOFF_LEASE_MS).toBeGreaterThan(15 * 60 * 1000);
    let t = 1_000_000;
    const { app, deps } = setup({ now: vi.fn(() => t) });
    expect((await post(app)).status).toBe(202);
    t += HANDOFF_LEASE_MS - 1;
    expect((await post(app)).body.code).toBe('update_in_progress');
    t += 1;
    expect((await post(app)).status).toBe(202);
    expect(deps.requestShellUpdate).toHaveBeenCalledTimes(2);
  });

  it('releaseUpdateInstallLease (server shutdown) frees a held lease at once', async () => {
    const { app, deps } = setup();
    expect((await post(app)).status).toBe(202);
    expect((await post(app)).body.code).toBe('update_in_progress');
    releaseUpdateInstallLease();
    expect((await post(app)).status).toBe(202);
    expect(deps.requestShellUpdate).toHaveBeenCalledTimes(2);
  });

  it('refuses a validly-formed request fast, before the check, while the lease is held', async () => {
    const { app, deps } = setup();
    await post(app);
    deps.checkForUpdate.mockClear();
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });
});

describe('data lock', () => {
  it.each([
    ['a backup', 'backup_busy', 409],
    ['an erase or a closed gate', 'backup_busy', 409],
    ['a restore', 'db_restoring', 503],
  ])('refuses while %s holds the data, before the check and the backup', async (_label, code, status) => {
    const { app, deps } = setup({ dataBusyCode: vi.fn(() => code) });
    const res = await post(app);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: code, code });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
  });

  it('does not take the lease when refused for the data lock, so a retry works', async () => {
    let busy = 'backup_busy';
    const { app } = setup({ dataBusyCode: vi.fn(() => busy) });
    expect((await post(app)).status).toBe(409);
    busy = null;
    expect((await post(app)).status).toBe(202);
  });

  it('the default check reads the real backup lock and gate', async () => {
    const lock = await import('../backup/lock.js');
    const { app, deps } = setup({ dataBusyCode: undefined });
    const release = lock.tryAcquire('erase');
    try {
      expect((await post(app)).body.code).toBe('backup_busy');
    } finally {
      release();
    }
    lock.closeGate('erase');
    try {
      expect((await post(app)).body.code).toBe('backup_busy');
    } finally {
      lock.openGate();
    }
    const restore = lock.tryAcquire('restore');
    try {
      expect((await post(app)).body.code).toBe('db_restoring');
    } finally {
      restore();
    }
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect((await post(app)).status).toBe(202);
  });
});

describe('rate limit', () => {
  it('answers 429 { error, code, message } after 5 requests in the window', async () => {
    const { app } = setup({ limiter: undefined, isInstallSupported: vi.fn(() => false) });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await post(app)).status);
    expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
    const res = await post(app);
    expect(res.body).toMatchObject({ error: 'rate_limited', code: 'rate_limited' });
  });
});

describe('license gate (install)', () => {
  const paid = (updatesUntil) => () => ({ proSource: 'license', license: { updatesUntil } });
  const released = (publishedAt) => vi.fn(async () => available({ publishedAt }));

  it.each([
    ['a release after the license window', paid('2030-01-01T00:00:00Z'), '2030-06-01T00:00:00Z'],
    ['an unreadable release date', paid('2030-01-01T00:00:00Z'), null],
    ['an unreadable updatesUntil', paid('soon'), '2030-06-01T00:00:00Z'],
    [
      'a license state that throws',
      () => {
        throw new Error('not initialised');
      },
      '2030-06-01T00:00:00Z',
    ],
  ])('409s update_license_window for %s, before the backup and the handoff', async (_label, licenseStatus, publishedAt) => {
    const { app, deps } = setup({ licenseStatus, checkForUpdate: released(publishedAt) });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'update_license_window',
      code: 'update_license_window',
      message:
        "This update came out after your license's updates ended, so Pro would be off in it. Nothing was downloaded. Keep this version to keep Pro.",
    });
    expect(deps.createBackup).not.toHaveBeenCalled();
    expect(deps.requestShellUpdate).not.toHaveBeenCalled();
    expect(deps.recordNetworkCall).not.toHaveBeenCalled();
  });

  it('a refused request frees the lease', async () => {
    let licenseStatus = paid('2030-01-01T00:00:00Z');
    const { app } = setup({ licenseStatus: () => licenseStatus(), checkForUpdate: released('2030-06-01T00:00:00Z') });
    expect((await post(app)).status).toBe(409);
    licenseStatus = paid('2031-01-01T00:00:00Z');
    expect((await post(app)).status).toBe(202);
  });

  it.each([
    ['a license that covers the release', paid('2031-01-01T00:00:00Z')],
    ['a release published at the instant the window ends', paid('2030-06-01T00:00:00Z')],
    ['the trial', () => ({ proSource: 'local_trial', license: { updatesUntil: '2030-01-01T00:00:00Z' } })],
    ['a lapsed or missing license', () => ({ proSource: null, license: null })],
  ])('hands off for %s', async (_label, licenseStatus) => {
    const { app, deps } = setup({ licenseStatus, checkForUpdate: released('2030-06-01T00:00:00Z') });
    expect((await post(app)).status).toBe(202);
    expect(deps.requestShellUpdate).toHaveBeenCalledWith('1.2.0');
  });
});

const SHA = 'ab'.repeat(32);

/** Builds an app with the manual-download route and fakes that record call order. */
function setupManual(over = {}) {
  const order = [];
  const deps = {
    isManualSupported: vi.fn(() => true),
    installerArch: vi.fn(() => 'x64'),
    dataBusyCode: vi.fn(() => null),
    checkForUpdate: vi.fn(async () => {
      order.push('check');
      return available({ publishedAt: '2030-01-01T00:00:00Z' });
    }),
    licenseStatus: vi.fn(() => ({ proSource: null })),
    fetchInstallerChecksum: vi.fn(async () => {
      order.push('checksum');
      return { ok: true, sha256: SHA };
    }),
    createBackup: vi.fn(async () => {
      order.push('backup');
      return { created: true, meta: { id: 'manual-20261009' } };
    }),
    limiter: passLimiter,
    ...over,
  };
  const app = express();
  app.use(express.json());
  registerManualDownloadRoute(app, deps);
  return { app, deps, order };
}

const postManual = (app, body = { version: '1.2.0' }, type = 'application/json') =>
  request(app).post(MANUAL_PATH).set('Content-Type', type).send(typeof body === 'string' ? body : JSON.stringify(body));

describe('manual download: success', () => {
  it('returns the pinned installer url, the sha-256 and the backup id, in the order check, checksum, backup', async () => {
    const { app, deps, order } = setupManual();
    const res = await postManual(app);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        status: 'ready',
        version: '1.2.0',
        arch: 'x64',
        fileName: 'Burrow-Setup-x64.exe',
        installerUrl: 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.0/Burrow-Setup-x64.exe',
        sha256: SHA,
        sumsUrl: 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.0/SHA256SUMS.txt',
        backupId: 'manual-20261009',
      },
    });
    expect(order).toEqual(['check', 'checksum', 'backup']);
    expect(deps.checkForUpdate).toHaveBeenCalledWith({ refresh: true, source: 'release' });
    expect(deps.fetchInstallerChecksum).toHaveBeenCalledWith({ version: '1.2.0', arch: 'x64' });
    expect(deps.createBackup).toHaveBeenCalledWith({ kind: 'manual', skipIfUnchanged: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the arm64 installer on an arm64 machine', async () => {
    const { app } = setupManual({ installerArch: vi.fn(() => 'arm64') });
    const res = await postManual(app);
    expect(res.body.data).toMatchObject({
      arch: 'arm64',
      fileName: 'Burrow-Setup-arm64.exe',
      installerUrl: 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.0/Burrow-Setup-arm64.exe',
    });
  });

  it('uses a null backup id when the backup result has none', async () => {
    const { app } = setupManual({ createBackup: vi.fn(async () => ({ created: true })) });
    expect((await postManual(app)).body.data.backupId).toBeNull();
  });

  it('allows a license that covers the release and the trial', async () => {
    for (const licenseStatus of [
      () => ({ proSource: 'license', license: { updatesUntil: '2031-01-01T00:00:00Z' } }),
      () => ({ proSource: 'local_trial', license: null }),
    ]) {
      const { app } = setupManual({ licenseStatus });
      expect((await postManual(app)).status).toBe(200);
    }
  });
});

describe('manual download: refusals before any work', () => {
  it('403s with the opt-in body while updates are off, and does nothing', async () => {
    process.env.BURROW_NETWORK_OPTIN = '';
    __resetNetPolicyForTests();
    const { app, deps } = setupManual({ gate: undefined });
    const res = await postManual(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(networkRequiredBody('updates'));
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.fetchInstallerChecksum).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
  });

  it('403s when the opt-in turns off between the click and the check or the checksum', async () => {
    const off = vi.fn(async () => {
      throw Object.assign(new Error('off'), { status: 403 });
    });
    const a = setupManual({ checkForUpdate: off });
    expect((await postManual(a.app)).body).toEqual(networkRequiredBody('updates'));
    const b = setupManual({ fetchInstallerChecksum: off });
    const res = await postManual(b.app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(networkRequiredBody('updates'));
    expect(b.deps.createBackup).not.toHaveBeenCalled();
  });

  it('415s a body that is not JSON', async () => {
    const { app, deps } = setupManual();
    const res = await postManual(app, 'version=1.2.0', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: 'unsupported_media_type' });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it('429s after 5 requests in the window', async () => {
    const { app } = setupManual({ limiter: undefined, isManualSupported: vi.fn(() => false) });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await postManual(app)).status);
    expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
    expect((await postManual(app)).body).toMatchObject({ error: 'rate_limited', code: 'rate_limited' });
  });

  it.each([
    ['no version', {}],
    ['an extra key', { version: '1.2.0', url: 'https://evil.example/x.exe' }],
    ['a prerelease', { version: '1.2.0-rc.1' }],
    ['a v prefix', { version: 'v1.2.0' }],
    ['a path', { version: '../../1.2.0' }],
    ['a number', { version: 1.2 }],
    ['an array', ['1.2.0']],
  ])('400s %s without doing anything', async (_label, body) => {
    const { app, deps } = setupManual();
    const res = await postManual(app, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request', code: 'invalid_request' });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
  });

  it('409s update_manual_unsupported when the copy cannot use it, or has no usable architecture', async () => {
    for (const over of [{ isManualSupported: vi.fn(() => false) }, { installerArch: vi.fn(() => null) }]) {
      const { app, deps } = setupManual(over);
      const res = await postManual(app);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'update_manual_unsupported',
        code: 'update_manual_unsupported',
        message: "This copy of Burrow can't get the installer for you. Download the new version from the releases page.",
      });
      expect(deps.checkForUpdate).not.toHaveBeenCalled();
    }
  });

  it('uses the real capability check by default: not desktop, so 409 and nothing runs', async () => {
    const saved = { d: process.env.BURROW_DESKTOP, u: process.env.BURROW_SHELL_UPDATER };
    try {
      delete process.env.BURROW_DESKTOP;
      delete process.env.BURROW_SHELL_UPDATER;
      const { app, deps } = setupManual({ isManualSupported: undefined });
      expect((await postManual(app)).body.code).toBe('update_manual_unsupported');
      expect(deps.checkForUpdate).not.toHaveBeenCalled();
    } finally {
      for (const [k, v] of [['BURROW_DESKTOP', saved.d], ['BURROW_SHELL_UPDATER', saved.u]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('409s update_in_progress while one request is running, and frees it afterwards', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { app, deps } = setupManual({
      checkForUpdate: vi.fn(async () => {
        await gate;
        return available({ publishedAt: '2030-01-01T00:00:00Z' });
      }),
    });
    const first = postManual(app).then((r) => r);
    await vi.waitFor(() => expect(deps.checkForUpdate).toHaveBeenCalledTimes(1));
    const second = await postManual(app);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'update_in_progress', code: 'update_in_progress' });
    release();
    expect((await first).status).toBe(200);
    expect((await postManual(app)).status).toBe(200);
  });

  it.each([
    ['backup_busy', 409],
    ['db_restoring', 503],
  ])('refuses with %s while the data is locked, before the check', async (code, status) => {
    const { app, deps } = setupManual({ dataBusyCode: vi.fn(() => code) });
    const res = await postManual(app);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: code, code });
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
  });
});

describe('manual download: fresh check, license and checksum', () => {
  it('503s update_check_unavailable when GitHub cannot be reached, and when the check throws', async () => {
    for (const check of [
      vi.fn(async () => ({ status: 'unavailable', reason: 'network', current: '1.0.0', channel: 'stable' })),
      vi.fn(async () => {
        throw new Error('boom');
      }),
    ]) {
      const { app, deps } = setupManual({ checkForUpdate: check });
      const res = await postManual(app);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('update_check_unavailable');
      expect(deps.fetchInstallerChecksum).not.toHaveBeenCalled();
      expect(deps.createBackup).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['a different newest version', available({ latest: '1.3.0' })],
    ['an older newest version (no downgrade)', { status: 'current', current: '1.2.0', latest: '1.1.0', channel: 'stable' }],
    ['no update any more', { status: 'current', current: '1.2.0', latest: '1.2.0', channel: 'stable' }],
  ])('409s update_not_available for %s', async (_label, status) => {
    const { app, deps } = setupManual({ checkForUpdate: vi.fn(async () => status) });
    const res = await postManual(app);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_not_available');
    expect(deps.fetchInstallerChecksum).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
  });

  it.each([
    ['a release after the license window', () => ({ proSource: 'license', license: { updatesUntil: '2029-01-01T00:00:00Z' } })],
    ['an unreadable updatesUntil', () => ({ proSource: 'license', license: { updatesUntil: 'soon' } })],
    [
      'a license state that throws',
      () => {
        throw new Error('not initialised');
      },
    ],
  ])('409s update_license_window for %s, before the checksum request and the backup', async (_label, licenseStatus) => {
    const { app, deps } = setupManual({ licenseStatus });
    const res = await postManual(app);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_license_window');
    expect(deps.fetchInstallerChecksum).not.toHaveBeenCalled();
    expect(deps.createBackup).not.toHaveBeenCalled();
  });

  it('503s update_checksum_unavailable when the checksum is missing, fails or throws, and saves no backup', async () => {
    for (const fetchInstallerChecksum of [
      vi.fn(async () => ({ ok: false, reason: 'bad_response' })),
      vi.fn(async () => {
        throw new Error('boom');
      }),
    ]) {
      const { app, deps } = setupManual({ fetchInstallerChecksum });
      const res = await postManual(app);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'update_checksum_unavailable',
        code: 'update_checksum_unavailable',
        message:
          "Burrow couldn't get the checksum for this update from GitHub, so it did not show the download. Check your connection and try again.",
      });
      expect(deps.createBackup).not.toHaveBeenCalled();
    }
  });

  it('makes no audit row of its own: the checksum fetch is the only network record', async () => {
    const { app, deps } = setupManual();
    await postManual(app);
    expect(deps.fetchInstallerChecksum).toHaveBeenCalledTimes(1);
  });
});

describe('manual download: backup', () => {
  it.each([
    [new BackupError('backup_busy'), 409, 'backup_busy'],
    [new BackupError('disk_low'), 507, 'disk_low'],
    [new BackupError('disk_full'), 507, 'disk_full'],
    [new DbError('db_restoring', 'x'), 503, 'db_restoring'],
    [new BackupError('backup_failed'), 500, 'update_backup_failed'],
    [new Error('EPERM at C:\\secret\\path'), 500, 'update_backup_failed'],
  ])('maps a failed backup (%#) to %i %s and shows no download', async (error, status, code) => {
    const { app, order } = setupManual({
      createBackup: vi.fn(async () => {
        order.push('backup');
        throw error;
      }),
    });
    const res = await postManual(app);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: code, code });
    expect(res.body).not.toHaveProperty('data');
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(order).toEqual(['check', 'checksum', 'backup']);
  });
});

describe('manual download: backup reuse', () => {
  it('reuses the backup for the same version for 10 minutes, still re-checking license and checksum each time', async () => {
    let t = 1_000_000;
    const { app, deps } = setupManual({ now: () => t });
    const first = await postManual(app);
    t += 9 * 60 * 1000;
    const second = await postManual(app);
    expect(second.status).toBe(200);
    expect(second.body.data.backupId).toBe(first.body.data.backupId);
    expect(deps.createBackup).toHaveBeenCalledTimes(1);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(2);
    expect(deps.licenseStatus).toHaveBeenCalledTimes(2);
    expect(deps.fetchInstallerChecksum).toHaveBeenCalledTimes(2);
    t += 2 * 60 * 1000;
    await postManual(app);
    expect(deps.createBackup).toHaveBeenCalledTimes(2);
  });

  it('saves a new backup for another version, and again after a failed backup', async () => {
    const { app, deps } = setupManual({
      checkForUpdate: vi.fn(async () => available({ latest: '1.3.0', publishedAt: '2030-01-01T00:00:00Z' })),
    });
    await postManual(app, { version: '1.3.0' });
    await postManual(app, { version: '1.3.0' });
    expect(deps.createBackup).toHaveBeenCalledTimes(1);

    const failing = setupManual({
      createBackup: vi
        .fn()
        .mockRejectedValueOnce(new BackupError('backup_failed'))
        .mockResolvedValue({ created: true, meta: { id: 'm2' } }),
    });
    expect((await postManual(failing.app)).status).toBe(500);
    expect((await postManual(failing.app)).body.data.backupId).toBe('m2');
    expect(failing.deps.createBackup).toHaveBeenCalledTimes(2);
  });

  it('still applies the license gate to a repeat click', async () => {
    const { app, deps } = setupManual();
    await postManual(app);
    deps.licenseStatus.mockReturnValue({ proSource: 'license', license: { updatesUntil: '2020-01-01T00:00:00Z' } });
    const res = await postManual(app);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_license_window');
    expect(deps.createBackup).toHaveBeenCalledTimes(1);
  });
});
