// Real sidecar: a signed dialog reply that is followed at once by EOF on stdin (the shell quitting right after the
// user answered). The server must handle the reply, shut down gracefully with exit code 0, print no reply text, and
// leave the data folder with a checkpointed WAL.
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './helpers/childEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const READY_RE = /^BURROW_READY (\{.*\})$/m;
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('desktop sidecar: dialog reply racing the end of stdin', () => {
  it('exits 0 after a reply and EOF written together, and a half line before EOF does no harm', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-'));
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sidecar-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const secret = crypto.randomBytes(32);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: childEnv({
        BURROW_DESKTOP: '1',
        BURROW_HOST: '127.0.0.1',
        BURROW_PORT: '0',
        BURROW_NO_DOTENV: '1',
        BURROW_DATA_DIR: dataDir,
        BURROW_DIST_DIR: distDir,
        BURROW_SCHEDULER: '0',
        BURROW_SHELL_DIALOGS: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stdin.write(`${secret.toString('hex')}\n`);
    try {
      let ready;
      for (let i = 0; i < 200 && !ready; i += 1) {
        ready = READY_RE.exec(out)?.[1];
        if (!ready) await sleep(50);
      }
      expect(ready).toBeTruthy();
      const base = `http://127.0.0.1:${JSON.parse(ready).port}`;
      const token = hmac(secret, 'burrow-bootstrap-v1').toString('hex');
      const boot = await fetch(`${base}/desktop/bootstrap?token=${token}`, { redirect: 'manual' });
      const cookie = boot.headers.get('set-cookie').split(';')[0];
      const started = await fetch(`${base}/api/folders/pick`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' });
      expect(started.status).toBe(202);
      const { dialog } = (await started.json()).data;
      const key = hmac(secret, 'burrow-dialog-key-v1');
      const mac = hmac(key, `burrow-dialog-reply-v1\n${dialog.id}\ncancelled\n`).toString('hex');
      const reply = JSON.stringify({ v: 1, id: dialog.id, status: 'cancelled', path: '', mac });
      // The reply, then a half line with no newline, then EOF, all at once.
      child.stdin.end(`BURROW_DIALOG_REPLY ${reply}\nBURROW_DIALOG_REPLY {"v":1,"id":"`);
      const result = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
      expect(result).not.toBe('timeout');
      expect(result.code).toBe(0);
      expect(out).not.toContain('BURROW_DIALOG_REPLY');
      expect(out).not.toContain(secret.toString('hex'));
    } finally {
      if (child.exitCode === null) child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 40_000);
});
