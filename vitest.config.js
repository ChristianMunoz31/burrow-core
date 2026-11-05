import { configDefaults, defineConfig } from 'vitest/config';

// The developer's own OLLAMA_HOST and .env must never steer a test. Both projects blank OLLAMA_HOST
// and disable dotenv loading; the original OLLAMA_HOST is forwarded (config runs before the
// override) so the network guard can also block a custom local Ollama port.
export const ISOLATED_ENV = {
  OLLAMA_HOST: '',
  BURROW_NO_DOTENV: '1',
  BURROW_GUARD_OLLAMA_HOST: process.env.OLLAMA_HOST ?? '',
};

// Time limits only (they never slow a passing run). With every core busy, trivial tests take 10 s
// or more and server.js imports take 20 s, so the 5 s / 10 s Vitest defaults flake.
export const LOAD_LIMITS = {
  frontend: { testTimeout: 20_000, hookTimeout: 30_000 },
  // Each backup, upload inspection and restore step starts a worker thread (about 60 ms idle,
  // several times that on a loaded machine).
  backend: { testTimeout: 45_000, hookTimeout: 60_000 },
};

// Two projects so the Node/Express backend is tested in a real `node`
// environment while the existing React/util suite keeps its jsdom DOM.
export default defineConfig({
  test: {
    // Off by default; `npm run test:coverage` and the CI unit-test step switch it on.
    coverage: {
      provider: 'v8',
      enabled: false,
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        test: {
          name: 'frontend',
          environment: 'jsdom',
          globals: false,
          // pro/ui and pro/server exist only where the private Pro repo is checked out (docs/adr/0001-open-core-split.md).
          include: ['src/**/__tests__/**/*.test.{js,jsx}', 'devtools/ui/**/__tests__/**/*.test.{js,jsx}', 'pro/ui/**/__tests__/**/*.test.{js,jsx}'],
          setupFiles: ['server/__tests__/setup/networkGuard.js'],
          ...LOAD_LIMITS.frontend,
          env: { ...ISOLATED_ENV },
        },
      },
      {
        test: {
          name: 'backend',
          environment: 'node',
          globals: false,
          ...LOAD_LIMITS.backend,
          include: ['server/__tests__/**/*.test.js', 'devtools/server/**/__tests__/**/*.test.js', 'pro/server/**/__tests__/**/*.test.js'],
          // The tests that start real PDF/DOCX parser workers run only in `npm run test:parser` (vitest.parser.config.js, issue #67).
          exclude: [...configDefaults.exclude, 'server/__tests__/**/*.parser.test.js', 'pro/server/**/__tests__/**/*.parser.test.js'],
          // networkGuard first: blocks real connections to remote hosts and to the developer's
          // own Ollama/Burrow/Vite ports so tests behave the same locally and in CI.
          setupFiles: ['server/__tests__/setup/networkGuard.js', 'server/__tests__/setup/dataDir.js'],
          // Tests give each request its own client IP via X-Forwarded-For; that is only
          // honored when a proxy is trusted. Burrow itself defaults to trusting none.
          // The network opt-ins default ON here so the integration tests (which mock
          // fetch) exercise their routes; netPolicy tests clear this variable.
          env: {
            ...ISOLATED_ENV,
            BURROW_TRUST_PROXY: '1',
            BURROW_NETWORK_OPTIN: 'weather,oura',
            // A developer shell with BURROW_DOC_PARSING=1 must not turn parsing on in the default suite (test:parser sets it).
            BURROW_DOC_PARSING: '',
          },
        },
      },
    ],
  },
});
