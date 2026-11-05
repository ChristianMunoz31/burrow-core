// Fails a pull request that changes application source without touching any test, unless the PR
// carries the `no-tests-needed` label AND a body line `No tests needed because: <reason>` (at least
// 10 characters; HTML comments in the body are ignored, so the template hint does not count).
// Labels and body are fetched live, so a re-run after editing the PR sees the waiver. The label only
// counts when the repo OWNER applied it (issue timeline `labeled` event actor); a label added by anyone
// else, including a workflow token, is ignored. Limit: this identifies the GitHub account, so an agent
// that runs `gh` with the owner's own login still looks like the owner; ship-feature.md forbids that.
// Usage (CI): GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, CHANGED_JSON=<path to changed.json> node scripts/checks/testsRequired.js
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createApi } from '../ci/ghApi.js'

export const WAIVER_LABEL = 'no-tests-needed'
export const WAIVER_MARKER = 'No tests needed because:'
const MIN_REASON = 10

// e2e counts only for real spec files: not screenshots, fixtures or support code.
const TEST_RE = [/(^|\/)__tests__\//, /\.test\.(js|jsx)$/, /^e2e\/(?!support\/).+\.(spec|test)\.(js|mjs|ts)$/]
const SOURCE_RE = [/^(src|server)\/.+\.(js|jsx)$/, /^server\.js$/]

export const isTestFile = (p) => TEST_RE.some((re) => re.test(p))
export const isSourceFile = (p) => !isTestFile(p) && SOURCE_RE.some((re) => re.test(p))

const CHANGED = new Set(['added', 'modified', 'renamed'])

/** Removes HTML comments, so the commented hint in the PR template is not a waiver. */
export function stripHtmlComments(body) {
  return String(body ?? '').replace(/<!--[\s\S]*?-->/g, '')
}

/** The waiver reason when the body has a valid marker line, else null. */
export function waiverReason(body) {
  for (const m of stripHtmlComments(body).matchAll(/^[ \t]*No tests needed because:[ \t]*(.*)$/gim)) {
    const reason = m[1].trim()
    if (reason.length >= MIN_REASON) return reason
  }
  return null
}

/** True when the label is set and the body holds a valid reason line. */
export function isWaived(labels, body) {
  return labels.includes(WAIVER_LABEL) && waiverReason(body) !== null
}

/**
 * @param {{ files: { path: string, status: string }[], labels?: string[], body?: string }} input
 */
export function evaluateTestsRequired({ files, labels = [], body = '' }) {
  const changed = files.filter((f) => CHANGED.has(f.status))
  const sourceFiles = changed.filter((f) => isSourceFile(f.path)).map((f) => f.path)
  const testFiles = changed.filter((f) => isTestFile(f.path)).map((f) => f.path)
  const waived = isWaived(labels, body)
  let ok = true
  let message
  if (sourceFiles.length === 0) {
    message = 'No application source changed, so no test change is needed.'
  } else if (testFiles.length > 0) {
    message = `Source changed in ${sourceFiles.length} file(s) and ${testFiles.length} test file(s) changed.`
  } else if (waived) {
    message = `Source changed without tests. Waived: ${waiverReason(body)}`
  } else {
    ok = false
    message =
      `${sourceFiles.length} source file(s) changed but no test did. Add or update a test, or add the ` +
      `\`${WAIVER_LABEL}\` label and a line \`${WAIVER_MARKER} <reason of at least ${MIN_REASON} characters>\` to the PR description.`
  }
  return { ok, sourceFiles, testFiles, waived, message }
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The repo owner login from `owner/name`, or null when the value is not a valid repo slug. */
export function ownerOf(repo) {
  const [owner, name, ...rest] = String(repo ?? '').split('/')
  return OWNER_RE.test(owner ?? '') && OWNER_RE.test(name ?? '') && rest.length === 0 ? owner : null
}

/** Login that last applied `label` (a later `unlabeled` event clears it), from issue timeline events. */
export function labelApplier(timeline, label) {
  let login = null
  for (const e of timeline) {
    if (e.label?.name !== label) continue
    if (e.event === 'labeled') login = e.actor?.login ?? null
    else if (e.event === 'unlabeled') login = null
  }
  return login
}

/** The labels, minus the waiver label unless the repo owner applied it. Fails closed on a bad owner. */
export function ownerVerifiedLabels(labels, timeline, owner) {
  if (!labels.includes(WAIVER_LABEL)) return labels
  const by = labelApplier(timeline, WAIVER_LABEL)
  const ok = owner !== null && by !== null && by.toLowerCase() === owner.toLowerCase()
  return ok ? labels : labels.filter((l) => l !== WAIVER_LABEL)
}

/** Labels of a PR with the waiver label verified (the timeline is only fetched when the label is present). */
export async function verifiedLabels(api, repo, number, labels) {
  if (!labels.includes(WAIVER_LABEL)) return labels
  const timeline = await api.paginate(`/repos/${repo}/issues/${number}/timeline`)
  return ownerVerifiedLabels(labels, timeline, ownerOf(repo))
}

/** Live labels (waiver verified) and body for a PR. */
export async function fetchLivePr(api, repo, number) {
  const pr = await api.get(`/repos/${repo}/pulls/${number}`)
  const labels = await verifiedLabels(
    api,
    repo,
    number,
    (pr.labels ?? []).map((l) => l.name),
  )
  return { labels, body: pr.body ?? '' }
}

export async function main(env = process.env) {
  const { GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, CHANGED_JSON } = env
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/.test(PR_NUMBER ?? '') || !CHANGED_JSON) {
    console.error('testsRequired needs GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and CHANGED_JSON.')
    return 1
  }
  const files = JSON.parse(readFileSync(CHANGED_JSON, 'utf8'))
  const live = await fetchLivePr(createApi({ token: GH_TOKEN }), GITHUB_REPOSITORY, PR_NUMBER)
  const result = evaluateTestsRequired({ files, ...live })
  console.log(result.message)
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### tests-required: ${result.ok ? 'ok' : 'FAILED'}\n\n${result.message}\n`)
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  })
}
