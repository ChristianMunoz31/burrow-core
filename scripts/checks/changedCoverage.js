// Line-coverage floor for the source files a pull request changed (not global coverage).
// Reads coverage/coverage-summary.json (vitest json-summary). The aggregate covered/total lines over
// changed src|server js files must be at least 60%. The step FAILS below the floor or when the summary
// is missing; it never reads the waiver. The PR bot (scripts/ci/prBot.js) decides live: it accepts that
// one failure only with an owner-applied no-tests-needed waiver, and then routes the PR to a human merge.
// More than MAX_COVERAGE_FILES changed sources are not measured (runUnitTests turns coverage off): skipped with a note.
// Usage (CI): CHANGED_JSON=<path> node scripts/checks/changedCoverage.js
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { escapeMd } from '../ci/markdown.js'
import { MAX_COVERAGE_FILES, plannedSources } from '../ci/runUnitTests.js'
import { REPO_ROOT } from './gitFiles.js'
import { isTestFile } from './testsRequired.js'

export const COVERAGE_FLOOR = 60
const SUMMARY = path.join(REPO_ROOT, 'coverage', 'coverage-summary.json')

/** Changed application source files that coverage applies to. */
export function coverageTargets(files) {
  return files
    .filter((f) => f.status !== 'removed' && /^(src|server)\/.+\.(js|jsx)$/.test(f.path))
    .filter((f) => !isTestFile(f.path) && f.path !== 'src/main.jsx')
    .map((f) => f.path)
}

/** Summary keys are absolute paths; reduce them to repo-relative forward-slash paths. */
export function relativizeSummary(summary, root = REPO_ROOT) {
  const out = new Map()
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue
    out.set(path.relative(root, key).split(path.sep).join('/'), value)
  }
  return out
}

/**
 * @param {string[]} targets changed source files
 * @param {Map<string, { lines: { total: number, covered: number } }>} byFile
 */
export function evaluateCoverage(targets, byFile, floor = COVERAGE_FLOOR) {
  const rows = []
  const missing = []
  let total = 0
  let covered = 0
  for (const file of targets) {
    const entry = byFile.get(file)
    if (!entry) {
      missing.push(file)
      continue
    }
    if (entry.lines.total === 0) continue
    total += entry.lines.total
    covered += entry.lines.covered
    rows.push({ file, covered: entry.lines.covered, total: entry.lines.total, pct: (entry.lines.covered / entry.lines.total) * 100 })
  }
  const pct = total === 0 ? null : (covered / total) * 100
  return { ok: pct === null || pct >= floor, pct, covered, total, rows, missing, floor }
}

export function toMarkdown(result) {
  const lines = ['### Coverage of changed files', '']
  if (result.pct === null) {
    lines.push('No executable lines in the changed source files.')
    return lines.join('\n')
  }
  lines.push('| File | Lines | Covered |', '| --- | ---: | ---: |')
  for (const r of result.rows) lines.push(`| ${escapeMd(r.file)} | ${r.covered}/${r.total} | ${r.pct.toFixed(1)}% |`)
  lines.push('', `Aggregate: ${result.covered}/${result.total} lines, ${result.pct.toFixed(1)}% (floor ${result.floor}%).`)
  if (result.missing.length > 0) lines.push('', `Not in the coverage report (skipped): ${result.missing.map((f) => escapeMd(f)).join(', ')}`)
  if (!result.ok) {
    lines.push('', 'Below the floor: add tests. This step fails; the owner can waive it with the no-tests-needed label, and then a human merges.')
  }
  return lines.join('\n')
}

export function main(env = process.env, summaryPath = SUMMARY) {
  const { CHANGED_JSON } = env
  if (!CHANGED_JSON) {
    console.error('changedCoverage needs CHANGED_JSON.')
    return 1
  }
  const changed = JSON.parse(readFileSync(CHANGED_JSON, 'utf8'))
  const targets = coverageTargets(changed)
  let table
  let code = 0
  const header = '### Coverage of changed files\n\n'
  if (targets.length === 0) {
    table = `${header}No changed application source files.`
  } else if (plannedSources(changed).length > MAX_COVERAGE_FILES) {
    console.warn(`::notice title=Coverage floor skipped::More than ${MAX_COVERAGE_FILES} changed source files; coverage is not measured per file.`)
    table = `${header}Skipped: more than ${MAX_COVERAGE_FILES} changed source files, so coverage was not measured for this change.`
  } else if (!existsSync(summaryPath)) {
    console.error('coverage/coverage-summary.json is missing: the unit test step did not produce coverage.')
    table = `${header}No coverage summary was produced. This step fails; the owner can waive it (no-tests-needed label), and then a human merges.`
    code = 1
  } else {
    const result = evaluateCoverage(targets, relativizeSummary(JSON.parse(readFileSync(summaryPath, 'utf8'))))
    table = toMarkdown(result)
    if (!result.ok) code = 1
  }
  console.log(table)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`)
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
