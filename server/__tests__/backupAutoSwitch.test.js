// The automatic backups switch (app_state key backup.auto): validation and storage, the weekly
// "off" reminder rule, the routes, the scheduler skipping while off (other jobs unaffected), Back up
// now still working, and the switch surviving a restore and an import.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

vi.mock('../../loadEnv.js', () => ({}));

import { getDb, select, setDbMaintenance } from '../db/index.js';
import { getState, setState } from '../dataAccess.js';
import { importZipBuffer } from '../import/importExport.js';
import { restoreGateMiddleware } from '../backup/lock.js';
import { registerBackupRoutes } from '../backup/routes.js';
import { RESTORE_CARRY_KEYS, inspectUpload, restoreBackup } from '../backup/restore.js';
import {
  createBackup,
  FUTURE_SKEW_MS,
  POKE_DELAY_MS,
  RETRY_AFTER_FAILURE_MS,
  getBackupStatus,
  isBackupDue,
  isBackupSchedulerRunning,
  pokeBackupScheduler,
  runScheduledBackup,
  startBackupScheduler,
  stopBackupScheduler,
} from '../backup/service.js';
import { listMetas } from '../backup/manifest.js';
import { ensureBackupsDir } from '../backup/paths.js';
import {
  BACKUP_AUTO_KEY,
  REMINDER_INTERVAL_MS,
  dismissAutoOffReminder,
  getAutoBackup,
  saveAutoBackup,
  shouldShowAutoOffReminder,
  validateAutoBackupInput,
} from '../backup/settings.js';
import { startScheduler, stopScheduler } from '../scheduler.js';
import { backupFile, cleanupBackupEnv, dataDir, day, fakeUploadReq, noSleep, resetBackupEnv } from './helpers/backupEnv.js';

const realSetTimeout = globalThis.setTimeout;
const settle = (ms = 80) => new Promise((r) => realSetTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  resetBackupEnv();
});
afterEach(() => {
  stopBackupScheduler();
  stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  cleanupBackupEnv();
});

describe('validation and storage', () => {
  it('accepts exactly { enabled: boolean }', () => {
    expect(validateAutoBackupInput({ enabled: false })).toEqual({ enabled: false });
    expect(validateAutoBackupInput({ enabled: true })).toEqual({ enabled: true });
    for (const bad of [null, [], 'x', 1, {}, { enabled: 'yes' }, { enabled: 1 }, { enabled: true, extra: 1 }, { on: true }]) {
      expect(() => validateAutoBackupInput(bad)).toThrowError(expect.objectContaining({ code: 'invalid_settings' }));
    }
  });

  it('defaults to on when nothing or something damaged is saved', async () => {
    expect(await getAutoBackup()).toEqual({ enabled: true, changedAt: null, reminderDismissedAt: null });
    await setState(BACKUP_AUTO_KEY, 'garbage');
    expect((await getAutoBackup()).enabled).toBe(true);
    await setState(BACKUP_AUTO_KEY, { enabled: 'no' });
    expect((await getAutoBackup()).enabled).toBe(true);
    await setState(BACKUP_AUTO_KEY, { enabled: false, changedAt: 'nope', reminderDismissedAt: 5 });
    expect(await getAutoBackup()).toEqual({ enabled: false, changedAt: null, reminderDismissedAt: null });
  });

  it('saves under backup.auto, keeps changedAt when nothing changes and clears the dismissal when turned on', async () => {
    expect(BACKUP_AUTO_KEY).toBe('backup.auto');
    const off = await saveAutoBackup({ enabled: false }, { now: day(1) });
    expect(off).toEqual({ enabled: false, changedAt: day(1).toISOString(), reminderDismissedAt: null });
    expect(await getState(BACKUP_AUTO_KEY)).toEqual(off);
    await dismissAutoOffReminder({ now: day(2) });
    const again = await saveAutoBackup({ enabled: false }, { now: day(3) });
    expect(again.changedAt).toBe(day(1).toISOString());
    expect(again.reminderDismissedAt).toBe(day(2).toISOString());
    const on = await saveAutoBackup({ enabled: true }, { now: day(4) });
    expect(on).toEqual({ enabled: true, changedAt: day(4).toISOString(), reminderDismissedAt: null });
  });

  it('any on to off change clears an old dismissal; off to off keeps it', async () => {
    await setState(BACKUP_AUTO_KEY, { enabled: true, changedAt: day(1).toISOString(), reminderDismissedAt: day(2).toISOString() });
    const off = await saveAutoBackup({ enabled: false }, { now: day(3) });
    expect(off.reminderDismissedAt).toBeNull();
    await dismissAutoOffReminder({ now: day(4) });
    expect((await saveAutoBackup({ enabled: false }, { now: day(5) })).reminderDismissedAt).toBe(day(4).toISOString());
  });

  it('dismissing while on is a no-op that returns the current state', async () => {
    await setState(BACKUP_AUTO_KEY, { enabled: true, changedAt: day(1).toISOString(), reminderDismissedAt: null });
    const before = await getState(BACKUP_AUTO_KEY);
    const result = await dismissAutoOffReminder({ now: day(2) });
    expect(result).toEqual(before);
    expect(await getState(BACKUP_AUTO_KEY)).toEqual(before);
    // Nothing saved at all (default on) stays unsaved.
    getDb().prepare('DELETE FROM app_state WHERE key = ?').run(BACKUP_AUTO_KEY);
    expect((await dismissAutoOffReminder({ now: day(2) })).enabled).toBe(true);
    expect(await getState(BACKUP_AUTO_KEY, null)).toBeNull();
  });

  it('is a protected key that a restore carries', () => {
    expect(RESTORE_CARRY_KEYS).toContain(BACKUP_AUTO_KEY);
  });
});

describe('shouldShowAutoOffReminder', () => {
  const now = day(20);
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const off = { enabled: false, reminderDismissedAt: null };

  it('never shows while automatic backups are on', () => {
    expect(shouldShowAutoOffReminder({ auto: { enabled: true }, newestGoodAt: null, now })).toBe(false);
    expect(shouldShowAutoOffReminder({ auto: undefined, newestGoodAt: null, now })).toBe(false);
  });

  it('shows when off and there is no backup, or the newest is 7 or more days old', () => {
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, now })).toBe(true);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: 'not a date', now })).toBe(true);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: ago(7 * DAY), now })).toBe(true);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: ago(30 * DAY), now })).toBe(true);
  });

  it('stays quiet when the newest backup is under 7 days old', () => {
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: ago(7 * DAY - 1), now })).toBe(false);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: ago(0), now })).toBe(false);
  });

  it('stays quiet for 7 days after a dismissal, then asks again', () => {
    expect(REMINDER_INTERVAL_MS).toBe(7 * DAY);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, dismissedAt: ago(1), now })).toBe(false);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, dismissedAt: ago(7 * DAY - 1), now })).toBe(false);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, dismissedAt: ago(7 * DAY), now })).toBe(true);
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, dismissedAt: 'junk', now })).toBe(true);
  });

  it('a newest backup dated in the future (clock moved back) does not hide the reminder', () => {
    const future = new Date(now.getTime() + DAY).toISOString();
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: future, now })).toBe(true);
  });

  it('ignores a dismissal dated in the future and reads auto.reminderDismissedAt by default', () => {
    const future = new Date(now.getTime() + DAY).toISOString();
    expect(shouldShowAutoOffReminder({ auto: off, newestGoodAt: null, dismissedAt: future, now })).toBe(true);
    const dismissed = { enabled: false, reminderDismissedAt: ago(DAY) };
    expect(shouldShowAutoOffReminder({ auto: dismissed, newestGoodAt: null, now })).toBe(false);
  });
});

describe('status', () => {
  it('exposes the switch, the effective flag and the reminder', async () => {
    const on = await getBackupStatus({ now: day(20) });
    expect(on).toMatchObject({ autoSwitch: true, autoEnabled: true, autoOffReminder: false, autoChangedAt: null });
    await saveAutoBackup({ enabled: false }, { now: day(1) });
    const off = await getBackupStatus({ now: day(20) });
    expect(off).toMatchObject({
      autoSwitch: false,
      autoEnabled: false,
      autoOffReminder: true,
      autoChangedAt: day(1).toISOString(),
    });
    await dismissAutoOffReminder({ now: day(19) });
    expect((await getBackupStatus({ now: day(20) })).autoOffReminder).toBe(false);
    expect((await getBackupStatus({ now: day(27) })).autoOffReminder).toBe(true);
  });

  it('reports the switch as unknown, with no reminder, while a restore holds the database', async () => {
    await saveAutoBackup({ enabled: false }, { now: day(1) });
    setDbMaintenance(true);
    try {
      const status = await getBackupStatus({ now: day(20) });
      expect(status).toMatchObject({ autoSwitch: null, autoChangedAt: null, autoOffReminder: false });
    } finally {
      setDbMaintenance(false);
    }
  });

  it('BURROW_SCHEDULER=0 still reports the user switch on while the effective flag is off', async () => {
    vi.stubEnv('BURROW_SCHEDULER', '0');
    try {
      expect(await getBackupStatus()).toMatchObject({ autoSwitch: true, autoEnabled: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('isBackupDue clock skew', () => {
  const now = day(10);
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  const metas = [];

  it('a success more than the skew allowance in the future counts as missing (due)', () => {
    expect(isBackupDue({ state: { lastSuccessAt: at(FUTURE_SKEW_MS + 1000) }, metas, now })).toBe(true);
    expect(isBackupDue({ state: { lastSuccessAt: at(30 * DAY) }, metas, now })).toBe(true);
  });

  it('a success a few minutes ahead (small skew) still counts as fresh', () => {
    expect(isBackupDue({ state: { lastSuccessAt: at(FUTURE_SKEW_MS - 1000) }, metas, now })).toBe(false);
    expect(isBackupDue({ state: { lastSuccessAt: at(0) }, metas, now })).toBe(false);
  });

  it('a failure dated in the future does not hold backups off; a recent real one does', () => {
    expect(isBackupDue({ state: { lastFailureAt: at(DAY) }, metas, now })).toBe(true);
    expect(isBackupDue({ state: { lastFailureAt: at(-1000) }, metas, now })).toBe(false);
    expect(isBackupDue({ state: { lastFailureAt: at(-RETRY_AFTER_FAILURE_MS - 1) }, metas, now })).toBe(true);
  });
});

describe('scheduler with the switch off', () => {
  const HOUR = 3_600_000;
  const STARTUP = 1_000;
  const TICK = 10_000;
  let clock;
  const now = () => clock;

  beforeEach(() => {
    clock = day(10);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const start = (run) => startBackupScheduler({ now, run, startupDelayMs: STARTUP, tickMs: TICK });

  it('skips the backup while off, and makes the due one on the next tick after it is turned back on', async () => {
    await saveAutoBackup({ enabled: false });
    const run = vi.fn(async () => ({ ok: true }));
    start(run);
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TICK);
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(isBackupSchedulerRunning()).toBe(true);

    await saveAutoBackup({ enabled: true });
    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('pokeBackupScheduler brings the next check forward', async () => {
    await saveAutoBackup({ enabled: false });
    const run = vi.fn(async () => ({ ok: true }));
    startBackupScheduler({ now, run, startupDelayMs: STARTUP, tickMs: HOUR });
    await vi.advanceTimersByTimeAsync(STARTUP);
    await settle();
    expect(run).not.toHaveBeenCalled();
    await saveAutoBackup({ enabled: true });
    pokeBackupScheduler(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('pokeBackupScheduler does nothing when the scheduler is not running', () => {
    expect(() => pokeBackupScheduler()).not.toThrow();
    expect(isBackupSchedulerRunning()).toBe(false);
  });

  it('runScheduledBackup makes no backup while off and logs nothing', async () => {
    await saveAutoBackup({ enabled: false });
    ensureBackupsDir();
    expect(await runScheduledBackup({ now: day(10) })).toEqual({ ok: true, created: false, skipped: 'auto_off' });
    expect(await listMetas()).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
    await saveAutoBackup({ enabled: true });
    expect(await runScheduledBackup({ now: day(10) })).toEqual({ ok: true, created: true });
    expect(await listMetas()).toHaveLength(1);
  });

  it('a poke while a check is running is followed by one quick second check, not an interruption', async () => {
    let release;
    const run = vi.fn(() => new Promise((resolve) => (release = resolve)));
    startBackupScheduler({ now, run, startupDelayMs: STARTUP, tickMs: HOUR });
    await vi.advanceTimersByTimeAsync(STARTUP);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    pokeBackupScheduler(100);
    expect(run).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await settle();
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    release({ ok: true });
    await settle();
    // Without a poke the next check is a full tick away.
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stopping while a check is running does not re-arm the timer', async () => {
    let release;
    const run = vi.fn(() => new Promise((resolve) => (release = resolve)));
    startBackupScheduler({ now, run, startupDelayMs: STARTUP, tickMs: TICK });
    await vi.advanceTimersByTimeAsync(STARTUP);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    stopBackupScheduler();
    expect(isBackupSchedulerRunning()).toBe(false);
    release({ ok: true });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('other jobs still run while the switch is off: briefing and prune are called, the backup is not', async () => {
    await saveAutoBackup({ enabled: false });
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
    const briefing = vi.fn(async () => ({}));
    const prune = vi.fn(async () => ({ ok: true }));
    const run = vi.fn(async () => ({ ok: true }));
    expect(startScheduler({ briefing, prune, aiConfigured: () => true, pruneDelayMs: 1000 })).toBe(true);
    expect(startBackupScheduler({ run, startupDelayMs: 1000, tickMs: HOUR })).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19 * HOUR);
    await settle();
    expect(briefing).toHaveBeenCalledWith({ trigger: 'scheduled', signal: expect.any(AbortSignal) });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', restoreGateMiddleware);
    registerBackupRoutes(app);
  });
  const send = (method, url, body) => request(app)[method](url).set('Content-Type', 'application/json').send(body);
  const expectError = (res, status, code) => {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code, code, message: expect.any(String) });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  };

  it('PUT /api/backups/auto saves the switch and GET /api/backups/status shows it', async () => {
    const res = await send('put', '/api/backups/auto', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.data).toMatchObject({ enabled: false, reminderDismissedAt: null });
    expect(Date.parse(res.body.data.changedAt)).not.toBeNaN();
    const status = await request(app).get('/api/backups/status');
    expect(status.body.data).toMatchObject({ autoSwitch: false, autoEnabled: false });
    const list = await request(app).get('/api/backups');
    expect(list.body.data.status.autoSwitch).toBe(false);
    const on = await send('put', '/api/backups/auto', { enabled: true });
    expect(on.body.data.enabled).toBe(true);
    expect((await request(app).get('/api/backups/status')).body.data.autoSwitch).toBe(true);
  });

  it('rejects an invalid body with 400 invalid_settings and a non-JSON body with 415', async () => {
    for (const body of [{}, { enabled: 'false' }, { enabled: false, x: 1 }, [true]]) {
      expectError(await send('put', '/api/backups/auto', body), 400, 'invalid_settings');
    }
    expectError(
      await request(app).put('/api/backups/auto').set('Content-Type', 'text/plain').send('enabled=false'),
      415,
      'unsupported_media_type',
    );
    expectError(
      await request(app).post('/api/backups/auto/dismiss-reminder').set('Content-Type', 'text/plain').send('x'),
      415,
      'unsupported_media_type',
    );
    expect((await getAutoBackup()).enabled).toBe(true);
  });

  it('POST /api/backups/auto/dismiss-reminder stores the dismissal on the server', async () => {
    await send('put', '/api/backups/auto', { enabled: false });
    expect((await request(app).get('/api/backups/status')).body.data.autoOffReminder).toBe(true);
    const res = await send('post', '/api/backups/auto/dismiss-reminder', {});
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(Date.parse(res.body.data.reminderDismissedAt)).not.toBeNaN();
    expect((await getAutoBackup()).reminderDismissedAt).toBe(res.body.data.reminderDismissedAt);
    expect((await request(app).get('/api/backups/status')).body.data.autoOffReminder).toBe(false);
  });

  it('only an off to on change pokes the scheduler (a repeat "on" does not)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = vi.fn(async () => ({ ok: true }));
    startBackupScheduler({ run, startupDelayMs: 1_000, tickMs: 3_600_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    await send('put', '/api/backups/auto', { enabled: true });
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS + 1_000);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await send('put', '/api/backups/auto', { enabled: false });
    await send('put', '/api/backups/auto', { enabled: true });
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS + 1_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('Back up now still works while the switch is off', async () => {
    await send('put', '/api/backups/auto', { enabled: false });
    const res = await send('post', '/api/backups', {});
    expect(res.status).toBe(201);
    expect(res.body.data.backup).toMatchObject({ kind: 'manual', status: 'verified' });
  });

  it('turning the switch on brings a running scheduler check forward', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await saveAutoBackup({ enabled: false });
    const run = vi.fn(async () => ({ ok: true }));
    startBackupScheduler({ run, startupDelayMs: 1_000, tickMs: 3_600_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(run).not.toHaveBeenCalled();
    await send('put', '/api/backups/auto', { enabled: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });
});

describe('carried across a restore and an import', () => {
  /** Bytes of a copy of a backup's database after `edit`, usable as an upload body. */
  function editedCopy(id, edit) {
    const copy = path.join(dataDir(), `edited-${id}.db`);
    fs.copyFileSync(backupFile(id, '.db'), copy);
    const db = new DatabaseSync(copy);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      edit(db);
    } finally {
      db.close();
    }
    const bytes = fs.readFileSync(copy);
    fs.rmSync(copy, { force: true });
    return bytes;
  }
  const put = (db, value) =>
    db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(BACKUP_AUTO_KEY, JSON.stringify(value));

  it('restoring a backup made while on keeps the switch off', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => put(db, { enabled: true, changedAt: null, reminderDismissedAt: null }));
    await saveAutoBackup({ enabled: false }, { now: day(2) });
    const live = await getState(BACKUP_AUTO_KEY);
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });
    expect(await getState(BACKUP_AUTO_KEY)).toEqual(live);
    expect((await getAutoBackup()).enabled).toBe(false);
  });

  it('restoring a backup made while off keeps the switch on', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => put(db, { enabled: false, changedAt: null, reminderDismissedAt: null }));
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });
    expect(select('app_state', { where: { key: BACKUP_AUTO_KEY } })).toHaveLength(0);
    expect((await getAutoBackup()).enabled).toBe(true);
  });

  it('importing an export never changes the switch', async () => {
    await saveAutoBackup({ enabled: false }, { now: day(2) });
    const before = await getState(BACKUP_AUTO_KEY);
    const zip = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, exportedAt: '2026-05-01T00:00:00.000Z', tables: [{ id: 'app_state' }] }),
      ),
      'json/app_state.json': strToU8(JSON.stringify([{ key: BACKUP_AUTO_KEY, value: { enabled: true } }])),
    });
    const result = importZipBuffer(zip, { db: getDb() });
    expect(result.tables.find((t) => t.id === 'app_state').skippedReasons.protected).toBe(1);
    expect(await getState(BACKUP_AUTO_KEY)).toEqual(before);
  });
});
