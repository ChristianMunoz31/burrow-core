// Writes dist/burrow-build-info.json (docs/LICENSING.md section 6.2). Runs as `postbuild`, because
// `vite build` empties dist/ first. `--check` validates an existing file for the release workflow.
// The file also records the channel (BURROW_CHANNEL: unset or stable, or dev). A dev build takes its version
// from BURROW_DISPLAY_VERSION, which is required and must look like 0.2.0-dev.20261005.abc1234. The channel is
// for build checks only (scripts/checks/channelMarker.js): the runtime never reads it from this file.
// Usage: node scripts/license/writeBuildInfo.js [--check] [--dist-dir <dir>]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BUILD_INFO_FILE, formatLicenseDate, parseLicenseDate } from '../../server/license/constants.js'
import { loadBuildInfo } from '../../server/license/buildInfo.js'
import { DEV_VERSION_RE, resolveBuildChannel } from '../../server/channel.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function gitCommitDate(repoRoot) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], {
      cwd: repoRoot,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!/^\d{1,12}$/.test(out)) return null
    const iso = formatLicenseDate(Number(out) * 1000)
    return parseLicenseDate(iso) === null ? null : iso
  } catch {
    return null
  }
}

/**
 * Build date precedence: BURROW_BUILD_DATE env, then the HEAD commit time, then the clock.
 * @param {{ env?: Record<string, string | undefined>, repoRoot?: string, now?: () => number, git?: (root: string) => string | null }} [opts]
 * @returns {{ buildDate: string, source: 'env' | 'git' | 'clock' }}
 * @throws {Error} when BURROW_BUILD_DATE is set but invalid
 */
export function resolveBuildDate({ env = process.env, repoRoot = REPO_ROOT, now = Date.now, git = gitCommitDate } = {}) {
  const fromEnv = (env.BURROW_BUILD_DATE || '').trim()
  if (fromEnv) {
    if (parseLicenseDate(fromEnv) === null) {
      throw new Error('BURROW_BUILD_DATE must look like 2026-10-05T12:00:00Z (UTC, whole seconds, 2024 to 2999).')
    }
    return { buildDate: fromEnv, source: 'env' }
  }
  const fromGit = git(repoRoot)
  if (fromGit) return { buildDate: fromGit, source: 'git' }
  return { buildDate: formatLicenseDate(now()), source: 'clock' }
}

function readVersion(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
}

/**
 * Channel and version for the build info file.
 * @param {Record<string, string | undefined>} vars the build environment
 * @param {string} packageVersion
 * @returns {{ channel: 'stable' | 'dev', version: string }}
 * @throws {Error} on an unknown BURROW_CHANNEL, or a dev build without a valid BURROW_DISPLAY_VERSION
 */
export function resolveChannelInfo(vars, packageVersion) {
  const channel = resolveBuildChannel(vars)
  if (channel === 'stable') return { channel, version: packageVersion }
  const display = (vars.BURROW_DISPLAY_VERSION ?? '').trim()
  if (!DEV_VERSION_RE.test(display)) {
    throw new Error('A dev build needs BURROW_DISPLAY_VERSION like 0.2.0-dev.20261005.abc1234.')
  }
  return { channel, version: display }
}

/**
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string | undefined>, repoRoot?: string, now?: () => number, git?: (root: string) => string | null, log?: (m: string) => void, error?: (m: string) => void }} [opts]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), { repoRoot = REPO_ROOT, env = process.env, log = console.log, error = console.error, ...rest } = {}) {
  const dirIdx = argv.indexOf('--dist-dir')
  const distDir = dirIdx >= 0 && argv[dirIdx + 1] ? path.resolve(argv[dirIdx + 1]) : path.join(repoRoot, 'dist')

  if (argv.includes('--check')) {
    const info = loadBuildInfo({ distDir, bundled: null })
    if (info.source !== 'env' && info.source !== 'git') {
      error(`license build info check failed: ${path.join(distDir, BUILD_INFO_FILE)} is ${info.source === 'clock' ? 'stamped from the clock' : 'missing or invalid'}.`)
      return 1
    }
    log(`license build info ok (${info.source}, ${info.buildDateIso})`)
    return 0
  }

  let resolved
  let channelInfo
  try {
    resolved = resolveBuildDate({ repoRoot, env, ...rest })
    channelInfo = resolveChannelInfo(env, readVersion(repoRoot))
  } catch (err) {
    error(err.message)
    return 1
  }
  const body = {
    formatVersion: 1,
    buildDate: resolved.buildDate,
    source: resolved.source,
    version: channelInfo.version,
    channel: channelInfo.channel,
  }
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(distDir, BUILD_INFO_FILE), `${JSON.stringify(body)}\n`)
  log(`license build info written (${resolved.source}, ${resolved.buildDate}, ${channelInfo.channel})`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
