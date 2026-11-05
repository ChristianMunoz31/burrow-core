// Classifies a change set so the single CI job can skip work that cannot be affected.
// Pure functions are exported; the CLI reads git, writes $RUNNER_TEMP/changed.json and
// the step outputs docs_only, app_changed, frontend_changed, full_suite.
// Usage (CI): BASE_SHA=... HEAD_SHA=... EVENT_NAME=... PR_AUTHOR=... node scripts/ci/changeKinds.js
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeOutputs } from './ghApi.js'

export const MAX_SOURCE_FILES_FOR_RELATED = 40

const DOCS = [/\.md$/i, /^docs\//, /^LICENSE$/]

// Files that cannot change what the web app does. Anything else counts as an app change.
const NOT_APP = [
  ...DOCS,
  /^\.github\//,
  /^scripts\/(ci|checks|desktop)\//,
  /^scripts\/(setupLabels|visualUpdate|installHooks)\.js$/,
  /^src-tauri\//,
  /^\.gitleaks\.toml$/,
  /^\.githooks\//,
  /^\.gitignore$/,
  /^release-please-config\.json$/,
  /^\.release-please-manifest\.json$/,
]

const FRONTEND = [
  /^src\//,
  /^public\//,
  /^index\.html$/,
  /^tailwind\.config\./,
  /^postcss\.config\./,
  /^vite\.config\./,
  /^package-lock\.json$/,
  /^e2e\//,
  /^playwright\.config\.js$/,
]

// A change here can break any test without an import edge that `vitest --changed` could follow, so the
// pull request runs the whole suite: manifests, test config, shared test setup and helpers, the DB layer,
// the AI and network seams, CI scripts (scripts/ covers scripts/ci) and shared test utilities.
// A removed or renamed src/server JS file also runs everything (see removesSource).
export const FULL_SUITE_PATHS = [
  /^package(-lock)?\.json$/,
  /^vitest\.config\.js$/,
  /^vite\.config\./,
  /(^|\/)__tests__\/(setup|helpers)\//,
  /^src\/test-utils\//,
  /^server\/db\//,
  /^server\/ai\/index\.js$/,
  /^server\/netPolicy\.js$/,
  /^scripts\//,
]

const isJs = (p) => /\.(js|jsx)$/.test(p)
const isSourceDir = (p) => /^(src|server)\//.test(p)
const matchesAny = (list, p) => list.some((re) => re.test(p))

/**
 * True when a src/ or server/ JS file was removed or renamed (the old path counts). `vitest --changed`
 * follows import edges from changed files, so it cannot find the tests of a module that no longer exists.
 */
export function removesSource(files) {
  return files.some(
    (f) => (f.status === 'removed' || f.status === 'renamed') && [f.path, f.previous].some((p) => p && isSourceDir(p) && isJs(p)),
  )
}

/** Every path a change touches, including the old name of a rename. */
export function allPaths(files) {
  return files.flatMap((f) => (f.previous ? [f.path, f.previous] : [f.path]))
}

/**
 * @param {{ path: string, status: string, previous?: string }[]} files
 * @param {{ isPullRequest?: boolean, author?: string }} [ctx]
 */
export function changeKinds(files, ctx = {}) {
  const { isPullRequest = true, author = '' } = ctx
  const paths = allPaths(files)
  const docsOnly = files.length > 0 && paths.every((p) => matchesAny(DOCS, p))
  const appChanged = paths.some((p) => !matchesAny(NOT_APP, p))
  const frontendChanged = paths.some((p) => matchesAny(FRONTEND, p))
  const changedSource = files.filter((f) => f.status !== 'removed' && isSourceDir(f.path) && isJs(f.path))
  const fullSuite =
    !isPullRequest ||
    author === 'dependabot[bot]' ||
    paths.some((p) => matchesAny(FULL_SUITE_PATHS, p)) ||
    paths.some((p) => isSourceDir(p) && !isJs(p)) ||
    removesSource(files) ||
    changedSource.length > MAX_SOURCE_FILES_FOR_RELATED
  return { docsOnly, appChanged, frontendChanged, fullSuite }
}

const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'added', T: 'modified' }

/** Parses `git diff --name-status -z` output into `[{ path, status, previous? }]`. */
export function parseNameStatus(text) {
  const parts = text.split('\0')
  const out = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i]
    if (!code) {
      i += 1
      continue
    }
    const status = STATUS[code[0]] ?? 'modified'
    if (code[0] === 'R' || code[0] === 'C') {
      out.push(code[0] === 'R' ? { path: parts[i + 2], status, previous: parts[i + 1] } : { path: parts[i + 2], status })
      i += 3
    } else {
      out.push({ path: parts[i + 1], status })
      i += 2
    }
  }
  return out.filter((f) => f.path)
}

/** Normalizes a GitHub API pull-request file entry. */
export function fromApiFile(f) {
  const status = { copied: 'added', changed: 'modified', unchanged: 'modified' }[f.status] ?? f.status
  return f.previous_filename ? { path: f.filename, status, previous: f.previous_filename } : { path: f.filename, status }
}

function diffFiles(base, head) {
  const out = execFileSync('git', ['diff', '--name-status', '-z', '-M', `${base}...${head}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseNameStatus(out)
}

export function main(env = process.env) {
  const isPullRequest = env.EVENT_NAME === 'pull_request'
  let files = []
  if (isPullRequest) {
    if (!/^[0-9a-f]{40}$/.test(env.BASE_SHA ?? '') || !/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? '')) {
      console.error('changeKinds needs BASE_SHA and HEAD_SHA (40 hex characters).')
      return 1
    }
    files = diffFiles(env.BASE_SHA, env.HEAD_SHA)
  }
  const kinds = isPullRequest
    ? changeKinds(files, { isPullRequest, author: env.PR_AUTHOR ?? '' })
    : { docsOnly: false, appChanged: true, frontendChanged: true, fullSuite: true }
  const dir = env.RUNNER_TEMP ?? '.'
  writeFileSync(path.join(dir, 'changed.json'), JSON.stringify(files))
  writeOutputs(env.GITHUB_OUTPUT, {
    docs_only: kinds.docsOnly,
    app_changed: kinds.appChanged,
    frontend_changed: kinds.frontendChanged,
    full_suite: kinds.fullSuite,
  })
  console.log(`changed files: ${files.length}; ${JSON.stringify(kinds)}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
