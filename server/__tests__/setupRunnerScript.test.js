// Static guards over scripts/runner/setup-runner.ps1 (it is never run for real by a test: it installs a service). On
// Windows the script is also parsed by the real PowerShell parser, its pure helpers are called, and it is run only
// with -WhatIf and -Status against a stubbed gh, so nothing is installed, deleted or sent anywhere.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPrivateFile, readPrivateFile } from './helpers/privateFiles.js';

const SCRIPT = path.join(path.resolve(import.meta.dirname, '..', '..'), 'scripts', 'runner', 'setup-runner.ps1');
// scripts/runner is private-only (left out of the public core export): the whole file is skipped without it.
const HAS_SCRIPT = hasPrivateFile('scripts/runner/setup-runner.ps1');
const text = readPrivateFile('scripts/runner/setup-runner.ps1');
const code = text.replace(/<#[\s\S]*?#>/, '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const between = (from, to) => code.slice(code.indexOf(from), code.indexOf(to, code.indexOf(from)));

describe.skipIf(!HAS_SCRIPT)('setup-runner.ps1 (static)', () => {
  it('is plain ASCII with no chained && (PowerShell 5.1) and no em dash', () => {
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x00-\x7F]*$/);
    expect(code).not.toContain('&&');
  });

  it('refuses unless the repo is private, before it downloads or creates anything', () => {
    expect(code).toContain("'visibility'");
    expect(code).toContain("-eq 'PRIVATE'");
    const install = code.slice(code.indexOf('function Install-Runner'));
    expect(install.indexOf('Test-RepoPrivate $Repo')).toBeGreaterThan(-1);
    expect(install.indexOf('Test-RepoPrivate $Repo')).toBeLessThan(install.indexOf('Invoke-WebRequest'));
    expect(install.indexOf('Test-RepoPrivate $Repo')).toBeLessThan(install.indexOf('New-LocalUser'));
  });

  it('checks the published sha256 before extracting, and installs the arm64 runner with the burrow labels', () => {
    const at = code.indexOf('Invoke-WebRequest');
    expect(code.indexOf('Get-FileHash', at)).toBeGreaterThan(at);
    expect(code.indexOf('Expand-Archive')).toBeGreaterThan(code.indexOf('Get-FileHash'));
    expect(code).toContain("$script:RunnerArch = 'win-arm64'");
    expect(code).toContain("$script:Labels = 'self-hosted,Windows,ARM64,burrow'");
    expect(code).toContain('registration-token');
    expect(code).toContain('--runasservice');
  });

  it('never stores or asks for a personal access token', () => {
    expect(code).not.toMatch(/\bPAT\b|personal access token|GH_TOKEN|GITHUB_TOKEN|Set-Content|Out-File|Add-Content/i);
  });

  it('gives the service user only Read and Execute on the runner folder, Modify on _work and _diag, and disables updates', () => {
    expect(code).toContain('ReadAndExecute');
    expect(code).toMatch(/foreach \(\$sub in @\('_work', '_diag'\)\)/);
    // The only Modify grant is the one inside that loop, on $dir (a _work or _diag folder), never on $RunnerDir.
    expect(code.match(/\(OI\)\(CI\)M"/g)).toHaveLength(1);
    expect(code).toMatch(/icacls\.exe \$dir \/grant "\*\$\{sid\}:\(OI\)\(CI\)M"/);
    expect(code).not.toMatch(/\$RunnerDir[^\n]*\(OI\)\(CI\)M/);
    expect(code).toContain('--disableupdate');
  });

  it('creates the folder with its locked ACL in one call (owner, protected, Administrators and SYSTEM full, service RX) and checks it is empty before extracting', () => {
    const install = code.slice(code.indexOf('function Install-Runner'));
    expect(install).toContain('[IO.Directory]::CreateDirectory($RunnerDir, (New-LockedSecurity $sid))');
    expect(install).not.toMatch(/New-Item -ItemType Directory -Path \$RunnerDir/);
    // The locked ACL is built by one helper (also used for the job-started hook folder and file).
    const locked = between('function New-LockedSecurity', 'function Get-HookPath');
    expect(locked).toContain('$sec.SetOwner($admins)');
    expect(locked).toContain('SetAccessRuleProtection($true, $false)');
    expect(locked).toContain('S-1-5-32-544');
    expect(locked).toContain('S-1-5-18');
    expect(locked).toMatch(/\$fs::FullControl[\s\S]*\$fs::FullControl[\s\S]*ReadAndExecute/);
    expect(locked).not.toMatch(/Modify|Write/);
    expect(install.indexOf('CreateDirectory')).toBeLessThan(install.indexOf('Get-ChildItem -LiteralPath $RunnerDir -Force'));
    expect(install.indexOf('Get-ChildItem -LiteralPath $RunnerDir -Force')).toBeLessThan(install.indexOf('Expand-Archive'));
  });

  it('refuses a -ServiceUser that is the signed-in user, an administrator, or an account without the script marker', () => {
    const fn = between('function Assert-ServiceUserSafe', 'function Get-ServiceSid');
    expect(fn).toContain('$env:USERNAME');
    expect(fn).toContain("Get-LocalGroupMember -Group 'Administrators'");
    expect(fn).toContain('Burrow self-hosted runner');
    expect(fn).toContain('.Description');
    expect(code).toContain("$script:UserDescription = 'Burrow self-hosted runner");
    const install = code.slice(code.indexOf('function Install-Runner'), code.indexOf('# --- Remove'));
    expect(install.indexOf('Assert-ServiceUserSafe')).toBeGreaterThan(-1);
    expect(install.indexOf('Assert-ServiceUserSafe')).toBeLessThan(install.indexOf('Invoke-WebRequest'));
    const remove = code.slice(code.indexOf('function Remove-Runner {'));
    expect(remove).toContain('Test-ValidUserName $ServiceUser');
    expect(remove.indexOf('Assert-ServiceUserSafe')).toBeLessThan(remove.indexOf('Remove-RunnerInstall'));
    expect(code).not.toContain('Remove-LocalGroupMember');
  });

  it('returns before touching the old runner when the download is declined (not -WhatIf)', () => {
    const install = code.slice(code.indexOf('function Install-Runner'));
    const at = install.indexOf('-not $zip -and -not $WhatIfPreference');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(install.indexOf('Remove-RunnerInstall'));
  });

  it('never runs takeown, a recursive icacls or a recursive Remove-Item; folders go through cmd rd', () => {
    expect(code).not.toMatch(/takeown/i);
    expect(code).not.toMatch(/icacls[^\n]*\/T\b/i);
    expect(code).not.toMatch(/-Recurse/i);
    expect(code).toContain('cmd.exe /c rd /s /q');
  });

  it('removes through the API, then stops and deletes the service, then deletes the folder', () => {
    const fn = between('function Remove-RunnerInstall', '# --- Install');
    const del = fn.indexOf("'-X', 'DELETE'");
    const stop = fn.indexOf('sc.exe stop');
    const delSvc = fn.indexOf('sc.exe delete');
    const rd = fn.indexOf('Remove-FolderSafe $RunnerDir');
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(stop);
    expect(stop).toBeLessThan(delSvc);
    expect(delSvc).toBeLessThan(rd);
    expect(fn).toContain('repos/$Repo/actions/runners/$id');
    expect(fn).toContain('[int64]');
    // Nothing from the runner folder is executed during removal.
    expect(code).not.toMatch(/&\s*\$cfg\s+remove/);
    expect(code).not.toContain('remove-token');
  });

  it('runs config.cmd only after the fresh extraction, and reinstalls from scratch every time', () => {
    const install = between('function Install-Runner', '# --- Remove');
    expect(install).toContain('Remove-RunnerInstall');
    expect(install.indexOf('Remove-RunnerInstall')).toBeLessThan(install.indexOf('Expand-Archive'));
    expect(install.indexOf('Get-FileHash')).toBeLessThan(install.indexOf('Remove-RunnerInstall'));
    expect(install.indexOf('Expand-Archive')).toBeLessThan(install.indexOf('& $cfg @cfgArgs'));
    expect(install).not.toContain('Nothing to do');
    expect(install).not.toContain('skipping the download');
    // The only thing run from the runner folder is config.cmd.
    expect(code.match(/&\s*\$cfg\b/g)).toHaveLength(1);
  });

  it('refuses an existing runner folder not owned by Administrators or SYSTEM, and junctions', () => {
    expect(code).toContain('function Test-TrustedOwnerSid');
    expect(code).toContain("'S-1-5-32-544', 'S-1-5-18'");
    const guard = between('function Assert-SafeRunnerDir', '# A junction-safe delete');
    expect(guard).toContain('GetOwner');
    expect(guard).toContain('Test-ReparsePoint');
    expect(guard).toContain('throw');
    expect(code.slice(code.indexOf('function Install-Runner'))).toContain('Assert-SafeRunnerDir');
    expect(code.slice(code.indexOf('function Remove-Runner'))).toContain('Assert-SafeRunnerDir');
  });

  it('validates -RunnerVersion and requires the exact download address', () => {
    expect(code).toContain("'^\\d+\\.\\d+\\.\\d+$'");
    expect(code).toContain('https://github.com/actions/runner/releases/download/v$Version/$Name');
    expect(code).toContain('$url -ne $expected');
    expect(code).not.toContain('-notlike');
  });

  it('denies interactive sign-in, removes the account rights on -Remove, and documents the password on the command line', () => {
    expect(code).toContain('SeDenyInteractiveLogonRight');
    expect(code).toContain('SeDenyRemoteInteractiveLogonRight');
    const rm = code.slice(code.indexOf('function Remove-Runner'));
    expect(rm).toContain('Clear-ServiceUserRights');
    expect(rm.indexOf('Clear-ServiceUserRights')).toBeLessThan(rm.indexOf('Remove-LocalUser'));
    expect(text).toMatch(/--windowslogonpassword\) on its command line|command line \(--windowslogonpassword\)/);
  });

  it('has -Status, -Remove with the -Uninstall alias, -WhatIf support and an admin check', () => {
    expect(text).toContain('[switch]$Status');
    expect(text).toMatch(/\[Alias\('Uninstall'\)\]\s*\[switch\]\$Remove/);
    expect(text).toContain('SupportsShouldProcess');
    expect(code).toContain('function Confirm-Admin');
  });
});

const isWindows = process.platform === 'win32';
const ps = isWindows ? spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }) : null;

describe.skipIf(!HAS_SCRIPT || !ps || ps.status !== 0)('setup-runner.ps1 (PowerShell)', () => {
  it('parses without errors and its helpers behave', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-ps-')), 'check.ps1');
    const script = [
      `$errs = $null; $tokens = $null`,
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$tokens, [ref]$errs)`,
      `if ($errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 2 }`,
      `. '${SCRIPT}'`,
      `$sha = 'a' * 64`,
      `$body = 'x <!-- BEGIN SHA win-arm64 -->' + $sha + '<!-- END SHA win-arm64 -->'`,
      `$results = @(`,
      `  (Test-RepoPrivate 'o/r' { 'PRIVATE' }),`,
      `  (Test-RepoPrivate 'o/r' { 'PUBLIC' }),`,
      `  (Test-RepoPrivate 'o/r' { 'INTERNAL' }),`,
      `  ((Get-ReleaseSha $body 'win-arm64') -eq $sha),`,
      `  ($null -eq (Get-ReleaseSha $body 'win-x64')),`,
      `  ((New-RandomPassword) -cmatch '^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{32}$'),`,
      `  (Test-ValidRepo 'ChristianMunoz31/burrow'),`,
      `  (Test-ValidRepo 'a/b;c'),`,
      `  (Test-ValidRunnerVersion '2.325.0'),`,
      `  (Test-ValidRunnerVersion '2.325'),`,
      `  (Test-ValidRunnerVersion '2.325.0; calc'),`,
      `  (Test-TrustedOwnerSid 'S-1-5-32-544'),`,
      `  (Test-TrustedOwnerSid 'S-1-5-18'),`,
      `  (Test-TrustedOwnerSid 'S-1-5-21-1-2-3-1001'),`,
      `  ((Get-RunnerUrl '2.325.0' 'x.zip') -ceq 'https://github.com/actions/runner/releases/download/v2.325.0/x.zip'),`,
      `  (($null -eq (Initialize-Lsa)) -and [bool]('BurrowLsa' -as [type]))`,
      `)`,
      `$results -join ','`,
    ].join('\n');
    fs.writeFileSync(tmp, script);
    try {
      const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8' });
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe('True,False,False,True,True,True,True,False,True,False,False,True,True,False,True,True');
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });

  // -WhatIf and -Status against a stub gh: no service, user, folder or network call is made.
  describe('dry runs with a stubbed gh', () => {
    const version = '2.999.0';
    const zipName = `actions-runner-win-arm64-${version}.zip`;
    const runnerName = 'burrow-' + os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    function run(extraArgs) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-ps-stub-'));
      try {
        fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
          tag_name: `v${version}`,
          body: `x <!-- BEGIN SHA win-arm64 -->${'b'.repeat(64)}<!-- END SHA win-arm64 -->`,
          assets: [{ name: zipName, browser_download_url: `https://github.com/actions/runner/releases/download/v${version}/${zipName}` }],
        }));
        fs.writeFileSync(path.join(root, 'runners.json'), JSON.stringify({ runners: [{ id: 4242, name: runnerName, status: 'online', busy: false, labels: [{ name: 'burrow' }] }] }));
        fs.writeFileSync(path.join(root, 'gh.cmd'), [
          '@echo off',
          'if "%1"=="repo" ( echo PRIVATE& exit /b 0 )',
          'if "%1"=="api" (',
          '  if "%2"=="repos/actions/runner/releases/latest" ( type "%~dp0release.json"& exit /b 0 )',
          '  if "%2"=="repos/o/r/actions/runners" ( type "%~dp0runners.json"& exit /b 0 )',
          ')',
          'echo unexpected gh call %* 1>&2',
          'exit /b 1',
        ].join('\r\n'));
        const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
        const env = { ...process.env, [pathKey]: `${root};${process.env[pathKey]}` };
        const runnerDir = path.join(root, 'runner-not-installed');
        const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Repo', 'o/r', '-RunnerDir', runnerDir, ...extraArgs], { encoding: 'utf8', env });
        return { res, out: res.stdout + res.stderr, runnerDir };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    it('-WhatIf install lists the steps in order and creates nothing', () => {
      const { res, out, runnerDir } = run(['-WhatIf']);
      expect(res.status, out).toBe(0);
      const at = (needle) => out.indexOf(needle);
      expect(at('Download actions-runner-win-arm64')).toBeGreaterThan(-1);
      expect(at('Unregister runner')).toBeGreaterThan(at('Download actions-runner-win-arm64'));
      expect(at('(id 4242) through the API')).toBeGreaterThan(-1);
      const user = out.search(/Create the low-privilege local user|Reset the password/);
      expect(user).toBeGreaterThan(at('Unregister runner'));
      expect(at('Read and Execute only')).toBeGreaterThan(user);
      expect(at('updates disabled')).toBeGreaterThan(at('Read and Execute only'));
      expect(fs.existsSync(runnerDir)).toBe(false);
    });

    it('-Remove -WhatIf unregisters through the API first and changes nothing', () => {
      const { res, out } = run(['-Remove', '-WhatIf']);
      expect(res.status, out).toBe(0);
      expect(out).toContain('Unregister runner');
      expect(out).not.toMatch(/config\.cmd remove/);
    });

    it('rejects a malformed -RunnerVersion before any step', () => {
      const { res, out } = run(['-WhatIf', '-RunnerVersion', '2.325.0;calc']);
      expect(res.status).not.toBe(0);
      expect(out).toContain('Invalid -RunnerVersion');
    });

    it('-Status reads only', () => {
      const { res, out, runnerDir } = run(['-Status']);
      expect(res.status, out).toBe(0);
      expect(out).toContain('not installed');
      expect(out).toContain('online');
      expect(fs.existsSync(runnerDir)).toBe(false);
    });
  });
});
