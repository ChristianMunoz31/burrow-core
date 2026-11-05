// Standalone fake Ollama for Playwright and manual use (never the real one, never port 11434).
//
//   node scripts/fakeOllama.js [--port N]
//   npm run fake:ollama -- [--port N]
//
// Prints one line `FAKE_OLLAMA_READY {"url":...,"port":...,"model":...}` when listening, then runs
// until Ctrl+C or SIGTERM. Point a Burrow server at it with OLLAMA_HOST=<url>.
import { fileURLToPath } from 'node:url';
import { FAKE_MODEL_NAME, REAL_OLLAMA_PORT, startFakeOllama } from './lib/fakeOllamaServer.js';

const USAGE = 'Usage: node scripts/fakeOllama.js [--port N]';

/**
 * @param {string[]} argv
 * @returns {{ port: number }}
 */
export function parseArgs(argv) {
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      const raw = argv[(i += 1)];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`--port needs a number from 0 to 65535.\n${USAGE}`);
      port = Number(raw);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}\n${USAGE}`);
    }
  }
  if (port === REAL_OLLAMA_PORT) throw new Error(`Refusing port ${REAL_OLLAMA_PORT}: that is the real Ollama's port.`);
  return { port };
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));
  const fake = await startFakeOllama({ port });
  console.log(`FAKE_OLLAMA_READY ${JSON.stringify({ url: fake.url, port: fake.port, model: FAKE_MODEL_NAME })}`);
  const stop = () => {
    fake.close().then(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
