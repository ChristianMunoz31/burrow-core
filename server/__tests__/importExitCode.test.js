// A refused import recovery at startup exits with its own code (4), so the desktop shell can show a dedicated dialog
// (src-tauri/src/exit_dialog.rs). The server entry point is not started under Vitest, so the wiring is checked in the source.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_IMPORT_RECOVERY } from '../backup/directImport.js';
import { EXIT_RESTORE_RECOVERY } from '../backup/restore.js';

const serverSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'server.js'), 'utf8');

describe('EXIT_IMPORT_RECOVERY', () => {
  it('is 4 and distinct from the other exit codes', () => {
    expect(EXIT_IMPORT_RECOVERY).toBe(4);
    expect(new Set([0, 1, 2, EXIT_RESTORE_RECOVERY, EXIT_IMPORT_RECOVERY]).size).toBe(5);
  });

  it('is what server.js exits with when the import recovery is refused, with a message naming both folders', () => {
    const branch = serverSource.slice(serverSource.indexOf("err?.code === 'import_recovery_failed'"), serverSource.indexOf("err?.code === 'desktop_handshake'"));
    expect(branch).toContain('process.exit(EXIT_IMPORT_RECOVERY)');
    expect(branch).not.toMatch(/process\.exit\(1\)/);
    expect(branch).toContain("path.join(dir, '.import-*')");
    expect(branch).toContain("path.join(dir, 'import-aside')");
    expect(branch).toContain('Nothing was deleted.');
  });
});
