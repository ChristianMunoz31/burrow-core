// Runs the release-please CLI (version 17, installed by release:auto in %LOCALAPPDATA%\burrow-release\tools) with
// the GitHub token taken from the environment instead of the command line, so the token never appears in a process
// listing, a log or a printed command. release-please itself only accepts --token as an argument (or a file path,
// which would put the token on disk), so this shim reads BURROW_RP_TOKEN, deletes it from its own environment and
// hands it to release-please's parser in memory.
//
// Usage (release:auto only): node releasePleaseShim.mjs <path to release-please/build/src/bin/release-please.js> <args...>
import { createRequire } from 'node:module';
import path from 'node:path';

const TOKEN_VAR = 'BURROW_RP_TOKEN';

async function main() {
  const [bin, ...args] = process.argv.slice(2);
  if (!bin || path.basename(bin) !== 'release-please.js') throw new Error('Usage: releasePleaseShim.mjs <release-please.js> <args...>');
  if (args.some((a) => a === '--token' || a.startsWith('--token='))) throw new Error('Pass the token through the environment, never as an argument.');
  const token = process.env[TOKEN_VAR];
  delete process.env[TOKEN_VAR];
  if (typeof token !== 'string' || token.trim() === '') throw new Error(`${TOKEN_VAR} is empty.`);
  const require = createRequire(import.meta.url);
  // The bin only parses process.argv when it is the main module, so requiring it just loads the parser.
  const rp = require(path.resolve(bin));
  if (typeof rp?.parser?.parseAsync !== 'function') throw new Error('This release-please has no parser export; install release-please 17.');
  try {
    const argv = await rp.parser.parseAsync([...args, `--token=${token.trim()}`]);
    if (rp.handleError) rp.handleError.yargsArgs = argv;
  } catch (err) {
    if (typeof rp.handleError === 'function') rp.handleError(err);
    else throw err;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
