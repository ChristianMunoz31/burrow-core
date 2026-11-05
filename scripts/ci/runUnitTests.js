// Runs the unit tests once for CI, with coverage limited to the changed source files.
//  - FULL_SUITE=true, or a removed/renamed src/server JS file: `vitest run` (everything).
//  - otherwise: `vitest run --changed <BASE_SHA>` (tests affected by the PR, found through the import
//    graph), then `vitest run` on the repo-scanning tests (ALWAYS_RUN) that no import graph connects to
//    the change. Without a valid BASE_SHA the plan falls back to the full suite.
// Main runs the full suite sharded (ci.yml, job main-unit; a bot merge starts it through a workflow_dispatch), flaky.yml runs it weekly and release.yml
// runs it before every release.
// Usage (CI): FULL_SUITE=true|false BASE_SHA=<40 hex> CHANGED_JSON=<path> node scripts/ci/runUnitTests.js
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../checks/gitFiles.js'
import { removesSource } from './changeKinds.js'

export const ALWAYS_RUN_MARKER = '// ci:always-run'
export const MAX_COVERAGE_FILES = 200

// Tests that read the source tree (architecture guards, parity checks, repo scans). A change can
// break them without any import edge, so they run on every PR. Any other test can opt in with the
// marker comment on its own line; this list covers the ones that exist today.
export const ALWAYS_RUN = [
  'server/__tests__/aiBoundary.test.js',
  'server/__tests__/cloudAiParity.test.js',
  'server/__tests__/cloudRestore.test.js',
  'server/__tests__/javiDashesParity.test.js',
  'server/__tests__/javiPagesParity.test.js',
  'server/__tests__/relativeDayParity.test.js',
  'server/__tests__/migrationSafety.test.js',
  'server/__tests__/checksScripts.test.js',
  'server/__tests__/ciPipeline.test.js',
  'server/__tests__/license/noPrivateKeys.test.js',
  'server/__tests__/license/scripts.test.js',
]

// pro/ is the optional nested Pro repo (present only where it is checked out; CI runs without it).
const isVitestFile = (p) => /^(src|server|devtools|pro\/(ui|server))\/.+\.(js|jsx)$/.test(p) || p === 'server.js'

const isTestPath = (p) => /(^|\/)__tests__\//.test(p) || /\.test\.(js|jsx)$/.test(p)

const SHA_RE = /^[0-9a-f]{40}$/

/** Source files that coverage is measured on for a change (the same list planUnitTests uses). */
export function plannedSources(files) {
  const live = files.filter((f) => f.status !== 'removed' && isVitestFile(f.path))
  return live.map((f) => f.path).filter((p) => !isTestPath(p) && p !== 'src/main.jsx')
}

/**
 * Builds the vitest argument lists for a change.
 * `baseSha` is the pull request base commit; anything but 40 hex characters means "run everything".
 * @param {{ files: { path: string, status: string }[], fullSuite: boolean, alwaysRun: string[], baseSha?: string }} input
 * @returns {{ mode: 'full' | 'changed', coverageInclude: string[], runs: string[][] }}
 */
export function planUnitTests({ files, fullSuite, alwaysRun, baseSha = '' }) {
  const live = files.filter((f) => f.status !== 'removed' && isVitestFile(f.path))
  const sources = plannedSources(files)
  const coverageInclude = sources.length > 0 && sources.length <= MAX_COVERAGE_FILES ? sources : []
  const coverageArgs = coverageInclude.length > 0 ? ['--coverage.enabled', ...coverageInclude.map((p) => `--coverage.include=${p}`)] : []
  if (fullSuite || removesSource(files) || !SHA_RE.test(baseSha)) return { mode: 'full', coverageInclude, runs: [['run', ...coverageArgs]] }
  const runs = []
  if (live.length > 0) runs.push(['run', '--changed', baseSha, '--passWithNoTests', ...coverageArgs])
  if (alwaysRun.length > 0) runs.push(['run', ...alwaysRun])
  return { mode: 'changed', coverageInclude, runs }
}

/** Test files that carry the always-run marker (scanned under src/, server/, devtools/ and, when present, pro/). */
export function scanAlwaysRun(root = REPO_ROOT) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.test\.(js|jsx)$/.test(entry.name) && readFileSync(full, 'utf8').split('\n').some((l) => l.trim() === ALWAYS_RUN_MARKER)) {
        found.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  for (const top of ['src', 'server', 'devtools', 'pro']) if (existsSync(path.join(root, top))) walk(path.join(root, top))
  return found
}

/** Removes a stale coverage folder, so changedCoverage can only read output from this run. */
export function cleanCoverage(root = REPO_ROOT) {
  rmSync(path.join(root, 'coverage'), { recursive: true, force: true })
}

export function main(env = process.env) {
  cleanCoverage()
  if (!env.CHANGED_JSON) {
    console.error('runUnitTests needs CHANGED_JSON.')
    return 1
  }
  const files = JSON.parse(readFileSync(env.CHANGED_JSON, 'utf8'))
  const alwaysRun = [...new Set([...ALWAYS_RUN, ...scanAlwaysRun()])].sort()
  const plan = planUnitTests({ files, fullSuite: env.FULL_SUITE === 'true', alwaysRun, baseSha: env.BASE_SHA ?? '' })
  console.log(`unit tests: ${plan.mode} mode, ${plan.runs.length} vitest run(s)`)
  const bin = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  for (const args of plan.runs) {
    const res = spawnSync(process.execPath, [bin, ...args], { cwd: REPO_ROOT, stdio: 'inherit', shell: false })
    if (res.status !== 0) return res.status ?? 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
