// Atomic file writes shared by the clock, trial and activation records (docs/LICENSING.md section 5.3).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Writes `bytes` to `<dir>/<name>` via a private temp file in the same directory and a rename.
 * @param {string} dir
 * @param {string} name
 * @param {string | Uint8Array} bytes
 */
export function atomicWriteFile(dir, name, bytes) {
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
