import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.sidecar-build', 'src-tauri']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // No dynamic code in the app source (indexHtmlPrepaint.test.js runs the pre-paint script with new Function)
  {
    files: ['src/**/*.{js,jsx}', 'pro/ui/**/*.{js,jsx}'],
    ignores: ['src/**/__tests__/**', 'pro/ui/**/__tests__/**'],
    rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' },
  },
  // Node-side files (API server, SQLite layer, scripts, tooling)
  {
    files: [
      'server.js',
      'loadEnv.js',
      'server/**/*.js',
      'devtools/server/**/*.js',
      'pro/server/**/*.js',
      'pro/scripts/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs}',
      '*.config.{js,cjs}',
    ],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  // Playwright e2e (runs in Node; a few helpers pass callbacks that execute in the browser page)
  {
    files: ['e2e/**/*.{js,mjs}', 'pro/e2e/**/*.{js,mjs}', 'playwright*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
    },
    // Not React code: Playwright's fixture callback is literally named `use`, and helpers such as
    // `useBurrow` register test hooks at file top level.
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
])
