// Release zip step: makes a staged source tree ship without the developer tools.
//   node scripts/release/disableDevTools.mjs <staged-root>
// 1. Removes the devtools/ folder (the developer tools live only there; .gitattributes export-ignore already keeps
//    it out of `git archive`, this is the second line of defence).
// 2. Fails (exit 1) when the old in-core override module is back (server/license/devOverride.js), or when a developer
//    tools marker (DEV_TOOLS_MARKER, DEV_TOOLS_ROUTE_MARKER) is still in the runtime code of the tree.
// Scan scope: server.js, server/, src/ and dist/ without any `__tests__` folder. That is everything that can run
// in a zip or Docker install. scripts/ (channelMarker.js holds the markers as its check constants), docs/ and the
// tests mention the text on purpose and never run, so scanning them would only produce false alarms.
// Idempotent: a second run finds nothing to remove and the same clean tree.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_TOOLS_MARKER, DEV_TOOLS_ROUTE_MARKER } from '../checks/channelMarker.js'

const DEVTOOLS_DIR = 'devtools'
const STALE = path.join('server', 'license', 'devOverride.js')
const SCAN_ROOTS = ['server.js', 'server', 'src', 'dist']
const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.git'])
const MARKERS = [DEV_TOOLS_MARKER, DEV_TOOLS_ROUTE_MARKER]

function* walk(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isFile()) {
    yield target
    return
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    yield* walk(path.join(target, entry.name))
  }
}

/**
 * @param {string} root staged source tree (the folder that holds server.js)
 * @returns {{ removed: boolean, leftovers: string[] }} `removed` is true when a devtools/ folder was there;
 *   leftovers are root-relative paths that still carry a marker
 * @throws {Error} when server/license/devOverride.js exists (the developer tools must live in devtools/ only)
 */
export function disableDevTools(root) {
  if (fs.existsSync(path.join(root, STALE))) throw new Error(`${STALE} exists in ${root}: the developer tools belong in ${DEVTOOLS_DIR}/ only`)
  const dir = path.join(root, DEVTOOLS_DIR)
  const removed = fs.existsSync(dir)
  fs.rmSync(dir, { recursive: true, force: true })

  const leftovers = []
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(root, scanRoot))) {
      const bytes = fs.readFileSync(file)
      if (MARKERS.some((marker) => bytes.includes(marker))) leftovers.push(path.relative(root, file))
    }
  }
  return { removed, leftovers }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: node scripts/release/disableDevTools.mjs <staged-root>')
    process.exit(2)
  }
  try {
    const { removed, leftovers } = disableDevTools(path.resolve(root))
    if (leftovers.length > 0) {
      console.error(`developer tools marker still present in: ${leftovers.join(', ')}`)
      process.exit(1)
    }
    console.log(`developer tools disabled (${removed ? 'devtools/ removed' : 'devtools/ already absent'}), markers not found`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
