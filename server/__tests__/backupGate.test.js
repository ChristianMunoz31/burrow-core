// The restore request gate in the real server.js app: while a restore swaps the database file, every
// /api route answers 503 db_restoring except GET /api/backups/status; getDb() refuses to open; and
// a restore waits for requests that are already running.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { DbError, getDb, insert, select } from '../db/index.js';
import {
  __resetLockForTests,
  closeGate,
  inFlightCount,
  isGateClosed,
  openGate,
  restoreGateMiddleware,
  waitForDrain,
} from '../backup/lock.js';
import { restoreBackup } from '../backup/restore.js';
import { createBackup } from '../backup/service.js';
import { cleanupBackupEnv, dataDir, day, noSleep, resetBackupEnv } from './helpers/backupEnv.js';

let app;
beforeAll(async () => {
  app = (await import('../../server.js')).default;
});
beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

const MESSAGE = 'Burrow is restoring a backup. This takes a few seconds.';
const backUp = async () => (await createBackup({ kind: 'manual', now: day(1) })).meta;

/** Runs `probe` while a real restore sits between "journal written" and "old file moved aside". */
async function duringRestore(probe) {
  insert('notes', { body: 'saved' });
  const backup = await backUp();
  insert('notes', { body: 'live' });
  let result;
  await restoreBackup({
    id: backup.id,
    now: day(2),
    hooks: {
      sleep: noSleep,
      afterStep: async (name) => {
        if (name === 'journal_written') result = await probe();
      },
    },
  });
  return result;
}

describe('requests during a restore (through server.js)', () => {
  it('every /api route except GET /api/backups/status answers 503 db_restoring with Retry-After', async () => {
    const seen = await duringRestore(async () => {
      const calls = [
        ['get', '/api/todos'],
        ['post', '/api/todos'],
        ['put', '/api/todos/abc'],
        ['delete', '/api/todos/abc'],
        ['get', '/api/notes'],
        ['get', '/api/backups'],
        ['post', '/api/backups'],
        ['post', '/api/backups/restore'],
        ['post', '/api/backups/upload'],
        ['put', '/api/backups/settings'],
        ['post', '/api/backups/status'],
        ['get', '/api/export'],
        ['get', '/api/does-not-exist'],
      ];
      const out = [];
      for (const [method, url] of calls) {
        const res = await request(app)[method](url).set('Content-Type', 'application/json').send({});
        out.push({ method, url, status: res.status, body: res.body, retry: res.headers['retry-after'], cache: res.headers['cache-control'] });
      }
      return out;
    });
    for (const r of seen) {
      expect(r.status, `${r.method} ${r.url}`).toBe(503);
      expect(r.body, `${r.method} ${r.url}`).toEqual({ error: 'db_restoring', code: 'db_restoring', message: MESSAGE });
      expect(r.retry).toBe('5');
      expect(r.cache).toMatch(/no-store/);
    }
  });

  it('GET /api/backups/status still answers, saying a restore is running (path variants too)', async () => {
    const seen = await duringRestore(async () => {
      const out = [];
      for (const url of ['/api/backups/status', '/api/backups/status/', '/api/Backups/Status', '/api/backups/status?x=1']) {
        const res = await request(app).get(url);
        out.push({ url, status: res.status, restoring: res.body?.data?.restoring });
      }
      return out;
    });
    for (const r of seen) {
      expect(r.status, r.url).toBe(200);
      expect(r.restoring, r.url).toBe(true);
    }
  });

  it('getDb throws db_restoring while the swap is on, and the data routes work again afterwards', async () => {
    const thrown = await duringRestore(async () => {
      try {
        getDb();
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(thrown).toBeInstanceOf(DbError);
    expect(thrown.code).toBe('db_restoring');
    expect(thrown.status).toBe(503);
    expect(isGateClosed()).toBe(false);
    expect(select('notes').map((n) => n.body)).toEqual(['saved']);
    const after = await request(app).get('/api/notes');
    expect(after.status).toBe(200);
    expect((await request(app).get('/api/backups/status')).body.data.restoring).toBe(false);
  });

  it('after a failed restore the gate is open again', async () => {
    insert('notes', { body: 'x' });
    await expect(restoreBackup({ id: '20260101T000000Z-manual-aaaaaa' })).rejects.toMatchObject({ code: 'backup_not_found' });
    expect(isGateClosed()).toBe(false);
    expect((await request(app).get('/api/notes')).status).toBe(200);
  });

  it('after a restore that rolled back the gate is open and the old data is served', async () => {
    insert('notes', { body: 'saved' });
    const backup = await backUp();
    insert('notes', { body: 'live' });
    const hooks = {
      sleep: noSleep,
      afterStep: (name) => {
        if (name === 'staging_swapped') throw Object.assign(new Error('boom'), { code: 'EIO' });
      },
    };
    await expect(restoreBackup({ id: backup.id, hooks })).rejects.toMatchObject({ code: 'restore_failed' });
    expect(isGateClosed()).toBe(false);
    const res = await request(app).get('/api/notes');
    expect(res.status).toBe(200);
    expect(res.body.map?.((n) => n.body).sort() ?? res.body.data?.map((n) => n.body).sort()).toEqual(['live', 'saved']);
  });
});

describe('restoreGateMiddleware and waitForDrain', () => {
  const fakeRes = () => {
    const res = new EventEmitter();
    res.headers = {};
    res.set = (k, v) => {
      res.headers[k] = v;
      return res;
    };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    return res;
  };
  const run = (method, path) => {
    const res = fakeRes();
    const next = vi.fn();
    restoreGateMiddleware({ method, path }, res, next);
    return { res, next };
  };

  it('open gate: counts a request until it finishes or closes, once', () => {
    const a = run('GET', '/todos');
    const b = run('POST', '/notes');
    expect(inFlightCount()).toBe(2);
    expect(a.next).toHaveBeenCalledOnce();
    a.res.emit('finish');
    a.res.emit('close');
    expect(inFlightCount()).toBe(1);
    b.res.emit('close');
    b.res.emit('finish');
    expect(inFlightCount()).toBe(0);
  });

  it('the restore request itself is not counted (it would wait for itself)', () => {
    for (const path of ['/backups/restore', '/Backups/Restore/']) {
      const { next } = run('POST', path);
      expect(next).toHaveBeenCalledOnce();
    }
    expect(inFlightCount()).toBe(0);
    // A GET on that path is a normal request and is counted.
    run('GET', '/backups/restore');
    expect(inFlightCount()).toBe(1);
  });

  it('closed gate: only GET /backups/status passes, everything else is 503', () => {
    closeGate();
    expect(run('GET', '/backups/status').next).toHaveBeenCalledOnce();
    expect(run('GET', '/backups/status/').next).toHaveBeenCalledOnce();
    for (const [method, path] of [
      ['POST', '/backups/status'],
      ['GET', '/backups'],
      ['GET', '/backups/status/extra'],
      ['POST', '/backups/restore'],
      ['GET', '/todos'],
    ]) {
      const { res, next } = run(method, path);
      expect(next, `${method} ${path}`).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('db_restoring');
      expect(res.headers['Retry-After']).toBe('5');
    }
    expect(inFlightCount()).toBe(0);
    openGate();
  });

  it('waitForDrain returns at once when nothing is running', async () => {
    const sleep = vi.fn(async () => {});
    expect(await waitForDrain({ sleep })).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waitForDrain polls until the request ends', async () => {
    const { res } = run('GET', '/todos');
    let polls = 0;
    const drained = await waitForDrain({
      pollMs: 25,
      sleep: async () => {
        polls += 1;
        if (polls === 3) res.emit('finish');
      },
    });
    expect(drained).toBe(true);
    expect(polls).toBe(3);
  });

  it('waitForDrain gives up after the timeout and reports false', async () => {
    run('GET', '/todos');
    let slept = 0;
    const drained = await waitForDrain({
      timeoutMs: 200,
      pollMs: 25,
      sleep: async (ms) => {
        slept += ms;
      },
    });
    expect(drained).toBe(false);
    expect(slept).toBe(200);
  });

  it('__resetLockForTests forgets counted requests and a closed gate', () => {
    run('GET', '/todos');
    closeGate();
    __resetLockForTests();
    expect(inFlightCount()).toBe(0);
    expect(isGateClosed()).toBe(false);
  });
});

describe('a restore waits for requests already running', () => {
  const fakeRes = () => {
    const res = new EventEmitter();
    res.set = () => res;
    return res;
  };

  it('closes the gate, waits for the running request to finish, then swaps', async () => {
    insert('notes', { body: 'saved' });
    const backup = await backUp();
    insert('notes', { body: 'live' });
    const res = fakeRes();
    restoreGateMiddleware({ method: 'GET', path: '/notes' }, res, () => {});
    expect(inFlightCount()).toBe(1);

    let polls = 0;
    const events = [];
    await restoreBackup({
      id: backup.id,
      now: day(2),
      hooks: {
        sleep: async () => {
          polls += 1;
          events.push(`wait:gate=${isGateClosed()}`);
          if (polls === 2) res.emit('finish');
        },
        afterStep: (name) => {
          events.push(`${name}:inFlight=${inFlightCount()}`);
        },
      },
    });
    expect(polls).toBe(2);
    expect(events).toEqual(['wait:gate=true', 'wait:gate=true', 'journal_written:inFlight=0', 'aside_moved:inFlight=0', 'staging_swapped:inFlight=0', 'journal_swapped:inFlight=0']);
    expect(select('notes').map((n) => n.body)).toEqual(['saved']);
  });

  it('a request that never finishes: the restore gives up after the drain timeout (409 backup_busy) and changes nothing', async () => {
    insert('notes', { body: 'saved' });
    const backup = await backUp();
    insert('notes', { body: 'live' });
    restoreGateMiddleware({ method: 'GET', path: '/notes' }, fakeRes(), () => {});
    let waited = 0;
    await expect(
      restoreBackup({
        id: backup.id,
        hooks: {
          sleep: async (ms) => {
            waited += ms;
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'backup_busy', status: 409 });
    expect(waited).toBe(10_000);
    expect(isGateClosed()).toBe(false);
    expect(select('notes').map((n) => n.body).sort()).toEqual(['live', 'saved']);
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-/.test(n))).toEqual([]);
  });
});
