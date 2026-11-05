// Loads environment variables. Imported FIRST by server.js so that the env is
// populated before any other module (e.g. the SQLite layer resolving BURROW_DATA_DIR) reads process.env
// at import time — ESM evaluates imported modules in source order, so this must
// come before those imports to take effect.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDesktopMode } from './server/runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// BURROW_NO_DOTENV=1 skips both files (the sandbox/preview scripts set it so the owner's .env can
// never repoint the data dir or port of a throwaway server). Desktop mode skips them too, as defense
// in depth: the shell owns the sidecar's environment.
if (process.env.BURROW_NO_DOTENV !== '1' && !isDesktopMode()) {
  // override: true so .env always wins over shell env (e.g., when a parent
  // process has the var set to empty).
  dotenv.config({ override: true, quiet: true, path: path.join(__dirname, '.env') });
  // Also load .env.local for machine-specific overrides. No override here:
  // anything already set by .env above or the real environment wins.
  dotenv.config({ quiet: true, path: path.join(__dirname, '.env.local') });
}
