// Runs `tauri dev` against a throwaway data dir and `node server.js` (no SEA build needed).
// The shell still starts the server with a minimal env, a secret on stdin and the ready handshake.
// Guards: the data dir is always a fresh folder under the OS temp dir (never the real data dir).
// UI: the normal build by default; `npm run desktop:dev -- --devtools` builds the developer tools UI instead. A stale
// dist/ is rebuilt first (see devDist.js).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, runTauri } from './lib.js';
import { buildScriptFor, decideDistRebuild, parseDevArgs, readDevStamp, readGitState, writeDevStamp } from './devDist.js';
import { distHasDevTools } from '../checks/channelMarker.js';
import { assertSafeDataDir, resolveNpmCli } from '../lib/sandboxSafety.js';

try {
  const mode = parseDevArgs(process.argv.slice(2));
  const label = mode.devtools ? 'developer tools UI' : 'normal UI';
  const dist = path.join(ROOT, 'dist');
  const hasIndex = fs.existsSync(path.join(dist, 'index.html'));
  const git = readGitState(ROOT);
  const decision = decideDistRebuild({
    hasIndex,
    distDevTools: hasIndex && distHasDevTools(dist),
    wantDevTools: mode.devtools,
    stamp: hasIndex ? readDevStamp(dist) : null,
    git,
  });
  if (decision.rebuild) {
    const script = buildScriptFor(mode);
    console.log(`desktop dev: building the ${label} (npm run ${script}) because ${decision.reason}`);
    const res = spawnSync(process.execPath, [resolveNpmCli(), 'run', script], { cwd: ROOT, env: process.env, stdio: 'inherit', shell: false });
    if (res.status !== 0) throw new Error(`npm run ${script} failed`);
    if (distHasDevTools(dist) !== mode.devtools) {
      throw new Error(`npm run ${script} ${mode.devtools ? 'did not add' : 'added'} the developer tools (check BURROW_CHANNEL in your environment)`);
    }
    writeDevStamp(dist, { ...git, devtools: mode.devtools });
  } else {
    console.log(`desktop dev: using the ${label} already built, ${decision.reason}`);
  }
  const dataDir = assertSafeDataDir(path.join(os.tmpdir(), 'burrow-desktop-dev', String(Date.now())));
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`desktop dev data dir: ${dataDir}`);
  runTauri(['dev'], {
    ...process.env,
    BURROW_DESKTOP_DATA_DIR: dataDir,
    BURROW_DEV_NODE: process.execPath,
    BURROW_DEV_ENTRY: path.join(ROOT, 'server.js'),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
