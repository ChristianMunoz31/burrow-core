// Fails unless the private Burrow Pro module is checked out at pro/ (docs/adr/0001-open-core-split.md 3.10). Every
// official release path runs it (with BURROW_REQUIRE_PRO=1 for its builds), so a Free build (BURROW_PRO=off, the
// public core without pro/) can never be published. Exit 1 with a fixed message. Usage:
//   node scripts/checks/proPresent.js [--dist-dir <dir>] [--bundle <file>]
//   npm run check:pro-present
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PRO_ON_MARKER, listProChunks } from './channelMarker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The files an official build needs from the Pro repo. */
export const PRO_REQUIRED_FILES = Object.freeze(['pro/server/index.js', 'pro/server/static.js', 'pro/ui/proExtensions.js', 'pro/LICENSE'])

export const PRO_MISSING_MESSAGE =
  'The Burrow Pro module is missing: official builds need the private Pro repo checked out at pro/. This is a Free build (BURROW_PRO=off) and cannot be published.'

/**
 * @param {{ root?: string, distDir?: string | null, bundle?: string | null, exists?: (file: string) => boolean, read?: (file: string) => string }} [opts]
 * @returns {string[]} problems, empty when the Pro module is present (and in the dist and bundle when given)
 */
export function checkProPresent({ root = ROOT, distDir = null, bundle = null, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const problems = []
  const missing = PRO_REQUIRED_FILES.filter((rel) => !exists(path.join(root, rel)))
  if (missing.length) problems.push(`missing ${missing.join(', ')}`)
  if (distDir) {
    let chunks
    try {
      chunks = listProChunks(distDir)
    } catch {
      chunks = []
    }
    if (chunks.length === 0) problems.push(`${distDir} has no Pro chunks (assets/pro-*.js)`)
  }
  if (bundle) {
    let text
    try {
      text = read(bundle)
    } catch {
      text = ''
    }
    if (!text.includes(PRO_ON_MARKER)) problems.push(`${bundle} has no ${PRO_ON_MARKER} banner`)
  }
  return problems
}

/**
 * Throws the fixed message unless the Pro module is present. For the release scripts.
 * @param {Parameters<typeof checkProPresent>[0]} [opts]
 * @throws {Error}
 */
export function assertProPresent(opts) {
  const problems = checkProPresent(opts)
  if (problems.length) throw new Error(`${PRO_MISSING_MESSAGE} (${problems.join('; ')})`)
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

/**
 * @param {string[]} [argv]
 * @param {{ log?: (m: string) => void, error?: (m: string) => void, root?: string }} [io]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, root = ROOT } = {}) {
  let problems
  try {
    problems = checkProPresent({ root, distDir: flag(argv, '--dist-dir'), bundle: flag(argv, '--bundle') })
  } catch (err) {
    error(err.message)
    return 1
  }
  if (problems.length) {
    error(PRO_MISSING_MESSAGE)
    for (const p of problems) error(`  ${p}`)
    return 1
  }
  log('Burrow Pro module: present')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
