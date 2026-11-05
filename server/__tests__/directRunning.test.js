// Telling whether the direct Burrow is running, before the import from it (server/backup/directRunning.js).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BURROW_PROCESS_NAMES, detectDirectBurrowRunning, otherBurrowIsRunning, parseProcessList } from '../backup/directRunning.js';

const OWN = 'C:\\Program Files\\WindowsApps\\NeuralFoundry.Burrow_1.0.0.0_arm64__abc';
const proc = (pid, name, exe) => ({ pid, name, exe });

describe('parseProcessList', () => {
  it('reads an array, a single object and an empty list', () => {
    const one = { ProcessId: 10, Name: 'Burrow.exe', ExecutablePath: 'C:\\A\\Burrow.exe' };
    expect(parseProcessList(JSON.stringify([one, { ...one, ProcessId: 11 }]))).toHaveLength(2);
    expect(parseProcessList(JSON.stringify(one))).toEqual([{ pid: 10, name: 'Burrow.exe', exe: 'C:\\A\\Burrow.exe', session: null, currentSession: null }]);
    expect(parseProcessList('[]')).toEqual([]);
    expect(parseProcessList(JSON.stringify({ ...one, ExecutablePath: null }))[0].exe).toBeNull();
  });

  it('anything unexpected is null, so the caller answers unknown', () => {
    for (const bad of ['', 'not json', 'null', '"x"', '[{"ProcessId":"1","Name":"Burrow.exe"}]', '[{"ProcessId":1}]']) {
      expect(parseProcessList(bad), bad).toBeNull();
    }
  });
});

describe('otherBurrowIsRunning', () => {
  const own = { ownPids: [100, 101], ownDir: OWN };

  it('our own processes (pids, or the folder of this package) do not count', () => {
    expect(otherBurrowIsRunning([proc(100, 'burrow-server.exe', `${OWN}\\burrow-server.exe`), proc(101, 'Burrow.exe', `${OWN}\\Burrow.exe`)], own)).toBe(false);
    // The same package folder under another pid (a second sidecar of this package) is still ours.
    expect(otherBurrowIsRunning([proc(200, 'Burrow.exe', `${OWN.toLowerCase()}\\burrow.exe`)], own)).toBe(false);
    expect(otherBurrowIsRunning([], own)).toBe(false);
  });

  it('a Burrow program from another folder is the direct Burrow', () => {
    expect(otherBurrowIsRunning([proc(300, 'Burrow.exe', 'C:\\Users\\example\\AppData\\Local\\Burrow\\Burrow.exe')], own)).toBe(true);
    expect(otherBurrowIsRunning([proc(301, 'burrow-server.exe', 'C:\\Users\\example\\AppData\\Local\\Burrow\\burrow-server.exe')], own)).toBe(true);
  });

  it('a Burrow program whose path cannot be read counts as the other Burrow', () => {
    expect(otherBurrowIsRunning([proc(302, 'Burrow.exe', null)], own)).toBe(true);
  });

  it('other programs never count', () => {
    expect(otherBurrowIsRunning([proc(400, 'node.exe', 'C:\\x\\node.exe')], own)).toBe(false);
    expect(BURROW_PROCESS_NAMES).toEqual(['Burrow.exe', 'burrow-server.exe']);
  });
});

describe('detectDirectBurrowRunning', () => {
  const base = { platform: 'win32', ownPids: [1, 2], ownDir: OWN };

  it('answers no, yes and unknown', async () => {
    expect(await detectDirectBurrowRunning({ ...base, run: async () => '[]' })).toBe('no');
    expect(
      await detectDirectBurrowRunning({ ...base, run: async () => JSON.stringify([{ ProcessId: 9, Name: 'Burrow.exe', ExecutablePath: 'C:\\Users\\example\\AppData\\Local\\Burrow\\Burrow.exe' }]) }),
    ).toBe('yes');
    expect(await detectDirectBurrowRunning({ ...base, run: async () => 'garbage' })).toBe('unknown');
    expect(
      await detectDirectBurrowRunning({
        ...base,
        run: async () => {
          throw new Error('powershell missing');
        },
      }),
    ).toBe('unknown');
  });

  it('ignores a Burrow in another Windows session; the same, or an unknown session, still blocks', async () => {
    const other = 'C:\\Users\\example\\AppData\\Local\\Burrow\\Burrow.exe';
    const run = (extra) => async () => JSON.stringify([{ ProcessId: 9, Name: 'Burrow.exe', ExecutablePath: other, ...extra }]);
    expect(await detectDirectBurrowRunning({ ...base, run: run({ SessionId: 3, CurrentSessionId: 1 }) })).toBe('no');
    expect(await detectDirectBurrowRunning({ ...base, run: run({ SessionId: 1, CurrentSessionId: 1 }) })).toBe('yes');
    expect(await detectDirectBurrowRunning({ ...base, run: run({ SessionId: 3 }) })).toBe('yes');
    expect(await detectDirectBurrowRunning({ ...base, run: run({ CurrentSessionId: 1 }) })).toBe('yes');
    expect(await detectDirectBurrowRunning({ ...base, run: run({}) })).toBe('yes');
  });

  it('parses the session ids, null when absent or not a number', () => {
    const entry = { ProcessId: 9, Name: 'Burrow.exe', ExecutablePath: 'C:\\x\\Burrow.exe' };
    expect(parseProcessList(JSON.stringify({ ...entry, SessionId: 2, CurrentSessionId: 1 }))[0]).toMatchObject({ session: 2, currentSession: 1 });
    expect(parseProcessList(JSON.stringify({ ...entry, SessionId: '2', CurrentSessionId: null }))[0]).toMatchObject({ session: null, currentSession: null });
    const own = { ownPids: [1], ownDir: OWN };
    const p = proc(5, 'Burrow.exe', 'C:\\x\\Burrow.exe');
    expect(otherBurrowIsRunning([{ ...p, session: 4, currentSession: 1 }], own)).toBe(false);
    expect(otherBurrowIsRunning([{ ...p, session: 1, currentSession: 1 }], own)).toBe(true);
    expect(otherBurrowIsRunning([{ ...p, session: null, currentSession: 1 }], own)).toBe(true);
  });

  it('is unknown where it cannot look (not Windows), which refuses the import', async () => {
    expect(await detectDirectBurrowRunning({ platform: 'linux' })).toBe('unknown');
  });

  it.runIf(process.platform === 'win32')('the real PowerShell call answers something well formed on this machine', async () => {
    const answer = await detectDirectBurrowRunning({ ownPids: [process.pid, process.ppid], ownDir: path.dirname(process.execPath) });
    expect(['no', 'yes', 'unknown']).toContain(answer);
  }, 30000);

  // The shell gives the sidecar only an allowlisted environment (src-tauri/src/sidecar.rs build_sidecar_env): SystemRoot, TEMP, TMP,
  // APPDATA, LOCALAPPDATA, USERPROFILE and PATH = %SystemRoot%\System32 (no windir, no PSModulePath). The real detection, in a child
  // process with exactly that environment, must still get a clear answer, never 'unknown'.
  it.runIf(process.platform === 'win32')('the real detection answers no or yes (never unknown) in the minimal environment the shell gives the sidecar', () => {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const env = { SystemRoot: root, PATH: `${root}\\System32` };
    for (const name of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[name] !== undefined) env[name] = process.env[name];
    const url = pathToFileURL(path.resolve(import.meta.dirname, '..', 'backup', 'directRunning.js')).href;
    const code = `import(${JSON.stringify(url)}).then(async (m) => { process.stdout.write(await m.detectDirectBurrowRunning()); })`;
    const out = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 60000 });
    expect(out.status, out.stderr).toBe(0);
    expect(['no', 'yes']).toContain(out.stdout.trim());
  }, 90000);
});
