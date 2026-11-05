// The Burrow Dev NSIS hooks (M2). The installer itself is only compiled by `npm run desktop:build:dev`; these
// checks pin the guard so a later edit cannot quietly drop one of the protected folders or the normalization.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const nsh = fs.readFileSync(path.join(ROOT, 'src-tauri', 'installer', 'hooks.dev.nsh'), 'utf8');
const preinstall = nsh.slice(nsh.indexOf('!macro NSIS_HOOK_PREINSTALL'), nsh.indexOf('!macroend', nsh.indexOf('!macro NSIS_HOOK_PREINSTALL')));

describe('hooks.dev.nsh refuses folders that belong to Burrow', () => {
  it('normalizes $INSTDIR before comparing (full path, no trailing backslash)', () => {
    expect(nsh).toMatch(/GetFullPathName \$BdTmp \$BdOut/);
    expect(nsh).toMatch(/StrCmp \$BdTmp "\\" 0 burrow_dev_norm_done/);
    expect(preinstall).toMatch(/StrCpy \$BdIn "\$INSTDIR"\s+Call BurrowDevNormalize/);
  });

  it('checks equal, inside and containing', () => {
    expect(nsh).toMatch(/StrCmp \$BdInst \$BdOut burrow_dev_check_hit/);
    expect(nsh).toMatch(/StrCpy \$BdPre "\$BdOut\\"/);
    expect(nsh).toMatch(/StrCpy \$BdPre "\$BdInst\\"/);
  });

  it('protects the Burrow data and install folders, the Dev data folder and the recorded install location', () => {
    for (const folder of ['$APPDATA\\Burrow Dev', '$APPDATA\\Burrow', '$LOCALAPPDATA\\Burrow']) {
      expect(preinstall).toContain(`StrCpy $BdIn "${folder}"`);
    }
    expect(preinstall).toContain('ReadRegStr $BdIn HKCU "Software\\Burrow\\Burrow" ""');
    expect(preinstall).toContain('ReadRegStr $BdIn HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Burrow" "InstallLocation"');
    expect(preinstall.match(/StrCmp \$BdHit "1" burrow_dev_refuse/g)).toHaveLength(5);
  });

  it('strips the quotes of a registry InstallLocation', () => {
    expect(nsh).toMatch(/StrCmp \$BdTmp "\$\\"" 0 burrow_dev_norm_unquoted/);
  });

  it('aborts with a plain message and no em dash', () => {
    expect(preinstall).toMatch(/MessageBox MB_OK\|MB_ICONSTOP "Burrow Dev cannot be installed into \$INSTDIR/);
    expect(preinstall).toMatch(/Abort/);
    expect(nsh).not.toMatch(/—/);
  });

  it('keeps every label unique within the file', () => {
    const labels = [...nsh.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*$/gm)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
