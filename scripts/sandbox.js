// Throwaway Burrow server on a free loopback port with generated demo data.
//
//   npm run sandbox -- [--keep] [--port N] [--name slug] [--app-dir dir] [--build] [--no-seed] [--real-ai | --no-ai]
//   npm run sandbox:reset            (removes every sandbox data dir)
//
// AI: by default the server talks to a bundled fake Ollama started in-process on a free loopback
// port (scripts/lib/fakeOllamaServer.js), so Javi works with zero setup and no real model is ever
// pulled. --real-ai uses the real local Ollama (127.0.0.1:11434); --no-ai points the server at a
// dead loopback port (Javi shows its missing-Ollama state). Without --real-ai the child's
// OLLAMA_HOST can never be port 11434 (asserted before spawn).
//
// Safety: the data dir is always inside the OS temp dir (never the real data dir), the port is
// never 4321 or 5174, the server runs with BURROW_NO_DOTENV=1 and a scrubbed environment, and
// the child's reported data path and port are verified before the URL is printed. The server and
// every npm/seed child get a minimal allowlisted env and a fake home under the sandbox data dir.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_ROOT,
  SandboxSafetyError,
  assertAiEnvSafe,
  assertSafeDataDir,
  assertSafePort,
  assertUnderTmp,
  buildAiEnv,
  buildChildEnv,
  freePort,
  resolveAiMode,
  runNpm,
  samePath,
  sandboxHomeFor,
  savedOllamaHost,
} from './lib/sandboxSafety.js';
import { FAKE_MODEL_NAME, startFakeOllama } from './lib/fakeOllamaServer.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const START_TIMEOUT_MS = 30_000;

const USAGE = `Usage: npm run sandbox -- [--keep] [--port N] [--name slug] [--app-dir dir] [--build] [--no-seed] [--real-ai | --no-ai]
       npm run sandbox:reset
  AI (default: bundled fake Ollama, no real model):
    --real-ai   use the real local Ollama at 127.0.0.1:11434
    --no-ai     point at a dead loopback port (Javi shows its missing-Ollama state)`;

function parseArgs(argv) {
  const out = { keep: false, port: null, name: 'default', appDir: REPO_ROOT, build: false, seed: true, reset: false, realAi: false, noAi: false };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new SandboxSafetyError(`${flag} needs a value.\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--build') out.build = true;
    else if (a === '--no-seed') out.seed = false;
    else if (a === '--reset') out.reset = true;
    else if (a === '--real-ai') out.realAi = true;
    else if (a === '--no-ai') out.noAi = true;
    else if (a === '--port') out.port = value(i++, a);
    else if (a === '--name') out.name = value(i++, a);
    else if (a === '--app-dir') out.appDir = path.resolve(value(i++, a));
    else throw new SandboxSafetyError(`Unknown argument: ${a}\n${USAGE}`);
  }
  resolveAiMode(out);
  if (!NAME_RE.test(out.name)) throw new SandboxSafetyError('--name must be letters, digits, dot, dash or underscore.');
  return out;
}

function reset() {
  assertUnderTmp(SANDBOX_ROOT);
  if (!fs.existsSync(SANDBOX_ROOT)) {
    console.log('No sandbox data to remove.');
    return;
  }
  fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  console.log(`Removed ${SANDBOX_ROOT}`);
}

function aiBanner(mode, host) {
  if (mode === 'real') return `AI: REAL Ollama at ${host} (--real-ai). Warning: Javi can pull and run real models.`;
  if (mode === 'none') return `AI: none (--no-ai), ${host} has no listener, Javi shows its missing-Ollama state.`;
  return `AI: fake Ollama at ${host} (model ${FAKE_MODEL_NAME}, canned replies, never the real Ollama). Use --real-ai for a real model.`;
}

function runSync(cmd, args, opts) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status ?? 'signal'})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.reset) {
    reset();
    return;
  }

  const dataDir = assertSafeDataDir(path.join(SANDBOX_ROOT, args.name));
  const port = args.port === null ? await freePort() : assertSafePort(args.port);
  const appDir = args.appDir;
  if (!fs.existsSync(path.join(appDir, 'server.js'))) throw new Error(`No server.js in ${appDir}`);

  if (!args.keep) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'burrow.db');
  const homeDir = sandboxHomeFor(dataDir);

  if (args.build || !fs.existsSync(path.join(appDir, 'dist', 'index.html'))) {
    console.log('Building the UI...');
    runNpm(['run', 'build'], { cwd: appDir, env: buildChildEnv({ homeDir }) });
  }

  if (args.seed && !fs.existsSync(dbFile)) {
    runSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'seedDemo.js'), '--data-dir', dataDir, '--app-dir', appDir], {
      cwd: REPO_ROOT,
    });
  }

  // The scrubbed env has no OLLAMA_HOST, which would fall back to the real Ollama on 11434.
  const aiMode = resolveAiMode(args);
  const fake = aiMode === 'fake' ? await startFakeOllama() : null;
  const deadPort = aiMode === 'none' ? await freePort() : null;
  const aiEnv = buildAiEnv({ mode: aiMode, fakeUrl: fake?.url ?? null, deadPort });
  const saved = aiMode === 'real' ? null : savedOllamaHost(dbFile);
  if (saved) {
    await fake?.close();
    throw new SandboxSafetyError(`Refusing to start: this sandbox saved an Ollama host (${saved}) that would override the AI mode. Start it without --keep to wipe it.`);
  }

  const env = buildChildEnv({
    homeDir,
    extra: {
      ...aiEnv,
      BURROW_NO_DOTENV: '1',
      BURROW_DATA_DIR: dataDir,
      BURROW_HOST: '127.0.0.1',
      BURROW_PORT: String(port),
      BURROW_SCHEDULER: '0',
      BURROW_NETWORK_OPTIN: '',
      // Store licensing test hooks (docs/LICENSING.md 4.7): passed through only when set.
      ...Object.fromEntries(
        ['BURROW_LICENSE_STORE_BASE_URL', 'BURROW_LICENSE_STORE_TEST'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
      ),
    },
  });

  assertAiEnvSafe(aiMode, env);
  if (aiMode === 'real') console.warn('WARNING: --real-ai uses your real local Ollama (127.0.0.1:11434); Javi and model pulls act on real models.');
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const abort = (message) => {
    console.error(message);
    child.kill();
    process.exitCode = 1;
  };
  const timer = setTimeout(() => {
    if (!ready) abort('The sandbox server did not start in time.');
  }, START_TIMEOUT_MS);
  timer.unref();

  const url = `http://127.0.0.1:${port}`;
  let portVerified = false;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('Burrow running at ')) {
      let reported = null;
      try {
        reported = new URL(line.slice('Burrow running at '.length).trim());
      } catch {
        // Falls through to the mismatch abort below.
      }
      if (!reported || Number(reported.port) !== port) {
        abort(`Refusing to continue: the server reported a different address (${line}).`);
        return;
      }
      portVerified = true;
    } else if (line.startsWith('Data: ')) {
      if (!samePath(line.slice('Data: '.length).trim(), dbFile)) {
        abort(`Refusing to continue: the server reported a different data file (${line}).`);
        return;
      }
      if (!portVerified) {
        abort('Refusing to continue: the server did not report its address before its data file.');
        return;
      }
      ready = true;
      clearTimeout(timer);
      console.log(`Sandbox ready: ${url}`);
      console.log(aiBanner(aiMode, env.OLLAMA_HOST));
      console.log(`Data dir: ${dataDir}${args.keep ? ' (kept between runs)' : ' (wiped on next start)'}`);
      console.log('Press Ctrl+C to stop.');
    } else {
      console.log(line);
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => console.error(line));
  child.once('error', (err) => abort(`Could not start the server: ${err.message}`));
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (!ready && code !== 0 && process.exitCode === undefined) process.exitCode = code ?? 1;
    if (!ready) console.error(`The sandbox server exited early (${signal ?? code}).`);
    process.exit(process.exitCode ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err instanceof SandboxSafetyError ? 2 : 1);
});
