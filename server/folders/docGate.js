// The switch for reading PDF and DOCX files in Folders. It is OFF everywhere until the parser runs in its own process
// (issue #67): a Node-native crash in worker_threads teardown of the parser worker can end the whole server, which a
// JS-level isolation cannot contain. With the gate off no parser Worker is ever created; a PDF or DOCX is listed as
// `unsupported` ("Not supported yet"), exactly as the first Folders round listed it.
//
// The only override is the developer variable BURROW_DOC_PARSING=1. It is never in the UI and is honoured only when ALL of:
//   - the bundler did not bake `__BURROW_DOC_PARSING__` false (every bundled sidecar does, so a SEA cannot turn it on),
//   - this is not a release build (`__BURROW_RELEASE_BUILD__`), and
//   - the code runs from a source checkout (a `.git` entry at the repo root; the release zip and Docker image have none).
// The Tauri shell does not pass the variable to the sidecar (src-tauri/src/sidecar.rs PASSTHROUGH).
/* global __BURROW_DOC_PARSING__ */
import { isReleaseBuild, isSourceCheckout } from '../license/channelSeam.js';

export const DOC_PARSING_ENV = 'BURROW_DOC_PARSING';

/** The failure code a document read answers with while parsing is off (never a user-facing string). */
export const DOC_PARSING_OFF = 'doc_parsing_off';

/** False when the bundler baked the define false (every bundled build); true unbundled, where it is undefined. */
export function docParsingCompiledIn() {
  return typeof __BURROW_DOC_PARSING__ !== 'boolean' || __BURROW_DOC_PARSING__;
}

/**
 * Whether PDF and DOCX files may be parsed. Off unless the developer variable is exactly `1` in a source checkout of an
 * unbundled build.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ compiled?: boolean, release?: boolean, checkout?: boolean }} [opts] injected by tests
 * @returns {boolean}
 */
export function docParsingEnabled(env = process.env, opts = {}) {
  if (env[DOC_PARSING_ENV] !== '1') return false;
  const { compiled = docParsingCompiledIn(), release = isReleaseBuild(), checkout = isSourceCheckout() } = opts;
  return compiled && !release && checkout;
}
