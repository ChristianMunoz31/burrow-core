import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPrivateFile } from './helpers/privateFiles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'scripts', 'store', 'sideload-test.ps1');
const src = readFileSync(file, 'utf8');
// Code without comment-based help and # comments, so the checks look at what actually runs.
const code = src
  .replace(/<#[\s\S]*?#>/g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|\s)#.*$/, ''))
  .join('\n');

describe('scripts/store/sideload-test.ps1', () => {
  it('exists, is CRLF and ASCII only', () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('\r\n');
    expect(src.replace(/\r\n/g, '')).not.toMatch(/[^\x20-\x7e\t]/);
  });

  it('is a dry run unless -Run is given', () => {
    expect(src).toMatch(/\[switch\]\$Run\b/);
    expect(code).toMatch(/\$script:Apply\s*=\s*\[bool\]\$Run/);
    // Every mutating command is present and only reachable behind the Apply switch.
    expect(code).toMatch(/if \(\$script:Apply\) \{\s*\r?\n\s*\$before = Get-Snapshot/);
    expect(code).toMatch(/if \(\$script:Apply\) \{\s*\r?\n\s*if \(Test-Path -LiteralPath \(Join-Path \$CertStore/);
    expect(code).toMatch(/if \(\$script:Apply\) \{\s*\r?\n\s*try \{ Add-AppxPackage/);
    expect(code).toMatch(/if \(\$script:Apply\) \{\s*\r?\n\s*Start-Process/);
    expect(code).toMatch(/if \(\$script:Apply\) \{ Invoke-Teardown \}/);
    expect(code).toMatch(/if \(\$script:Apply\) \{ Invoke-CertCleanup \}/);
    expect(code).toMatch(/if \(\$script:Apply\) \{\s*Write-Report/);
    expect(code).toContain('[dry-run] would: ');
  });

  it('requires admin for -Run and trusts the cert in LocalMachine\\TrustedPeople only', () => {
    expect(code).toContain('Cert:\\LocalMachine\\TrustedPeople');
    expect(code).not.toMatch(/Cert:\\CurrentUser\\TrustedPeople/);
    expect(code).toMatch(/Test-Admin/);
    expect(src).toContain('0x800B0109');
    expect(code).toMatch(/Cert:\\CurrentUser\\My/); // only for -RemoveSigningCert
    expect(code).toMatch(/\$RemoveSigningCert -and/);
  });

  it('cleans up in a finally block and exits 0 or 1', () => {
    expect(code).toMatch(/\bfinally\s*\{/);
    expect(code).toMatch(/exit 0/);
    expect(code).toMatch(/exit 1/);
  });

  // config/msstore.json is private-only (left out of the public core export).
  it.skipIf(!hasPrivateFile('config/msstore.json'))('uses the owner identity from config/msstore.json', () => {
    const cfg = JSON.parse(readFileSync(path.join(root, 'config', 'msstore.json'), 'utf8'));
    expect(src).toContain('config\\msstore.json');
    expect(src).toContain(cfg.identityName);
    expect(src).toContain(cfg.reserved.packageFamilyName);
  });

  it('only reaches the real data folders through $env:APPDATA', () => {
    expect(code).toContain("Join-Path $env:APPDATA 'Burrow'");
    expect(code).toContain("Join-Path $env:APPDATA 'Burrow Dev'");
    expect(src).not.toMatch(/[A-Za-z]:\\Users\\/i);
    expect(src).not.toMatch(/\\AppData\\(Roaming|Local)/i);
    expect(code).not.toMatch(/Remove-Item[^\n]*\$(DataFolder|DevFolder)/);
    expect(code).not.toMatch(/Move-Item/);
  });
});

describe('scripts/store/sideload-test.ps1 data locations', () => {
  it('takes -DataLocation appdata|userprofile and reads the default from the bundle manifest', () => {
    expect(src).toMatch(/\[ValidateSet\('appdata', 'userprofile'\)\]\[string\]\$DataLocation/);
    expect(code).toContain("$caps -contains 'unvirtualizedResources'");
    expect(code).toMatch(/\$location = 'userprofile'\s*\r?\n\s*if \(\$hasUnvirtualized\) \{ \$location = 'appdata' \}/);
    expect(code).toContain('FileSystemWriteVirtualization');
    expect(code).toMatch(/elseif \(\$bundleLocation\) \{ \$script:Location = \$bundleLocation/);
  });

  it('refuses a mismatch between the parameter and the bundle in the preflight', () => {
    expect(code).toMatch(/if \(\$DataLocation -and \$DataLocation -ne \$manifestSays\) \{\s*\r?\n\s*Add-Check 'a' 'data location matches the bundle' 'FAIL'/);
    expect(code).toContain("Add-Check 'a' 'manifest is consistent' 'FAIL'");
  });

  it('finds the default bundle by name per mode, so the two kinds cannot be mixed up', () => {
    expect(code).toContain(String.raw`'*-localtest\Burrow_*.msixbundle'`);
    expect(code).toContain(String.raw`'*-localtest-userprofile\Burrow_*_userprofile.msixbundle'`);
  });

  it('userprofile mode backs up and verifies both folders and uses %USERPROFILE%\\Burrow Data as the data folder', () => {
    expect(code).toContain("$DataFolder = Join-Path $ProfileBase 'Burrow Data'");
    expect(code).toContain("$ProfileBase = $env:USERPROFILE");
    expect(code).not.toMatch(/Join-Path \$(env:USERPROFILE|ProfileBase) 'Burrow'/);
    expect(code).toContain("Invoke-VerifiedBackup $DataFolder (Join-Path $backupRoot 'Burrow') 'data folder'");
    expect(code).toContain("Invoke-VerifiedBackup $DirectFolder (Join-Path $backupRoot 'BurrowDirect') 'direct data'");
    // The safe-restore rules of the H1 fix are unchanged: rename aside, robocopy /E, never /MIR.
    expect(code).toContain('Rename-Item -LiteralPath "');
    expect(code).toMatch(/robocopy "' \+ \$script:Data\['BackupFolder'\] \+ '\\Burrow" "' \+ \$DataFolder \+ '" \/E/);
    expect(code).toContain('Do not use /MIR.');
    // When the direct data did not come out unchanged, the report also gives the restore steps for BurrowDirect.
    expect(code).toContain("$_.Name -like '*direct data*unchanged*'");
    expect(code).toMatch(/robocopy "' \+ \$script:Data\['BackupFolder'\] \+ '\\BurrowDirect" "' \+ \$DirectFolder \+ '" \/E/);
    expect(code).not.toMatch(/robocopy [^\n]*\/MIR/);
  });

  it('checks the new files land in the user folder, nothing in LocalCache, the direct data unchanged, and the data survives uninstall', () => {
    expect(code).toContain("'burrow.db and secrets.key landed in the user profile folder'");
    expect(code).toContain("'no Burrow data files under LocalCache'");
    expect(code).toContain(String.raw`'server log written next to the data (logs\server.log)'`);
    expect(code).toContain("Test-FolderUnchanged $script:Data['BeforeDirect'] $DirectFolder");
    expect(code).toContain("'direct data folder unchanged after uninstall'");
    expect(code).toContain("'real data folder still exists'");
    expect(code).toContain('burrow-data-location=');
  });

  it('applies the schema-upgrade gate only when the test app opens the real AppData database', () => {
    expect(code).toMatch(/if \(\$identity -and \$script:Location -eq 'userprofile'\) \{\s*\r?\n\s*Add-Check 'a' 'schema upgrade risk' 'PASS'/);
    expect(code).toMatch(/\} elseif \(\$identity\) \{/);
    expect(code).toContain("'schema upgrade risk' 'FAIL'");
  });

  it('never deletes or moves either data folder', () => {
    expect(code).not.toMatch(/Remove-Item[^\n]*\$(DataFolder|DirectFolder|DevFolder)/);
    expect(code).not.toMatch(/Move-Item/);
    expect(code).not.toMatch(/Copy-Item[^\n]*-Destination[^\n]*\$(DataFolder|DirectFolder)\b/);
  });
});

// The functions below run for real in Windows PowerShell 5.1 against temp folders (the script itself is never run with -Run).
const WIN = process.platform === 'win32';
const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Source text of one top-level function of the script (up to the line before the next top-level function or comment). */
function functionSource(name) {
  const text = src.replace(/\r\n/g, '\n');
  const start = text.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(function |# )/);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
}

function powershell(script) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 120000 });
  return `${out.stdout}${out.stderr}`;
}

describe('scripts/store/sideload-test.ps1 ownership marker and backup guard', () => {
  it('names the marker, refuses an unmarked folder in the preflight and never backs it up', () => {
    expect(code).toContain("$MarkerName = '.burrow-data.json'");
    expect(code).toContain("Add-Check 'a' 'data folder is safe to use' 'FAIL'");
    expect(code).toContain('It will not be backed up, started against or touched.');
    // The check runs in the preflight, before the throw that stops the run and long before any backup.
    expect(code.indexOf("'data folder is safe to use' 'FAIL'")).toBeLessThan(code.indexOf("throw 'Preflight failed; nothing was changed.'"));
    expect(code.indexOf("throw 'Preflight failed; nothing was changed.'")).toBeLessThan(code.indexOf('Invoke-VerifiedBackup $DataFolder'));
    // Every backup goes through the sanity guard first.
    expect(functionSource('Invoke-VerifiedBackup')).toContain('Assert-BackupSane $Source $Label');
    expect(code).toContain('[switch]$Force');
    expect(code).toContain('$BackupMaxFiles = 5000');
    expect(code).toContain('$BackupMaxBytes = 1GB');
  });

  it('treats burrow.db-wal and burrow.db-shm as transient (INFO) and anything else missing as a FAIL', () => {
    expect(code).toContain("$_ -eq 'burrow.db-wal' -or $_ -eq 'burrow.db-shm'");
    expect(code).toContain("Add-Check 'g' 'transient SQLite files gone after a clean close' 'INFO'");
    expect(code).toContain("$missingOther = @($missingAll | Where-Object { $_ -ne 'burrow.db-wal' -and $_ -ne 'burrow.db-shm' })");
    expect(code).toContain("Add-Check 'g' 'every file from BEFORE still present' 'FAIL' ($missingOther -join ', ')");
  });

  it.runIf(WIN)('Test-DataFolderOwnership: missing, empty and marked are usable; everything else is refused', (ctx) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sl-own-'));
    try {
      const marker = JSON.stringify({ app: 'Burrow', edition: 'store', dataLocation: 'userprofile', createdAt: '2026-10-08T00:00:00.000Z', formatVersion: 1 });
      const make = (name, fill) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        fill(dir);
        return dir;
      };
      const dirs = {
        missing: path.join(root, 'nothing-here'),
        missingUnderMissingParent: path.join(root, 'no-parent', 'Burrow Data'),
        empty: make('empty', () => {}),
        marked: make('marked', (d) => fs.writeFileSync(path.join(d, '.burrow-data.json'), marker)),
        // NTFS: the same file as .burrow-data.json, so the app accepts it and so does the script.
        wronglyCased: make('wronglyCased', (d) => fs.writeFileSync(path.join(d, '.Burrow-Data.json'), marker)),
        foreign: make('foreign', (d) => fs.writeFileSync(path.join(d, 'readme.txt'), 'x')),
        repo: make('repo', (d) => fs.mkdirSync(path.join(d, '.git'))),
        corrupt: make('corrupt', (d) => fs.writeFileSync(path.join(d, '.burrow-data.json'), '{nope')),
        wrongApp: make('wrongApp', (d) => fs.writeFileSync(path.join(d, '.burrow-data.json'), JSON.stringify({ app: 'Other' }))),
        desktopIni: make('desktopIni', (d) => {
          const ini = path.join(d, 'desktop.ini');
          fs.writeFileSync(ini, '[.ShellClassInfo]\r\n');
          expect(spawnSync('attrib', ['+s', '+h', ini]).status).toBe(0);
        }),
        file: path.join(root, 'afile'),
        junction: path.join(root, 'junction'),
        dangling: path.join(root, 'dangling'),
      };
      fs.writeFileSync(dirs.file, 'x');
      const dead = path.join(root, 'dead-target');
      fs.mkdirSync(dead);
      try {
        fs.symlinkSync(dirs.marked, dirs.junction, 'junction');
        fs.symlinkSync(dead, dirs.dangling, 'junction');
      } catch {
        ctx.skip('this machine does not let the test create a junction');
      }
      fs.rmdirSync(dead);
      const before = fs.readdirSync(root, { recursive: true }).sort();
      const script = [
        "$MarkerName = '.burrow-data.json'",
        functionSource('Test-MarkerBytes'),
        functionSource('Test-DataFolderOwnership'),
        ...Object.entries(dirs).map(([key, dir]) => `$r = Test-DataFolderOwnership ${psq(dir)}; Write-Output ('${key}=' + $r.State + ' | ' + $r.Reason)`),
      ].join('\n');
      const out = powershell(script);
      const lines = out.split(/\r?\n/);
      expect(lines).toContain('missing=missing | ');
      expect(lines).toContain('missingUnderMissingParent=missing | ');
      expect(lines).toContain('empty=empty | ');
      expect(lines).toContain('marked=marked | ');
      expect(lines).toContain('wronglyCased=marked | ');
      for (const key of ['foreign', 'repo', 'corrupt', 'wrongApp', 'desktopIni', 'file', 'junction', 'dangling']) expect(out, key).toMatch(new RegExp(`(^|\\n)${key}=refused`));
      expect(out).toMatch(/junction=refused \| it is a shortcut, symbolic link or junction/);
      expect(out).toMatch(/dangling=refused \| it is a shortcut, symbolic link or junction/);
      expect(out).toMatch(/desktopIni=refused \| it already holds 1 other item\(s\)/);
      expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);

  it.runIf(WIN)('Test-DataFolderOwnership agrees with the shared marker fixture (the app and the Rust shell read the same file)', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sl-fx-'));
    try {
      const { cases } = JSON.parse(readFileSync(path.join(root, 'server', '__tests__', 'fixtures', 'markers.json'), 'utf8'));
      expect(cases.length).toBeGreaterThanOrEqual(30);
      const dirs = cases.map((c, i) => {
        const dir = path.join(dataRoot, `c${i}`);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.burrow-data.json'), c.base64 === undefined ? Buffer.from(c.text, 'utf8') : Buffer.from(c.base64, 'base64'));
        return dir;
      });
      const script = [
        "$MarkerName = '.burrow-data.json'",
        functionSource('Test-MarkerBytes'),
        functionSource('Test-DataFolderOwnership'),
        ...dirs.map((dir, i) => `$r = Test-DataFolderOwnership ${psq(dir)}; Write-Output ('case${i}=' + $r.State)`),
      ].join('\n');
      const out = powershell(script);
      cases.forEach((c, i) => {
        expect(out.split(/\r?\n/), c.name).toContain(`case${i}=${c.valid ? 'marked' : 'refused'}`);
      });
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 180000);

  it.runIf(WIN)('Test-ProfileRootAllowed: -Run with a -ProfileRoot other than %USERPROFILE% is not allowed; dry runs and the real profile are', () => {
    const script = [
      functionSource('Test-ProfileRootAllowed'),
      "function show($label, $r) { Write-Output ($label + '=' + $r.Ok) }",
      "show 'dryRunElsewhere' (Test-ProfileRootAllowed $false 'C:/Temp/other' 'C:/Users/example')",
      "show 'runNoRoot' (Test-ProfileRootAllowed $true '' 'C:/Users/example')",
      "show 'runSameRoot' (Test-ProfileRootAllowed $true 'C:/Users/example/' 'C:/Users/example')",
      "show 'runSameRootOtherCase' (Test-ProfileRootAllowed $true 'c:/users/EXAMPLE' 'C:/Users/example')",
      "show 'runElsewhere' (Test-ProfileRootAllowed $true 'C:/Temp/other' 'C:/Users/example')",
      "show 'runInsideProfile' (Test-ProfileRootAllowed $true 'C:/Users/example/sub' 'C:/Users/example')",
      "show 'runNoProfile' (Test-ProfileRootAllowed $true 'C:/Temp/other' '')",
      "Write-Output ('detail=' + (Test-ProfileRootAllowed $true 'C:/Temp/other' 'C:/Users/example').Detail)",
    ].join('\n');
    const out = powershell(script);
    expect(out).toMatch(/dryRunElsewhere=True/);
    expect(out).toMatch(/runNoRoot=True/);
    expect(out).toMatch(/runSameRoot=True/);
    expect(out).toMatch(/runSameRootOtherCase=True/);
    for (const key of ['runElsewhere', 'runInsideProfile', 'runNoProfile']) expect(out, key).toMatch(new RegExp(`${key}=False`));
    expect(out).toMatch(/detail=-ProfileRoot C:\/Temp\/other is not your user profile .* dry runs and tests only/);
  }, 120000);

  it('fails the preflight for -Run with a -ProfileRoot that is not the real profile, before anything is changed', () => {
    expect(code).toContain('$rootCheck = Test-ProfileRootAllowed $script:Apply $ProfileRoot $env:USERPROFILE');
    expect(code).toContain("Add-Check 'a' '-ProfileRoot is the real user profile for -Run' 'FAIL' $rootCheck.Detail");
    expect(code.indexOf("'-ProfileRoot is the real user profile for -Run' 'FAIL'")).toBeLessThan(code.indexOf("throw 'Preflight failed; nothing was changed.'"));
    expect(src).toMatch(/-ProfileRoot that is not %USERPROFILE% FAILS the preflight/);
  });

  it('reads the marker like the app: raw bytes, strict UTF-8, case-sensitive, formatVersion an integer', () => {
    const fn = functionSource('Test-MarkerBytes');
    expect(fn).toContain('UTF8Encoding($false, $true)');
    expect(fn).toContain('$Bytes[0] -eq 0xEF');
    expect(fn).toContain('-ceq');
    expect(fn).not.toMatch(/\$m\.(app|edition|dataLocation|formatVersion)\b/);
    expect(functionSource('Test-DataFolderOwnership')).toContain('[System.IO.File]::ReadAllBytes');
    expect(functionSource('Test-DataFolderOwnership')).toContain('[System.IO.File]::GetAttributes($Path)');
    expect(functionSource('Test-DataFolderOwnership')).toContain('-ErrorAction Stop');
  });

  it.runIf(WIN)('Assert-BackupSane: a .git folder or too many files is refused without -Force, a small folder passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sl-bk-'));
    try {
      const small = path.join(root, 'small');
      fs.mkdirSync(small);
      fs.writeFileSync(path.join(small, 'burrow.db'), 'x');
      const repo = path.join(root, 'repo');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'package.json'), '{}');
      const many = path.join(root, 'many');
      fs.mkdirSync(many);
      for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(many, `f${i}.txt`), 'x');
      const prelude = (force) =>
        [
          `$Force = [bool]${force ? 1 : 0}`,
          '$BackupMaxFiles = 10',
          '$BackupMaxBytes = 1GB',
          'function Add-Check([string]$Step, [string]$Name, [string]$Status, [string]$Detail) { Write-Output ("CHECK " + $Status + " " + $Name) }',
          functionSource('Assert-BackupSane'),
        ].join('\n');
      const attempt = (dir, force) => powershell(`${prelude(force)}\ntry { Assert-BackupSane ${psq(dir)} 'x'; Write-Output 'PASSED' } catch { Write-Output ('THROWN ' + $_.Exception.Message) }`);
      expect(attempt(small, false)).toMatch(/PASSED/);
      const repoOut = attempt(repo, false);
      expect(repoOut).toMatch(/CHECK FAIL x backup safety/);
      expect(repoOut).toMatch(/THROWN Backup refused: the folder looks like a source repository/);
      const manyOut = attempt(many, false);
      expect(manyOut).toMatch(/CHECK FAIL x backup safety/);
      expect(manyOut).toMatch(/THROWN Backup refused: the folder is much larger/);
      expect(attempt(repo, true)).toMatch(/PASSED/);
      expect(attempt(many, true)).toMatch(/PASSED/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180000);

  it.runIf(WIN)('the dry run FAILS the preflight for an unmarked Burrow Data folder and leaves it, and everything else, unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sl-dry-'));
    try {
      const target = path.join(root, 'Burrow Data');
      fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      fs.writeFileSync(path.join(target, 'README.md'), 'a source repo');
      const snapshot = () => fs.readdirSync(root, { recursive: true }).sort().join('|');
      const before = snapshot();
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Bundle', path.join(root, 'missing.msixbundle'), '-DataLocation', 'userprofile', '-ProfileRoot', root];
      const out = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 170000 });
      const text = `${out.stdout}${out.stderr}`;
      expect(out.status).toBe(1);
      expect(text).toMatch(/\[FAIL\] a: data folder is safe to use/);
      expect(text).toMatch(/is not a Burrow data folder/);
      expect(text).toMatch(/will not be backed up, started against or touched/);
      expect(text).toMatch(/Nothing was changed/);
      expect(snapshot()).toBe(before);
      expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('a source repo');
      // A missing folder passes the ownership check, and the dry run still creates nothing.
      fs.rmSync(target, { recursive: true, force: true });
      const missing = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 170000 });
      expect(`${missing.stdout}`).toMatch(/\[PASS\] a: data folder is safe to use/);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 400000);
});
