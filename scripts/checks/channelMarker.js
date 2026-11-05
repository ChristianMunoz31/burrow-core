// Fails when a build artifact is not of the channel the build meant to make. A stable release must never
// carry the dev channel, and a Burrow Dev build must be marked dev (docs/LICENSING.md 5.3; CONTRIBUTING.md
// "Dev channel"). Two kinds of target:
//   --bundle <file>    a sidecar bundle: its first line must be `/*! BURROW_CHANNEL=<expect> */`; a stable
//                      bundle must not contain the text `BURROW_CHANNEL=dev` or the developer tools marker anywhere
//   --binary <file>    a sidecar executable (SEA): every `/*! BURROW_CHANNEL=<x> */` marker found inside it must be
//                      <expect> and at least one must exist (the bundle is embedded verbatim); a stable
//                      executable must not contain the text `BURROW_CHANNEL=dev` or the developer tools marker anywhere
//   --dist-dir <dir>   a built UI folder: burrow-build-info.json must carry channel <expect> (a missing
//                      `channel` means stable) and, for dev, a version like 0.2.0-dev.20261005.abc1234; the files
//                      must also carry the developer tools UI marker exactly when --expect-dev-tools says so
// Optional --expect-dev-tools <absent|present> sets that last rule for every --dist-dir; the default follows --expect
// (stable: absent, dev: present). `npm run build:devtools` makes a stable-channel dist WITH the developer tools, so
// check it with `--expect stable --expect-dev-tools present`. A stable bundle or executable must also not contain
// the developer routes' path (DEV_TOOLS_ROUTE_MARKER).
// Optional --expect-distribution <direct|store> also checks the distribution marker of every --bundle and --binary:
// a store sidecar carries `/*! BURROW_DISTRIBUTION=store */`, a direct one carries no distribution marker. Every direct
// build path passes `direct`, so a sidecar left behind by `npm run release:store` can never be packaged into a Burrow-Setup installer.
// Optional --expect-data-location <appdata|userprofile> checks the data location marker the same way: a userprofile sidecar carries
// `/*! BURROW_DATA_LOCATION=userprofile */`, an appdata one carries none, and a direct sidecar can never carry it (checked whenever
// --expect-distribution direct is given, so a Store userprofile sidecar left behind cannot be packaged into a Burrow-Setup installer).
// Optional --expect-pro <present|absent> checks the Burrow Pro module (docs/adr/0001-open-core-split.md 3.10): a bundle or
// executable must carry `/*! BURROW_PRO=on */` (present) or `/*! BURROW_PRO=off */` (absent, and no `on` marker anywhere),
// and a built UI folder must (present) or must not (absent) contain Pro chunks `assets/pro-*.js`.
// At least one target is required. Exit code 1 on any problem. Usage:
//   node scripts/checks/channelMarker.js --expect <stable|dev> [--expect-distribution <direct|store>] [--expect-data-location <appdata|userprofile>] [--expect-dev-tools <absent|present>] [--expect-pro <present|absent>] [--bundle <file>]... [--binary <file>]... [--dist-dir <dir>]...
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUILD_INFO_FILE } from '../../server/license/constants.js'
import { CHANNELS, DEV_VERSION_RE } from '../../server/channel.js'
import { DATA_LOCATIONS } from '../../server/dataLocation.js'
import { DISTRIBUTIONS } from '../../server/distribution.js'

const MARKER_PREFIX = '/*! BURROW_CHANNEL='
const DEV_TEXT = 'BURROW_CHANNEL=dev'
export const STORE_DISTRIBUTION_MARKER = '/*! BURROW_DISTRIBUTION=store */'
export const USERPROFILE_DATA_LOCATION_MARKER = '/*! BURROW_DATA_LOCATION=userprofile */'
// Written by devtools/server/license/devOverride.js and devtools/ui/DeveloperSection.jsx only (the developer tier
// switcher). A stable artifact must not contain it. The server never imports from scripts/, so the text lives in
// both places and devToolsBuild.test.js ties them together.
export const DEV_TOOLS_MARKER = 'BURROW_DEV_TOOLS=on'
// The developer routes' path: core server/ and src/ must not contain it (devToolsBuild.test.js), nor any stable artifact.
export const DEV_TOOLS_ROUTE_MARKER = '/dev/license'
const DEV_TOOLS_MARKERS = [DEV_TOOLS_MARKER, DEV_TOOLS_ROUTE_MARKER]
const SCAN_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.map'])
const DEV_TOOLS_EXPECTATIONS = ['absent', 'present']
const MARKER_RE = /\/\*! BURROW_CHANNEL=([A-Za-z0-9_-]*) \*\//g
export const PRO_ON_MARKER = '/*! BURROW_PRO=on */'
export const PRO_OFF_MARKER = '/*! BURROW_PRO=off */'
const PRO_EXPECTATIONS = ['present', 'absent']
const PRO_CHUNK_RE = /^pro-.*\.js$/

/**
 * @param {string} text bundle source
 * @param {'stable' | 'dev'} expect
 * @returns {string[]} problems, empty when the bundle is right
 */
export function checkBundleText(text, expect) {
  const problems = []
  const firstLine = String(text).split(/\r?\n/, 1)[0]
  const wanted = `${MARKER_PREFIX}${expect} */`
  if (firstLine !== wanted) {
    problems.push(`first line is not the channel marker ${wanted} (found: ${firstLine.slice(0, 60) || 'empty'})`)
  }
  if (expect === 'stable' && String(text).includes(DEV_TEXT)) {
    problems.push(`a stable bundle must not contain "${DEV_TEXT}"`)
  }
  for (const marker of DEV_TOOLS_MARKERS) {
    if (expect === 'stable' && String(text).includes(marker)) {
      problems.push(`a stable bundle must not contain the developer tools ("${marker}")`)
    }
  }
  return problems
}

/**
 * @param {Buffer} bytes a sidecar executable
 * @param {'stable' | 'dev'} expect
 * @returns {string[]} problems, empty when the executable carries only the expected channel marker
 */
export function checkBinaryChannel(bytes, expect) {
  const problems = []
  const text = bytes.toString('latin1')
  const found = [...text.matchAll(MARKER_RE)].map((m) => m[1])
  if (found.length === 0) problems.push('no channel marker found in the executable')
  const wrong = [...new Set(found.filter((channel) => channel !== expect))]
  if (wrong.length > 0) problems.push(`the executable carries channel "${wrong.join('", "')}", expected "${expect}"`)
  if (expect === 'stable' && text.includes(DEV_TEXT)) problems.push(`a stable executable must not contain "${DEV_TEXT}"`)
  for (const marker of DEV_TOOLS_MARKERS) {
    if (expect === 'stable' && text.includes(marker)) {
      problems.push(`a stable executable must not contain the developer tools ("${marker}")`)
    }
  }
  return problems
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full
  }
}

/**
 * @param {string} dir a built UI folder
 * @returns {string[]} dir-relative paths (forward slashes) of the .js .css .html .json .map files that carry a developer tools marker
 * @throws {Error} when the folder cannot be read
 */
export function scanDevToolsMarkers(dir) {
  const found = []
  for (const file of walkFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8')
    if (DEV_TOOLS_MARKERS.some((marker) => text.includes(marker))) found.push(path.relative(dir, file).split(path.sep).join('/'))
  }
  return found
}

/**
 * @param {string} dir a built UI folder
 * @returns {boolean} whether the developer tools UI marker (the one DeveloperSection renders) is in it
 */
export function distHasDevTools(dir) {
  for (const file of walkFiles(dir)) if (fs.readFileSync(file, 'utf8').includes(DEV_TOOLS_MARKER)) return true
  return false
}

/**
 * @param {string} dir a built UI folder
 * @param {'absent' | 'present'} expect
 * @returns {string[]} problems, empty when the folder has (present) or has not (absent) the developer tools UI
 */
export function checkDistDevTools(dir, expect) {
  try {
    if (expect === 'absent') {
      const found = scanDevToolsMarkers(dir)
      return found.length > 0 ? [`the UI carries the developer tools (${found.slice(0, 5).join(', ')}); rebuild it with npm run build`] : []
    }
    return distHasDevTools(dir) ? [] : ['the UI has no developer tools (marker not found); build it with npm run build:devtools or BURROW_CHANNEL=dev']
  } catch {
    return ['the UI folder could not be scanned for the developer tools']
  }
}

/**
 * @param {string | Buffer} content a sidecar bundle (text) or executable (bytes)
 * @param {'direct' | 'store'} expect
 * @returns {string[]} problems, empty when the presence of the store distribution marker matches `expect`
 */
export function checkDistribution(content, expect) {
  const text = typeof content === 'string' ? content : content.toString('latin1')
  const isStore = text.includes(STORE_DISTRIBUTION_MARKER)
  if (expect === 'direct' && isStore) return ['this is a Microsoft Store (distribution=store) build and must not be packaged as a direct installer; rebuild the sidecar without --distribution store']
  if (expect === 'direct' && text.includes(USERPROFILE_DATA_LOCATION_MARKER)) return ['this build keeps its data in the user profile folder (data location userprofile), which only the Microsoft Store build may do; rebuild the sidecar without --data-location userprofile']
  if (expect === 'store' && !isStore) return ['no store distribution marker; this is not a Microsoft Store build']
  return []
}

/**
 * @param {string | Buffer} content a sidecar bundle (text) or executable (bytes)
 * @param {'appdata' | 'userprofile'} expect
 * @returns {string[]} problems, empty when the presence of the userprofile data location marker matches `expect`
 */
export function checkDataLocationMarker(content, expect) {
  const text = typeof content === 'string' ? content : content.toString('latin1')
  const isProfile = text.includes(USERPROFILE_DATA_LOCATION_MARKER)
  if (expect === 'appdata' && isProfile) return ['this build keeps its data in the user profile folder (data location userprofile), expected appdata']
  if (expect === 'userprofile' && !isProfile) return ['no userprofile data location marker; this build keeps its data in the AppData folder']
  if (expect === 'userprofile' && !text.includes(STORE_DISTRIBUTION_MARKER)) return ['a userprofile data location is only valid together with the store distribution marker']
  return []
}

/**
 * @param {string | Buffer} content a sidecar or worker bundle (text) or executable (bytes)
 * @param {'present' | 'absent'} expect
 * @returns {string[]} problems, empty when the Pro marker matches `expect`
 */
export function checkProMarker(content, expect) {
  const text = typeof content === 'string' ? content : content.toString('latin1')
  const on = text.includes(PRO_ON_MARKER)
  const off = text.includes(PRO_OFF_MARKER)
  if (expect === 'present') {
    if (!on) return ['no BURROW_PRO=on marker: this build does not include the Pro module']
    if (off) return ['the build mixes bundles with and without the Pro module (BURROW_PRO=off found)']
    return []
  }
  if (on) return ['this build includes the Pro module (BURROW_PRO=on), expected a build without it']
  if (!off) return ['no BURROW_PRO=off marker found']
  return []
}

/**
 * @param {string} dir a built UI folder
 * @returns {string[]} names of the Pro chunks (assets/pro-*.js)
 */
export function listProChunks(dir) {
  const assets = path.join(dir, 'assets')
  if (!fs.existsSync(assets)) return []
  return fs.readdirSync(assets).filter((name) => PRO_CHUNK_RE.test(name))
}

/**
 * @param {string} dir a built UI folder
 * @param {'present' | 'absent'} expect
 * @returns {string[]} problems, empty when the folder has (present) or has not (absent) the Pro UI chunks
 */
export function checkDistPro(dir, expect) {
  let chunks
  try {
    chunks = listProChunks(dir)
  } catch {
    return ['the UI folder could not be scanned for Pro chunks']
  }
  if (expect === 'present' && chunks.length === 0) return ['the UI has no Pro chunks (assets/pro-*.js); build it with the Pro module checked out']
  if (expect === 'absent' && chunks.length > 0) return [`the UI carries Pro chunks (${chunks.slice(0, 5).join(', ')}); rebuild it without the Pro module`]
  return []
}

/**
 * @param {unknown} info parsed burrow-build-info.json
 * @param {'stable' | 'dev'} expect
 * @returns {string[]} problems, empty when the build info is right
 */
export function checkBuildInfo(info, expect) {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return ['build info is not an object']
  const problems = []
  const channel = info.channel ?? 'stable'
  if (channel !== expect) problems.push(`build info channel is "${String(channel)}", expected "${expect}"`)
  if (expect === 'dev' && !(typeof info.version === 'string' && DEV_VERSION_RE.test(info.version))) {
    problems.push(`build info version "${String(info.version)}" is not a dev version like 0.2.0-dev.20261005.abc1234`)
  }
  return problems
}

function parseArgs(argv) {
  const out = { expect: null, expectDistribution: null, expectDataLocation: null, expectDevTools: null, expectPro: null, bundles: [], binaries: [], distDirs: [], error: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== '--expect' && flag !== '--expect-distribution' && flag !== '--expect-data-location' && flag !== '--expect-dev-tools' && flag !== '--expect-pro' && flag !== '--bundle' && flag !== '--binary' && flag !== '--dist-dir') {
      out.error = `Unknown argument: ${flag}`
      return out
    }
    if (!value || value.startsWith('--')) {
      out.error = `${flag} needs a value`
      return out
    }
    i += 1
    if (flag === '--expect') out.expect = value
    else if (flag === '--expect-distribution') out.expectDistribution = value
    else if (flag === '--expect-data-location') out.expectDataLocation = value
    else if (flag === '--expect-dev-tools') out.expectDevTools = value
    else if (flag === '--expect-pro') out.expectPro = value
    else if (flag === '--bundle') out.bundles.push(value)
    else if (flag === '--binary') out.binaries.push(value)
    else out.distDirs.push(value)
  }
  return out
}

/**
 * @param {string[]} [argv]
 * @param {{ log?: (m: string) => void, error?: (m: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv)
  if (args.error) {
    error(args.error)
    return 1
  }
  if (!CHANNELS.includes(args.expect)) {
    error(`--expect must be one of ${CHANNELS.join(', ')}`)
    return 1
  }
  if (args.expectDistribution !== null && !DISTRIBUTIONS.includes(args.expectDistribution)) {
    error(`--expect-distribution must be one of ${DISTRIBUTIONS.join(', ')}`)
    return 1
  }
  if (args.expectDataLocation !== null && !DATA_LOCATIONS.includes(args.expectDataLocation)) {
    error(`--expect-data-location must be one of ${DATA_LOCATIONS.join(', ')}`)
    return 1
  }
  if (args.expectDevTools !== null && !DEV_TOOLS_EXPECTATIONS.includes(args.expectDevTools)) {
    error(`--expect-dev-tools must be one of ${DEV_TOOLS_EXPECTATIONS.join(', ')}`)
    return 1
  }
  if (args.expectPro !== null && !PRO_EXPECTATIONS.includes(args.expectPro)) {
    error(`--expect-pro must be one of ${PRO_EXPECTATIONS.join(', ')}`)
    return 1
  }
  const proChecks = (content) => (args.expectPro ? checkProMarker(content, args.expectPro) : [])
  const devToolsExpected = args.expectDevTools ?? (args.expect === 'stable' ? 'absent' : 'present')
  if (args.bundles.length === 0 && args.binaries.length === 0 && args.distDirs.length === 0) {
    error('Nothing to check: pass at least one --bundle <file>, --binary <file> or --dist-dir <dir>.')
    return 1
  }
  let failed = false
  const report = (target, problems) => {
    if (problems.length === 0) {
      log(`channel ok (${args.expect}): ${target}`)
      return
    }
    failed = true
    for (const problem of problems) error(`channel check failed: ${target}: ${problem}`)
  }
  for (const file of args.bundles) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      report(file, [...checkBundleText(text, args.expect), ...(args.expectDistribution ? checkDistribution(text, args.expectDistribution) : []), ...(args.expectDataLocation ? checkDataLocationMarker(text, args.expectDataLocation) : []), ...proChecks(text)])
    } catch {
      report(file, ['the bundle could not be read'])
    }
  }
  for (const file of args.binaries) {
    try {
      const bytes = fs.readFileSync(file)
      report(file, [...checkBinaryChannel(bytes, args.expect), ...(args.expectDistribution ? checkDistribution(bytes, args.expectDistribution) : []), ...(args.expectDataLocation ? checkDataLocationMarker(bytes, args.expectDataLocation) : []), ...proChecks(bytes)])
    } catch {
      report(file, ['the executable could not be read'])
    }
  }
  for (const dir of args.distDirs) {
    const file = path.join(dir, BUILD_INFO_FILE)
    let problems
    try {
      problems = checkBuildInfo(JSON.parse(fs.readFileSync(file, 'utf8')), args.expect)
    } catch {
      problems = ['the build info file is missing or not valid JSON']
    }
    report(file, [...problems, ...checkDistDevTools(dir, devToolsExpected), ...(args.expectPro ? checkDistPro(dir, args.expectPro) : [])])
  }
  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
