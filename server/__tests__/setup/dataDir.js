import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(path.join(os.tmpdir(), 'burrow-test-'));
process.env.BURROW_TEST_DATA_DIR = dir;
process.env.BURROW_DATA_DIR = dir; // belt and braces for code that calls getDataDir() directly

// Local AI settings from the developer's own shell (an Ollama install often sets OLLAMA_HOST)
// must not leak into tests: every AI test mocks node-fetch and expects the defaults.
for (const name of [
  'BURROW_AI',
  'OLLAMA_HOST',
  'OLLAMA_NUM_CTX',
  'OLLAMA_KEEP_ALIVE',
  'BURROW_AI_CHAT_MODEL',
  'BURROW_AI_TOOL_MODEL',
  'BURROW_AI_AUTO_MAX_PARAMS_B',
  'BURROW_AI_FIRST_TOKEN_TIMEOUT_MS',
  'BURROW_AI_TOTAL_TIMEOUT_MIN',
  'BURROW_AI_CONCURRENCY',
  'BURROW_AI_QUEUE_MAX',
  'BURROW_AI_QUEUE_TIMEOUT_MS',
  'BURROW_AI_HEALTH_TTL_MS',
  'BURROW_AI_PROBE_TIMEOUT_MS',
  'BURROW_AI_WARMUP_PROBE_MS',
  'BURROW_AI_WARMING_MS',
  'JARVIS_CONFIRM_WRITES',
  'AI_CLOUD_API_KEY',
  'BURROW_CHANNEL',
  'BURROW_STABLE_DATA_DIR',
  'BURROW_DISPLAY_VERSION',
  'BURROW_DEV_TIER',
  'BURROW_DEV_TRIAL_DAYS',
]) {
  delete process.env[name];
}

afterAll(async () => {
  try {
    (await import('../../db/index.js')).closeDb();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows EBUSY: leak tmp */
  }
});
