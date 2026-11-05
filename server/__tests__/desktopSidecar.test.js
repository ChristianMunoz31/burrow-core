// End-to-end sidecar protocol: spawn `node server.js` in desktop mode, handshake over stdin, read
// BURROW_READY, bootstrap, call the API with the cookie, then close stdin and expect a clean exit.
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './helpers/childEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(ROOT, 'server.js');
const READY_RE = /^BURROW_READY (\{.*\})$/m;

function launch({ dataDir, distDir, stdinLine, extraEnv = {} }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv({
      BURROW_DESKTOP: '1',
      BURROW_HOST: '127.0.0.1',
      BURROW_PORT: '0',
      BURROW_NO_DOTENV: '1',
      BURROW_DATA_DIR: dataDir,
      BURROW_DIST_DIR: distDir,
      BURROW_SCHEDULER: '0',
      ...extraEnv,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (stdinLine !== undefined) child.stdin.write(stdinLine);
  const ready = async (timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const m = READY_RE.exec(out);
      if (m) return JSON.parse(m[1]);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no BURROW_READY line');
  };
  return { child, exited, ready, stdout: () => out, stderr: () => err };
}

describe('desktop sidecar protocol', () => {
  it('handshakes, serves behind the gate, and exits 0 with a checkpointed WAL when stdin closes', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = crypto.randomBytes(32);
    const proc = launch({ dataDir, distDir, stdinLine: `${secret.toString('hex')}\n` });
    try {
      const ready = await proc.ready();
      expect(ready.port).toBeGreaterThan(0);
      expect(ready.dataDir).toBe(path.resolve(dataDir));
      expect(ready.version).toMatch(/^\d+\.\d+\.\d+|unknown/);
      expect(proc.stdout()).not.toContain(secret.toString('hex'));

      const base = `http://127.0.0.1:${ready.port}`;
      const token = crypto.createHmac('sha256', secret).update('burrow-bootstrap-v1').digest('hex');
      expect((await fetch(`${base}/api/auth/status`)).status).toBe(401);

      const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
      expect(boot.status).toBe(302);
      const cookie = boot.headers.get('set-cookie').split(';')[0];
      expect(cookie).toMatch(/^burrow_desktop=/);

      const api = await fetch(`${base}/api/transactions`, { headers: { cookie } });
      expect(api.status).toBe(200);
      const page = await fetch(`${base}/`, { headers: { cookie } });
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");

      expect(fs.existsSync(path.join(dataDir, 'burrow.db-wal'))).toBe(true);
      proc.child.stdin.end();
      const result = await Promise.race([
        proc.exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit after stdin close')), 8000)),
      ]);
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(dataDir, 'burrow.db-wal'))).toBe(false);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('stdin closing during a backup still exits 0 with a checkpointed WAL (the worker is drained first)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = crypto.randomBytes(32);
    const proc = launch({ dataDir, distDir, stdinLine: `${secret.toString('hex')}\n` });
    try {
      const ready = await proc.ready();
      const base = `http://127.0.0.1:${ready.port}`;
      const token = crypto.createHmac('sha256', secret).update('burrow-bootstrap-v1').digest('hex');
      const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
      const cookie = boot.headers.get('set-cookie').split(';')[0];

      // Start a backup and close stdin while it runs (or just before it ends: either way the exit is clean).
      const inflight = fetch(`${base}/api/backups`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 30));
      proc.child.stdin.end();
      const result = await Promise.race([
        proc.exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit after stdin close')), 10000)),
      ]);
      await inflight;
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(dataDir, 'burrow.db-wal'))).toBe(false);
      expect(proc.stderr()).not.toContain('Backup worker unavailable');
    } finally {
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('opens a folder dialog request line the shell can verify, and settles it from a reply on stdin', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = crypto.randomBytes(32);
    const proc = launch({ dataDir, distDir, stdinLine: `${secret.toString('hex')}\n`, extraEnv: { BURROW_SHELL_DIALOGS: '1' } });
    const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest();
    try {
      const ready = await proc.ready();
      const base = `http://127.0.0.1:${ready.port}`;
      const token = crypto.createHmac('sha256', secret).update('burrow-bootstrap-v1').digest('hex');
      const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
      const cookie = boot.headers.get('set-cookie').split(';')[0];
      const json = { cookie, origin: base, 'content-type': 'application/json' };

      const list = await (await fetch(`${base}/api/folders`, { headers: { cookie } })).json();
      expect(list.data).toMatchObject({ canPickFolder: true, canSaveFile: true });
      // The pasted path is refused where the dialogs exist.
      const pasted = await fetch(`${base}/api/folders`, { method: 'POST', headers: json, body: JSON.stringify({ path: dataDir }) });
      expect(pasted.status).toBe(409);
      expect((await pasted.json()).code).toBe('folder_pick_required');

      const started = await fetch(`${base}/api/folders/pick`, { method: 'POST', headers: json, body: '{}' });
      expect(started.status).toBe(202);
      const { dialog } = (await started.json()).data;
      expect(dialog).toMatchObject({ kind: 'pick_folder', status: 'waiting', folder: null, job: null });

      // The request line: exact format, and a MAC the shell can verify with the key it derives from the secret.
      let line;
      for (let i = 0; i < 100 && !line; i += 1) {
        line = /^BURROW_DIALOG_REQUEST (\{.*\})$/m.exec(proc.stdout())?.[1];
        if (!line) await new Promise((r) => setTimeout(r, 50));
      }
      expect(line).toBeTruthy();
      const request = JSON.parse(line);
      expect(Object.keys(request)).toEqual(['v', 'kind', 'id', 'ttl', 'name', 'ext', 'bytes', 'mac']);
      expect(request).toMatchObject({ v: 1, kind: 'pick_folder', id: dialog.id, ttl: 900, name: '', ext: '', bytes: 0 });
      const key = hmac(secret, 'burrow-dialog-key-v1');
      const expected = hmac(key, `burrow-dialog-request-v1\npick_folder\n${dialog.id}\n900\n\n\n0`).toString('hex');
      expect(request.mac).toBe(expected);
      expect(proc.stdout()).not.toContain(secret.toString('hex'));

      // A reply with a bad MAC changes nothing; the real one settles the request.
      const status = async () => (await (await fetch(`${base}/api/folders/dialogs/${dialog.id}`, { headers: { cookie } })).json()).data.dialog.status;
      const replyMac = hmac(key, `burrow-dialog-reply-v1\n${dialog.id}\ncancelled\n`).toString('hex');
      const forged = JSON.stringify({ v: 1, id: dialog.id, status: 'cancelled', path: '', mac: 'a'.repeat(64) });
      proc.child.stdin.write(`BURROW_DIALOG_REPLY ${forged}\n`);
      await new Promise((r) => setTimeout(r, 200));
      expect(await status()).toBe('waiting');
      const genuine = JSON.stringify({ v: 1, id: dialog.id, status: 'cancelled', path: '', mac: replyMac });
      proc.child.stdin.write(`BURROW_DIALOG_REPLY ${genuine}\n`);
      let last = 'waiting';
      for (let i = 0; i < 100 && last === 'waiting'; i += 1) {
        last = await status();
        if (last === 'waiting') await new Promise((r) => setTimeout(r, 50));
      }
      expect(last).toBe('cancelled');
      expect(proc.stdout()).not.toContain('BURROW_DIALOG_REPLY');

      proc.child.stdin.end();
      const result = await Promise.race([proc.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit after stdin close')), 8000))]);
      expect(result.code).toBe(0);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 40000);

  it('offers no dialogs without BURROW_SHELL_DIALOGS=1, and the file fetch needs the proof', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = crypto.randomBytes(32);
    const proc = launch({ dataDir, distDir, stdinLine: `${secret.toString('hex')}\n` });
    try {
      const ready = await proc.ready();
      const base = `http://127.0.0.1:${ready.port}`;
      const token = crypto.createHmac('sha256', secret).update('burrow-bootstrap-v1').digest('hex');
      const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
      const cookie = boot.headers.get('set-cookie').split(';')[0];
      const list = await (await fetch(`${base}/api/folders`, { headers: { cookie } })).json();
      expect(list.data).toMatchObject({ canPickFolder: false, canSaveFile: false });
      const started = await fetch(`${base}/api/folders/pick`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' });
      expect(started.status).toBe(409);
      expect((await started.json()).code).toBe('dialog_unavailable');
      // The fetch route is outside the cookie gate but gives nothing away without a valid request and proof.
      const open = await fetch(`${base}/desktop/dialog-file/${'a'.repeat(32)}`);
      expect(open.status).toBe(404);
      expect(await open.json()).toEqual({ error: 'not_found' });
      expect(proc.stdout()).not.toContain('BURROW_DIALOG_REQUEST');
    } finally {
      proc.child.stdin.end();
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('exits 2 with a generic message on a malformed secret line', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const bad = 'A'.repeat(64);
    const proc = launch({ dataDir, distDir: dataDir, stdinLine: `${bad}\n` });
    try {
      const result = await Promise.race([
        proc.exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit')), 10000)),
      ]);
      expect(result.code).toBe(2);
      expect(proc.stdout()).not.toMatch(/BURROW_READY/);
      expect(proc.stderr()).not.toContain(bad);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 20000);

  it('refuses a non-loopback host before reading stdin', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: childEnv({
        BURROW_DESKTOP: '1',
        BURROW_HOST: '0.0.0.0',
        BURROW_PORT: '0',
        BURROW_NO_DOTENV: '1',
        BURROW_DATA_DIR: dataDir,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const code = await new Promise((resolve) => child.once('exit', resolve));
      expect(code).toBe(1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 15000);
});

describe('stdin error between the handshake and the shutdown listeners', () => {
  it('is not an uncaught exception and leads to a graceful exit', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-stdin-window-'));
    const saved = { desktop: process.env.BURROW_DESKTOP, test: process.env.BURROW_TEST_DATA_DIR, sched: process.env.BURROW_SCHEDULER };
    const sigint = process.listeners('SIGINT');
    const sigterm = process.listeners('SIGTERM');
    process.env.BURROW_DESKTOP = '1';
    process.env.BURROW_SCHEDULER = '0';
    process.env.BURROW_TEST_DATA_DIR = dataDir;
    const exited = new Promise((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        resolve(code);
        return undefined;
      });
    });
    try {
      vi.resetModules();
      const { startServer } = await import('../../server.js');
      const stdin = new PassThrough();
      const starting = startServer({ port: 0, host: '127.0.0.1', handleSignals: true, stdin });
      stdin.write(`${crypto.randomBytes(32).toString('hex')}
`);
      // Fires in the window after the secret was read and before the real listeners attach.
      setImmediate(() => stdin.emit('error', new Error('pipe broke')));
      const { stop } = await starting;
      expect(await exited).toBe(0);
      await stop();
    } finally {
      vi.restoreAllMocks();
      for (const [name, list] of [['SIGINT', sigint], ['SIGTERM', sigterm]]) {
        for (const l of process.listeners(name)) if (!list.includes(l)) process.off(name, l);
      }
      for (const [k, v] of [['BURROW_DESKTOP', saved.desktop], ['BURROW_TEST_DATA_DIR', saved.test], ['BURROW_SCHEDULER', saved.sched]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 20000);
});
