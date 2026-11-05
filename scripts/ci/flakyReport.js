// Tally and report for the weekly flaky hunt (flaky.yml).
//   node scripts/ci/flakyReport.js tally   (env RUN_DIR, OUT_DIR, RUNS, FAILED_RUNS, PROJECT, RUNNER_OS_INPUT, GITHUB_SHA)
//     reads run-<n>.json (vitest json reporter), writes OUT_DIR/report.json and the step summary
//   node scripts/ci/flakyReport.js report  (env GH_TOKEN, GITHUB_REPOSITORY, REPORT_FILE, RUN_URL, FLAKY_RESULT)
//     creates or updates the open issue "Flaky tests on main" (labelled flaky, authored by github-actions[bot])
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BOT_LOGIN } from './prBot.js'
import { GhError, createApi } from './ghApi.js'
import { escapeMd } from './markdown.js'

export const ISSUE_TITLE = 'Flaky tests on main'
export const ISSUE_LABEL = 'flaky'

/** Failing test lines (`<file> :: <full name>`) from one vitest JSON result. */
export function collectFailures(result, cwd = '') {
  const lines = []
  for (const file of result.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'failed') lines.push(`${String(file.name).replace(cwd, '').replace(/\\/g, '/')} :: ${t.fullName}`)
    }
  }
  return lines
}

/** Counts how many runs each test failed in, most frequent first. */
export function tally(lines) {
  const counts = new Map()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return [...counts.entries()].map(([test, count]) => ({ test, count })).sort((a, b) => b.count - a.count || a.test.localeCompare(b.test))
}

export const isHardFailure = (report) => report.runs > 0 && report.failedRuns === report.runs

export function summaryMarkdown(report) {
  const lines = [`### Flaky hunt: ${report.failedRuns} of ${report.runs} runs failed (${escapeMd(report.project)}, ${escapeMd(report.os)})`, '']
  if (report.rows.length === 0) return [...lines, 'No failing tests recorded.'].join('\n')
  lines.push('| Failures | Test |', '| ---: | --- |')
  for (const r of report.rows) lines.push(`| ${r.count} | ${escapeMd(r.test, 200)} |`)
  return lines.join('\n')
}

/** Issue body: date, run link, verdict and the failure table. */
export function buildReportBody({ date, runUrl, report }) {
  const verdict = isHardFailure(report)
    ? `Failing on main, not flaky: all ${report.runs} runs failed.`
    : `${report.failedRuns} of ${report.runs} runs failed.`
  const lines = [`Last updated: ${date}`, `Run: ${runUrl}`, `Commit: \`${String(report.sha ?? '').slice(0, 7).replace(/[^0-9a-f]/g, '')}\``, '', `**${verdict}**`, '']
  if (report.rows.length === 0) lines.push('No failing tests were recorded (the run failed outside the tests).')
  else {
    lines.push('| Failures | Test |', '| ---: | --- |')
    for (const r of report.rows) lines.push(`| ${r.count} | ${escapeMd(r.test, 200)} |`)
  }
  return lines.join('\n')
}

export function buildComment({ date, runUrl, report }) {
  if (!report) return `${date}: the flaky run failed before it produced a report. ${runUrl}`
  if (report.failedRuns === 0) return `${date}: clean run, ${report.runs} of ${report.runs} passed. ${runUrl}`
  return `${date}: ${isHardFailure(report) ? 'failing on main, not flaky' : `${report.failedRuns} of ${report.runs} runs failed`}. ${runUrl}`
}

export function findFlakyIssue(issues) {
  return issues.find((i) => !i.pull_request && i.user?.login === BOT_LOGIN && i.title === ISSUE_TITLE) ?? null
}

function runTally(env) {
  const dir = env.RUN_DIR
  const lines = []
  for (const name of readdirSync(dir).filter((n) => /^run-\d+\.json$/.test(n))) {
    lines.push(...collectFailures(JSON.parse(readFileSync(path.join(dir, name), 'utf8')), process.cwd()))
  }
  const report = {
    runs: Number(env.RUNS),
    failedRuns: Number(env.FAILED_RUNS),
    project: env.PROJECT ?? 'all',
    os: env.RUNNER_OS_INPUT ?? 'ubuntu-latest',
    sha: env.GITHUB_SHA ?? '',
    rows: tally(lines),
  }
  mkdirSync(env.OUT_DIR, { recursive: true })
  writeFileSync(path.join(env.OUT_DIR, 'report.json'), JSON.stringify(report))
  const md = summaryMarkdown(report)
  console.log(md)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`)
  return 0
}

async function runReport(env) {
  const { GH_TOKEN, GITHUB_REPOSITORY: repo, REPORT_FILE, RUN_URL } = env
  const api = createApi({ token: GH_TOKEN })
  const report = REPORT_FILE && existsSync(REPORT_FILE) ? JSON.parse(readFileSync(REPORT_FILE, 'utf8')) : null
  const failed = report ? report.failedRuns > 0 : env.FLAKY_RESULT !== 'success'
  const date = new Date().toISOString().slice(0, 10)
  const issues = await api.get(`/repos/${repo}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`)
  const issue = findFlakyIssue(issues)
  if (!failed) {
    if (issue) await api.post(`/repos/${repo}/issues/${issue.number}/comments`, { body: buildComment({ date, runUrl: RUN_URL, report }) })
    return 0
  }
  const body = report ? buildReportBody({ date, runUrl: RUN_URL, report }) : `Last updated: ${date}\nRun: ${RUN_URL}\n\nThe flaky run failed before it produced a report.`
  let number = issue?.number
  if (issue) await api.patch(`/repos/${repo}/issues/${number}`, { body })
  else number = (await api.post(`/repos/${repo}/issues`, { title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] })).number
  await api.post(`/repos/${repo}/issues/${number}/comments`, { body: buildComment({ date, runUrl: RUN_URL, report }) })
  return 0
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === 'tally') return runTally(env)
  if (argv[0] === 'report') {
    if (!env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.RUN_URL) {
      console.error('report needs GH_TOKEN, GITHUB_REPOSITORY and RUN_URL.')
      return 1
    }
    return runReport(env)
  }
  console.error('Usage: flakyReport.js tally | report')
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof GhError ? err.message : 'flakyReport failed unexpectedly.')
    return 1
  })
}
