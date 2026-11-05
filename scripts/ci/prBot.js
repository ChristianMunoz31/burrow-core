// PR bot: sticky status comment and guarded auto-merge, run from pr-bot.yml with trusted code only
// (the workflow checks out the default branch, never the PR head). Pure decision and rendering
// functions are exported and unit tested; the CLI talks to the GitHub API.
//   node scripts/ci/prBot.js status            (env EVENT_NAME, EVENT_ACTION, HEAD_SHA, PR_NUMBER)
//   node scripts/ci/prBot.js merge --pr N --sha S
// Never logs tokens, PR titles or bodies.
import { pathToFileURL } from 'node:url'
import { evaluateTestsRequired, isWaived, verifiedLabels } from '../checks/testsRequired.js'
import { changeKinds, fromApiFile } from './changeKinds.js'
import { GhError, createApi, writeOutputs } from './ghApi.js'
import { escapeMd } from './markdown.js'
import { MAX_COVERAGE_FILES, plannedSources } from './runUnitTests.js'

export const MARKER = '<!-- burrow-pr-bot -->'
export const BOT_LOGIN = 'github-actions[bot]'
export const DEPENDABOT_LOGIN = 'dependabot[bot]'
export const DEFAULT_BRANCH = 'main'
export const HOLD_LABEL = 'hold'
export const HOLD_REASON = 'the hold label is set'
export const MAX_FILES = 3000
export const PR_BOT_JOBS = ['pr-status', 'merge', 'dependabot-hold']
export const TRUSTED_ASSOCIATIONS = ['OWNER']
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const MERGEABLE_BACKOFF_MS = [2000, 4000, 8000]
export const WAIVED_REASON = 'tests or coverage were waived; the owner merges this one'
export const PACKAGE_GATE_REASON = 'it changes package.json scripts/engines/overrides/workspaces'
export const PACKAGE_UNREADABLE_REASON = 'package.json could not be compared with the base'

export const STEP = {
  testsRequired: 'tests-required',
  coverage: 'coverage (changed files)',
  e2e: 'e2e (Playwright)',
}

export const MAX_VISUAL_NAMES = 20
export const MAX_VISUAL_NAME_LENGTH = 200

/**
 * Names of the visual snapshots that differ (or are missing) in the verify job, read from the failure
 * annotations that Playwright's github reporter writes: the title starts with `[visual]` and the message
 * holds the `__screenshots__/<spec>/<name>.png` path. No artifact is needed. Only a restricted file-name
 * charset is kept and a name longer than MAX_VISUAL_NAME_LENGTH characters is dropped (it is not a real
 * snapshot), so PR-controlled text never reaches the comment.
 * @param {{ annotation_level?: string, title?: string, message?: string }[]} annotations
 * @returns {string[]} sorted, unique, at most MAX_VISUAL_NAMES
 */
export function visualDiffNames(annotations) {
  const names = new Set()
  for (const a of Array.isArray(annotations) ? annotations : []) {
    if (a?.annotation_level !== 'failure' || !/^\[visual\]/.test(String(a.title ?? ''))) continue
    for (const m of String(a.message ?? '').matchAll(/__screenshots__[\\/]([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.png)/g)) {
      const name = m[1].replaceAll('\\', '/')
      if (name.length <= MAX_VISUAL_NAME_LENGTH && !name.split('/').some((part) => /^\.+$/.test(part))) names.add(name)
    }
  }
  return [...names].sort().slice(0, MAX_VISUAL_NAMES)
}

export const TITLE_RE = /^(feat|fix|perf|docs|chore|refactor|test|build|ci|style|revert)(\([a-z0-9._/-]+\))?!?: \S/

// Never auto-merged: a human reviews and merges these. GITHUB_TOKEN cannot merge workflow changes anyway.
// Includes every file that can weaken a check (lint, test setup, scan allowlists, coverage, build config).
export const GATE_FILES = [
  /^\.github\//,
  /^scripts\/ci\//,
  /^scripts\/checks\//,
  /^scripts\/lib\/playwrightImage\.js$/,
  /^scripts\/lib\/sandboxSafety\.js$/,
  /^\.gitleaks\.toml$/,
  /^\.gitleaksignore$/,
  /^\.githooks\//,
  /^\.npmrc$/,
  /^eslint\.config\./,
  /^vitest\.config\.js$/,
  /^vite\.config\./,
  /^playwright\.config\./,
  /^e2e\/support\//,
  /^server\/__tests__\/(setup|helpers)\//,
  /^server\/db\/migrations\.lock\.json$/,
  /^coverage\//,
  /^release-please-config\.json$/,
  /^\.release-please-manifest\.json$/,
  // release, desktop packaging and licence code, signing/updater config, secrets-handling config, container files
  /^scripts\/(release|desktop|license)\//,
  /^src-tauri\/(tauri[^/]*\.json|capabilities\/)/,
  /^src-tauri\/(src\/|Cargo\.toml$|build\.rs$)/,
  /^config\//,
  /^Dockerfile$/,
  /^compose[^/]*\.ya?ml$/,
  // shared test setup and helpers anywhere under src, plus the fake Ollama every test and sandbox uses
  /^src\/.*__tests__\/(setup|helpers)\//,
  /^src\/test-utils\//,
  /^scripts\/lib\/fakeOllamaServer\.js$/,
]

export const isGateFile = (p) => GATE_FILES.some((re) => re.test(p))

/** Gate files touched by a change (including the old name of a rename). */
export function gateFilesIn(files) {
  const paths = files.flatMap((f) => (f.previous ? [f.path, f.previous] : [f.path]))
  return [...new Set(paths.filter(isGateFile))]
}

const PACKAGE_GATE_KEYS = ['scripts', 'engines', 'overrides', 'workspaces']

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Compares two package.json texts. Only version changes in dependency maps are allowed to pass:
 * scripts (including the `prepare` and install hooks), engines, overrides and workspaces must match.
 * @returns {string | null} the human-merge reason, or null when they match
 */
export function packageJsonGate(baseText, headText) {
  let base
  let head
  try {
    base = JSON.parse(baseText)
    head = JSON.parse(headText)
  } catch {
    return PACKAGE_UNREADABLE_REASON
  }
  if (!base || !head || typeof base !== 'object' || typeof head !== 'object') return PACKAGE_UNREADABLE_REASON
  return PACKAGE_GATE_KEYS.some((k) => stable(base[k]) !== stable(head[k])) ? PACKAGE_GATE_REASON : null
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]+)?$/

function parseVersion(text) {
  const m = VERSION_RE.exec(String(text).trim())
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) } : null
}

/** Semver major, or any minor move while the major is 0 (0.x treats minor as breaking). */
export function isMajorBump(from, to) {
  if (to.major !== from.major) return true
  return from.major === 0 && to.minor !== from.minor
}

const cleanToken = (t) => t.replace(/`/g, '').replace(/[.,;:)]+$/, '')

/** Every `from X to Y` pair in free text and every `| name | from | to |` table row. */
export function extractVersionPairs(text) {
  const pairs = []
  for (const m of text.matchAll(/\bfrom\s+`?v?([0-9][0-9A-Za-z.+-]*)`?\s+to\s+`?v?([0-9][0-9A-Za-z.+-]*)`?/gi)) {
    pairs.push([cleanToken(m[1]), cleanToken(m[2])])
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.trim().split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    const [from, to] = [cells[1].replace(/`/g, ''), cells[2].replace(/`/g, '')]
    if (/^v?\d/.test(from) && /^v?\d/.test(to)) pairs.push([cleanToken(from), cleanToken(to)])
  }
  return pairs
}

/**
 * Fail-closed review of a Dependabot PR: auto-merge only when every version change in the title and
 * body is readable and none is a major bump. The body quotes third-party release notes, so any
 * major-looking pair anywhere holds the PR (a false hold is fine, a missed major is not).
 * @returns {{ ok: boolean, reason: string }}
 */
export function dependabotVerdict(title, body) {
  const pairs = extractVersionPairs(`${title ?? ''}\n${body ?? ''}`)
  if (pairs.length === 0) return { ok: false, reason: 'the Dependabot version change could not be read, so a human merges it' }
  for (const [from, to] of pairs) {
    const a = parseVersion(from)
    const b = parseVersion(to)
    if (!a || !b) return { ok: false, reason: 'the Dependabot version change could not be read, so a human merges it' }
    if (isMajorBump(a, b)) return { ok: false, reason: 'a major Dependabot update is held for a human merge' }
  }
  return { ok: true, reason: 'only minor and patch updates' }
}

const verdict = (action, kind, reason) => ({ action, kind, reason })

const GOOD_CHECK = new Set(['success', 'neutral', 'skipped'])
const GOOD_STEP = new Set(['success', 'skipped', 'neutral'])

/** Latest run by id (a re-run keeps its id; a new trigger gets a higher one). */
export function pickLatestRun(runs) {
  return [...runs].sort((a, b) => b.id - a.id)[0] ?? null
}

/** The CI runs that may be trusted for this PR: this repo, this head branch, the real ci.yml. */
export function trustedRuns(runs, repo, pr) {
  return runs.filter(
    (r) =>
      r.head_repository?.full_name === repo &&
      r.head_branch === pr.head?.ref &&
      r.head_sha === pr.head?.sha &&
      r.path === CI_WORKFLOW_PATH,
  )
}

/**
 * Why a completed CI run no longer reflects the PR base, or null.
 * @param run workflow run
 * @param pr live pull request
 * @param timeline issue timeline events
 */
export function staleReason(run, pr, timeline) {
  const ranAt = Date.parse(run.created_at)
  const moved = timeline.some((e) => e.event === 'base_ref_changed' && Date.parse(e.created_at) > ranAt)
  if (moved) return 'the base changed after CI ran; push or re-run CI'
  const tested = (run.pull_requests ?? []).find((p) => p.number === pr.number)?.base?.sha
  if (tested && pr.base?.sha && tested !== pr.base.sha) return 'the base branch moved after CI ran; update the branch to run CI again'
  return null
}

const conclusionIn = (runInfo, name) => (runInfo?.jobs?.find((j) => j.name === 'verify')?.steps ?? []).find((s) => s.name === name)?.conclusion

/**
 * Judges the CI run for a head SHA. The tests-required step is non-fatal in ci.yml and ignored here
 * (decide() evaluates it live). `coverage (changed files)` always fails below the floor (it never reads
 * the waiver); that single failure is accepted only when the live, owner-applied waiver holds and
 * nothing else failed. decide() then routes the PR to a human, never to auto-merge.
 * @param {{ run: { status: string, conclusion: string | null }, jobs: { name: string, conclusion: string | null, steps?: { name: string, conclusion: string | null }[] }[], stale?: string | null } | null} runInfo
 * @param {boolean} appChanged
 * @param {boolean} [waived] the live waiver (label and reason line) holds
 * @returns {{ ok: boolean, pending: boolean, reason: string }}
 */
export function verifyVerdict(runInfo, appChanged, waived = false) {
  if (!runInfo || !runInfo.run) return { ok: false, pending: true, reason: 'CI has not run for this commit yet' }
  if (runInfo.stale) return { ok: false, pending: true, reason: runInfo.stale }
  const { run, jobs } = runInfo
  if (run.status !== 'completed') return { ok: false, pending: true, reason: 'CI is still running' }
  const verify = jobs.find((j) => j.name === 'verify')
  const steps = verify?.steps ?? []
  const conclusionOf = (name) => steps.find((s) => s.name === name)?.conclusion
  const coverage = conclusionOf(STEP.coverage)
  const coverageWaived =
    waived &&
    coverage === 'failure' &&
    run.conclusion === 'failure' &&
    verify?.conclusion === 'failure' &&
    jobs.every((j) => j === verify || GOOD_STEP.has(j.conclusion)) &&
    steps.every((s) => s.name === STEP.coverage || s.name === STEP.testsRequired || GOOD_STEP.has(s.conclusion))
  if (run.conclusion !== 'success' && !coverageWaived) return { ok: false, pending: false, reason: `CI ${run.conclusion ?? 'did not finish'}` }
  if (!coverageWaived && (!verify || verify.conclusion !== 'success')) return { ok: false, pending: false, reason: 'the verify job did not succeed' }
  if (coverage !== 'success' && coverage !== 'skipped' && !coverageWaived) return { ok: false, pending: false, reason: 'coverage (changed files) did not pass' }
  const e2e = conclusionOf(STEP.e2e)
  if (e2e !== 'success' && !(e2e === 'skipped' && !appChanged)) return { ok: false, pending: false, reason: 'e2e (Playwright) did not pass' }
  return { ok: true, pending: false, reason: 'CI passed' }
}

/** Every other GitHub Actions check run on the SHA (for example `rust`) must be done and green. */
export function otherChecksVerdict(checkRuns) {
  const latest = new Map()
  for (const c of checkRuns) {
    if (c.app?.slug !== 'github-actions') continue
    if (c.name === 'verify' || PR_BOT_JOBS.includes(c.name)) continue
    const seen = latest.get(c.name)
    if (!seen || c.id > seen.id) latest.set(c.name, c)
  }
  for (const c of latest.values()) {
    if (c.status !== 'completed') return { ok: false, pending: true, reason: `check ${c.name} is still running` }
    if (!GOOD_CHECK.has(c.conclusion)) return { ok: false, pending: false, reason: `check ${c.name} ${c.conclusion}` }
  }
  return { ok: true, pending: false, reason: 'other checks passed' }
}

/** True when source changed without any test and the waiver is what lets it through. */
export const waiverUsed = (tr) => tr.waived && tr.sourceFiles.length > 0 && tr.testFiles.length === 0

/**
 * Whether a PR may be squash-merged right now.
 * @param pr GitHub pull request (live)
 * @param files `[{ path, status, previous? }]`
 * @param runInfo see verifyVerdict
 * @param checkRuns GitHub check runs for the head SHA
 * @param live `{ repo, labels: string[], body: string, packageGate?: string | null }`
 * @returns {{ action: 'merge' | 'none', kind: 'merge' | 'held' | 'human' | 'waiting', reason: string }}
 */
export function decide(pr, files, runInfo, checkRuns, live) {
  const human = (reason) => verdict('none', 'human', reason)
  const waiting = (reason) => verdict('none', 'waiting', reason)
  if (pr.state !== 'open') return human('the PR is not open')
  if (pr.base?.ref !== DEFAULT_BRANCH) return human(`the base branch is not ${DEFAULT_BRANCH}`)
  if (pr.head?.repo?.full_name !== live.repo) return human('the PR comes from a fork')
  if (pr.draft) return waiting('the PR is a draft')
  const login = pr.user?.login
  const headRef = pr.head?.ref ?? ''
  if (headRef.startsWith('release-please--')) return human('release PRs are merged by a human')
  if (login === BOT_LOGIN) return human('PRs opened by github-actions are merged by a human')
  const isDependabot = login === DEPENDABOT_LOGIN && pr.user?.type === 'Bot'
  if (!isDependabot && !TRUSTED_ASSOCIATIONS.includes(pr.author_association)) {
    return human('the author is not the owner or Dependabot')
  }
  if (live.labels.includes(HOLD_LABEL)) return verdict('none', 'held', HOLD_REASON)
  if (!TITLE_RE.test(pr.title ?? '')) return human('the title is not a conventional commit (type(scope): subject)')
  if (isDependabot) {
    const bumps = dependabotVerdict(pr.title, live.body)
    if (!bumps.ok) return verdict('none', 'held', bumps.reason)
  }
  if (files.length >= MAX_FILES) return human('too many changed files to check')
  const gates = gateFilesIn(files)
  if (gates.length > 0) return human(`it changes ${gates.slice(0, 3).join(', ')}${gates.length > 3 ? ' and more' : ''}`)
  if (live.packageGate) return human(live.packageGate)
  const sourceCount = plannedSources(files).length
  if (sourceCount > MAX_COVERAGE_FILES) {
    return human(`it changes ${sourceCount} source files, more than the ${MAX_COVERAGE_FILES} that coverage can check`)
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return waiting('the PR has merge conflicts')
  if (pr.mergeable === null || pr.mergeable === undefined) return waiting('mergeability is not known yet')
  const appChanged = changeKinds(files).appChanged
  const waived = isWaived(live.labels, live.body)
  const ci = verifyVerdict(runInfo, appChanged, waived)
  if (!ci.ok) return waiting(ci.reason)
  const others = otherChecksVerdict(checkRuns)
  if (!others.ok) return waiting(others.reason)
  const tr = evaluateTestsRequired({ files, labels: live.labels, body: live.body })
  if (!tr.ok) return waiting('tests-required fails with the current labels and description')
  if (waiverUsed(tr) || (waived && conclusionIn(runInfo, STEP.coverage) === 'failure')) return human(WAIVED_REASON)
  return verdict('merge', 'merge', 'all conditions met')
}

const STEP_ROWS = [
  { label: 'hygiene', match: (n) => n.startsWith('hygiene') },
  { label: 'lint', match: (n) => n === 'lint' },
  { label: STEP.testsRequired, match: (n) => n === STEP.testsRequired },
  { label: 'unit tests', match: (n) => n === 'unit tests' },
  { label: STEP.coverage, match: (n) => n === STEP.coverage },
  { label: 'build', match: (n) => n === 'build' },
  { label: 'bundle budget', match: (n) => n === 'bundle budget' },
  { label: STEP.e2e, match: (n) => n === STEP.e2e },
]

const STATE_TEXT = { success: 'passed', failure: 'FAILED', skipped: 'skipped', cancelled: 'cancelled', neutral: 'neutral', timed_out: 'timed out' }

function stateOf(entries) {
  if (entries.length === 0) return 'not run yet'
  if (entries.some((e) => e.conclusion === 'failure' || e.conclusion === 'timed_out')) return STATE_TEXT.failure
  if (entries.some((e) => !e.conclusion || e.status === 'queued' || e.status === 'in_progress')) return 'running'
  if (entries.some((e) => e.conclusion === 'cancelled')) return STATE_TEXT.cancelled
  if (entries.every((e) => e.conclusion === 'skipped')) return STATE_TEXT.skipped
  return STATE_TEXT.success
}

/**
 * Maps the verify job steps to the rows shown in the sticky comment. The tests-required row is the
 * live evaluation when given (the CI step is non-fatal and may be stale after a label edit).
 */
export function stepRows(runInfo, testsRequired = null) {
  const verify = runInfo?.jobs?.find((j) => j.name === 'verify')
  const steps = verify?.steps ?? []
  return STEP_ROWS.map(({ label, match }) => {
    if (label === STEP.testsRequired && testsRequired) {
      return { label, state: !testsRequired.ok ? STATE_TEXT.failure : waiverUsed(testsRequired) ? 'waived' : STATE_TEXT.success }
    }
    return { label, state: stateOf(steps.filter((s) => match(s.name))) }
  })
}

export function autoMergeLine({ decision, mergedSha }) {
  if (mergedSha) return `Merged as \`${String(mergedSha).slice(0, 7).replace(/[^0-9a-f]/g, '')}\``
  switch (decision.kind) {
    case 'merge':
      return 'will merge when green (all conditions are met now)'
    case 'held':
      return decision.reason === HOLD_REASON ? 'held: the `hold` label is set' : `held: ${escapeMd(decision.reason)}`
    case 'human':
      return `needs a human merge: ${escapeMd(decision.reason)}`
    default:
      return `waiting: ${escapeMd(decision.reason)}`
  }
}

/**
 * The sticky comment body. All PR-derived text is escaped; ids and SHAs are validated.
 * @param {{ sha: string, number: number, repo: string, runInfo: object | null, checkRuns: object[], decision: object, appChanged: boolean, artifact: { runId: number, id: number } | null, mergedSha?: string, testsRequired?: object | null, visualDiffs?: string[] }} input
 */
export function renderComment({ sha, number, repo, runInfo, checkRuns, decision, appChanged, artifact, mergedSha, testsRequired = null, visualDiffs = [] }) {
  const sha7 = /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : 'unknown'
  const lines = [MARKER, `### PR status for \`${sha7}\``, '', '| Step | Result |', '| --- | --- |']
  for (const row of stepRows(runInfo, testsRequired)) lines.push(`| ${row.label} | ${row.state} |`)
  const others = new Map()
  for (const c of checkRuns) {
    if (c.app?.slug !== 'github-actions' || c.name === 'verify' || PR_BOT_JOBS.includes(c.name)) continue
    if (!others.has(c.name) || c.id > others.get(c.name).id) others.set(c.name, c)
  }
  for (const c of others.values()) lines.push(`| ${escapeMd(c.name)} | ${c.status === 'completed' ? (STATE_TEXT[c.conclusion] ?? escapeMd(c.conclusion)) : 'running'} |`)
  lines.push('', `**Auto-merge:** ${autoMergeLine({ decision, mergedSha })}`, '')
  if (artifact && Number.isInteger(artifact.runId) && Number.isInteger(artifact.id)) {
    lines.push(`**Web build:** [web-dist](https://github.com/${repo}/actions/runs/${artifact.runId}/artifacts/${artifact.id}) (expires in 3 days)`)
  } else if (!appChanged) {
    lines.push('**Web build:** none (no app change)')
  } else {
    lines.push('**Web build:** not available yet')
  }
  const diffs = visualDiffs.filter((n) => n.length <= MAX_VISUAL_NAME_LENGTH && /^[A-Za-z0-9_./-]+\.png$/.test(n)).slice(0, MAX_VISUAL_NAMES)
  if (diffs.length > 0) {
    lines.push('', `**Visual snapshots that differ or are missing (${diffs.length}):**`)
    for (const name of diffs) lines.push(`- \`${name}\``)
    const runId = runInfo?.run?.id
    if (Number.isInteger(runId)) {
      lines.push(`Open the \`e2e (Playwright)\` step of [the verify job](https://github.com/${repo}/actions/runs/${runId}) for the details. If the change is intended, update the baselines (docs/PIPELINE.md, "Visual baselines without an artifact").`)
    }
  }
  lines.push(`Preview locally: \`npm run preview:branch -- "#${Number(number)}"\``)
  return lines.join('\n')
}

/** The bot's own sticky comment: authored by github-actions[bot], body starts with the marker. */
export function findSticky(comments) {
  return comments.find((c) => c.user?.login === BOT_LOGIN && typeof c.body === 'string' && c.body.startsWith(MARKER)) ?? null
}

// ---- GitHub API orchestration (thin glue over the pure functions above) ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The CI run to judge for the PR head, or null. Only runs of this repo's own ci.yml for this head
 * branch and sha count, so a run from a fork or another workflow cannot satisfy the gate. A run is
 * marked `stale` when the PR base changed after it started.
 */
export async function getRunInfo(api, repo, pr) {
  const data = await api.get(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=30`)
  const run = pickLatestRun(trustedRuns(data.workflow_runs ?? [], repo, pr))
  if (!run) return null
  const jobs = await api.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
  const timeline = await api.paginate(`/repos/${repo}/issues/${pr.number}/timeline`)
  return { run, jobs: jobs.jobs ?? [], stale: staleReason(run, pr, timeline) }
}

async function webArtifact(api, repo, runInfo) {
  if (!runInfo?.run) return null
  const data = await api.get(`/repos/${repo}/actions/runs/${runInfo.run.id}/artifacts?name=web-dist&per_page=10`)
  const found = (data.artifacts ?? []).find((a) => a.name === 'web-dist' && !a.expired)
  return found ? { runId: runInfo.run.id, id: found.id } : null
}

/** Names of the differing visual snapshots of a failed verify job; [] on any problem (never breaks the bot). */
export async function visualDiffsFor(api, repo, runInfo) {
  const verify = runInfo?.jobs?.find((j) => j.name === 'verify')
  if (!verify || !Number.isInteger(verify.id) || verify.conclusion !== 'failure') return []
  try {
    const annotations = await api.get(`/repos/${repo}/check-runs/${verify.id}/annotations?per_page=100`)
    return visualDiffNames(annotations)
  } catch {
    return []
  }
}

async function fetchPackageJson(api, repo, sha) {
  const file = await api.get(`/repos/${repo}/contents/package.json?ref=${sha}`)
  if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('package.json is not readable')
  return Buffer.from(file.content, 'base64').toString('utf8')
}

/** Null when package.json is untouched or only dependency versions changed, else the human-merge reason. */
export async function packageGateFor(api, repo, pr, files) {
  if (!files.some((f) => f.path === 'package.json' || f.previous === 'package.json')) return null
  try {
    const [base, head] = await Promise.all([fetchPackageJson(api, repo, pr.base.sha), fetchPackageJson(api, repo, pr.head.sha)])
    return packageJsonGate(base, head)
  } catch {
    return PACKAGE_UNREADABLE_REASON
  }
}

export async function gather(api, repo, number, { expectSha = null, sleepImpl = sleep, backoffMs = MERGEABLE_BACKOFF_MS } = {}) {
  let pr = await api.get(`/repos/${repo}/pulls/${number}`)
  for (const ms of backoffMs) {
    if (pr.mergeable !== null || pr.state !== 'open') break
    await sleepImpl(ms)
    pr = await api.get(`/repos/${repo}/pulls/${number}`)
  }
  if (expectSha && pr.head.sha !== expectSha) return { stale: true, pr }
  const files = (await api.paginate(`/repos/${repo}/pulls/${number}/files`)).map(fromApiFile)
  const runInfo = await getRunInfo(api, repo, pr)
  const checkRuns = await api.paginate(`/repos/${repo}/commits/${pr.head.sha}/check-runs`, { pick: (r) => r.check_runs ?? [] })
  const packageGate = await packageGateFor(api, repo, pr, files)
  // The waiver label counts only when the repo owner applied it (timeline actor); see testsRequired.js.
  const labels = await verifiedLabels(api, repo, number, (pr.labels ?? []).map((l) => l.name))
  const live = { repo, labels, body: pr.body ?? '', packageGate }
  const testsRequired = evaluateTestsRequired({ files, labels: live.labels, body: live.body })
  const decision = decide(pr, files, runInfo, checkRuns, live)
  return { stale: false, pr, files, runInfo, checkRuns, live, decision, testsRequired }
}

export async function upsertSticky(api, repo, number, body) {
  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`)
  const sticky = findSticky(comments)
  if (!sticky) return api.post(`/repos/${repo}/issues/${number}/comments`, { body })
  if (sticky.body === body) return sticky
  return api.patch(`/repos/${repo}/issues/comments/${sticky.id}`, { body })
}

async function render(api, repo, state, extra = {}) {
  const { pr, files, runInfo, checkRuns, decision, testsRequired } = state
  const appChanged = changeKinds(files).appChanged
  const artifact = appChanged ? await webArtifact(api, repo, runInfo) : null
  const visualDiffs = appChanged ? await visualDiffsFor(api, repo, runInfo) : []
  return renderComment({ sha: pr.head.sha, number: pr.number, repo, runInfo, checkRuns, decision, appChanged, artifact, testsRequired, visualDiffs, ...extra })
}

async function resolvePrNumbers(api, repo, env) {
  if (env.EVENT_NAME === 'pull_request_target') {
    return /^\d+$/.test(env.PR_NUMBER ?? '') ? [Number(env.PR_NUMBER)] : []
  }
  if (!/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? '')) return []
  const pulls = await api.get(`/repos/${repo}/commits/${env.HEAD_SHA}/pulls?per_page=30`)
  return pulls
    .filter((p) => p.state === 'open' && p.head.sha === env.HEAD_SHA && p.head.repo?.full_name === repo)
    .map((p) => p.number)
}

export async function runStatus(api, repo, env) {
  const out = { action: 'none', pr: '', sha: '' }
  for (const number of await resolvePrNumbers(api, repo, env)) {
    const state = await gather(api, repo, number)
    if (state.pr.state !== 'open') continue
    await upsertSticky(api, repo, number, await render(api, repo, state))
    if (state.decision.action === 'merge' && out.action !== 'merge') {
      out.action = 'merge'
      out.pr = number
      out.sha = state.pr.head.sha
    }
  }
  return out
}

/**
 * Deletes the merged head branch only when it is safe: same repo, not main, no other open PR from
 * it, not the base of any open PR, and the ref still points at the merged head sha.
 */
export async function deleteMergedBranch(api, repo, pr) {
  const ref = pr.head.ref
  if (pr.head.repo?.full_name !== repo || ref === DEFAULT_BRANCH) return
  const owner = repo.split('/')[0]
  const open = await api.get(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${ref}`)}&per_page=5`)
  if (open.some((p) => p.number !== pr.number)) return
  const stacked = await api.get(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(ref)}&per_page=1`)
  if (stacked.length > 0) return
  const encoded = ref.split('/').map(encodeURIComponent).join('/')
  try {
    const current = await api.get(`/repos/${repo}/git/ref/heads/${encoded}`)
    if (current?.object?.sha !== pr.head.sha) return
    await api.del(`/repos/${repo}/git/refs/heads/${encoded}`)
  } catch (err) {
    if (!(err instanceof GhError) || ![404, 422].includes(err.status)) throw err
  }
}

/** `out.merged` is set to true once GitHub accepted the merge (the workflow then starts the main run). */
export async function runMerge(api, repo, number, sha, out = { merged: false }) {
  const state = await gather(api, repo, number, { expectSha: sha })
  if (state.stale) {
    console.log('The PR head moved since the status check; skipping.')
    return 0
  }
  if (state.decision.action !== 'merge') {
    console.log(`Not merging: ${state.decision.reason}`)
    await upsertSticky(api, repo, number, await render(api, repo, state))
    return 0
  }
  try {
    const merged = await api.put(`/repos/${repo}/pulls/${number}/merge`, {
      merge_method: 'squash',
      sha,
      commit_title: `${state.pr.title} (#${number})`,
      commit_message: '',
    })
    out.merged = true
    await deleteMergedBranch(api, repo, state.pr)
    await upsertSticky(api, repo, number, await render(api, repo, state, { mergedSha: merged.sha }))
    console.log(`Merged PR #${number}.`)
  } catch (err) {
    if (err instanceof GhError && [405, 409].includes(err.status)) {
      const refused = { ...state, decision: { action: 'none', kind: 'waiting', reason: `GitHub refused the merge (HTTP ${err.status}); the head moved or the branch is not mergeable` } }
      await upsertSticky(api, repo, number, await render(api, repo, refused))
      console.log(`Merge refused with HTTP ${err.status}; not retrying.`)
      return 0
    }
    throw err
  }
  return 0
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { GH_TOKEN, GITHUB_REPOSITORY } = env
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '')) {
    console.error('prBot needs GH_TOKEN and GITHUB_REPOSITORY.')
    return 1
  }
  const api = createApi({ token: GH_TOKEN })
  if (argv[0] === 'status') {
    const out = await runStatus(api, GITHUB_REPOSITORY, env)
    writeOutputs(env.GITHUB_OUTPUT, out)
    console.log(`status: action=${out.action}${out.pr ? ` pr=${out.pr}` : ''}`)
    return 0
  }
  if (argv[0] === 'merge') {
    const pr = flag(argv, '--pr')
    const sha = flag(argv, '--sha')
    if (!/^\d+$/.test(pr ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
      console.error('merge needs --pr <number> and --sha <40 hex>.')
      return 1
    }
    const out = { merged: false }
    try {
      return await runMerge(api, GITHUB_REPOSITORY, Number(pr), sha, out)
    } finally {
      writeOutputs(env.GITHUB_OUTPUT, { merged: out.merged })
    }
  }
  console.error('Usage: prBot.js status | merge --pr N --sha S')
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof GhError ? err.message : 'prBot failed unexpectedly.')
    return 1
  })
}
