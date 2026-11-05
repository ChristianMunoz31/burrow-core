// Build-channel facts: release build, developer tools compiled in, private module compiled in, source checkout.
/* global __BURROW_RELEASE_BUILD__, __BURROW_DEV_TOOLS__, __BURROW_PRO__ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** True in builds made by the release pipeline (the sidecar bundler defines `__BURROW_RELEASE_BUILD__` true). */
export function isReleaseBuild() {
  return typeof __BURROW_RELEASE_BUILD__ === 'boolean' && __BURROW_RELEASE_BUILD__;
}

/**
 * False when the bundler compiled the developer tools out (every stable sidecar defines `__BURROW_DEV_TOOLS__`
 * false and swaps the dev extension loader for a null stub); true in a dev bundle and in unbundled code, where it
 * is undefined. The policy that decides whether the tools may run belongs to the developer extension (see server/devExtensionsLoader.js).
 */
export function devToolsCompiledIn() {
  return typeof __BURROW_DEV_TOOLS__ !== 'boolean' || __BURROW_DEV_TOOLS__;
}

/**
 * False when the bundler built without the private module (`__BURROW_PRO__` false, the loader swapped for a null stub);
 * true in a bundle with the module and in unbundled code, where it is undefined (the loader then decides by the folder).
 */
export function proCompiledIn() {
  return typeof __BURROW_PRO__ !== 'boolean' || __BURROW_PRO__;
}

/**
 * True only in a source checkout (a `.git` file or folder at the repo root; a git worktree has a `.git` file).
 * No environment variable counts, Vitest included: tests inject `checkout: true` instead. The release zip is a
 * `git archive` without `.git`, so `npm start` from it is never a checkout.
 * @param {string} [root]
 */
export function isSourceCheckout(root = REPO_ROOT) {
  try {
    fs.statSync(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}
