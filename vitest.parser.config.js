import { defineConfig } from 'vitest/config';
import { ISOLATED_ENV, LOAD_LIMITS } from './vitest.config.js';

// The Folders PDF/DOCX parser tests (server/__tests__/**/*.parser.test.js). They start real parser worker threads, and a
// Node-native crash in worker_threads teardown can kill the whole test process (Node 24 win-arm64, issue #67), so they are
// kept OUT of the default `npm test` run and the CI gate. Document parsing is off by default (server/folders/docGate.js);
// these tests switch it on with the developer variable BURROW_DOC_PARSING=1, which only a source checkout honours.
// When issue #67 lands (the parser runs in its own process), the *.parser.test.js files return to the gating suite: rename
// them to *.test.js and delete this config, the `test:parser` script and the exclude in vitest.config.js.
export default defineConfig({
  test: {
    name: 'parser',
    environment: 'node',
    globals: false,
    ...LOAD_LIMITS.backend,
    include: ['server/__tests__/**/*.parser.test.js', 'pro/server/__tests__/**/*.parser.test.js'],
    setupFiles: ['server/__tests__/setup/networkGuard.js', 'server/__tests__/setup/dataDir.js'],
    // One test file at a time: each starts worker threads and some inflate large streams.
    fileParallelism: false,
    env: {
      ...ISOLATED_ENV,
      BURROW_TRUST_PROXY: '1',
      BURROW_NETWORK_OPTIN: 'weather,oura',
      BURROW_DOC_PARSING: '1',
    },
  },
});
