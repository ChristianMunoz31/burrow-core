// Hard-kill safety: a process killed mid-write (SIGKILL / TerminateProcess) must leave a database
// that passes integrity_check and holds every transaction it reported as committed.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.js';
import { childEnv } from './helpers/childEnv.js';

const WRITER = fileURLToPath(new URL('./fixtures/crashWriter.js', import.meta.url));
const KILL_AFTER = 200;

/** Runs the writer until it reports KILL_AFTER commits, kills it, resolves the last reported count. */
function runAndKill(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER], {
      env: childEnv({ BURROW_DATA_DIR: dataDir, BURROW_NO_DOTENV: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let last = 0;
    let buf = '';
    let killed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('writer did not reach the kill threshold in time'));
    }, 8000);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^committed (\d+)$/.exec(line);
        if (m) last = Number(m[1]);
      }
      if (!killed && last >= KILL_AFTER) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(last);
    });
  });
}

describe('crash safety', () => {
  it('survives SIGKILL mid-write with no committed row lost', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-crash-'));
    try {
      const reported = await runAndKill(dir);
      expect(reported).toBeGreaterThanOrEqual(KILL_AFTER);

      const db = openDb({ filename: path.join(dir, 'burrow.db') });
      try {
        expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM crash_probe').get();
        expect(n).toBeGreaterThanOrEqual(reported);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 15000);
});
