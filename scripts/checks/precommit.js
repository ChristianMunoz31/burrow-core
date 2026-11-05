// Pre-commit gate (run by .githooks/pre-commit): refuses Pro source in the core repo, then eslint on staged JS/JSX,
// then the em dash and personal-data checks against the staged content. Usage: node scripts/checks/precommit.js
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, listStagedFiles, readStaged } from './gitFiles.js'

/** The first line of every Pro source file (docs/adr/0001-open-core-split.md 3.1). */
export const PRO_HEADER = ['// burrow-pro:', 'private source, never part of the public core.'].join(' ')

/**
 * Staged paths that must never enter the core repo: anything under pro/ (the nested Pro repo, for example after it
 * was moved aside inside the repo and back) and any file that carries the private Pro header.
 * @param {string[]} staged repo-relative paths
 * @param {(file: string) => string | null} read staged content
 * @returns {string[]}
 */
export function findProLeaks(staged, read = readStaged) {
  return staged.filter((f) => {
    if (/^pro(\/|$)/i.test(f)) return true
    if (/\.md$/i.test(f)) return false
    const text = read(f)
    return typeof text === 'string' && text.includes(PRO_HEADER)
  })
}

const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1
}

function main() {
  const staged = listStagedFiles()
  let failed = false

  const leaks = findProLeaks(staged)
  if (leaks.length) {
    console.error('pre-commit: Burrow Pro source must never be committed to the core repo:')
    for (const f of leaks) console.error(`  ${f}`)
    failed = true
  }

  const lintable = staged.filter((f) => /\.(js|jsx)$/.test(f) && existsSync(path.join(REPO_ROOT, f)))
  if (lintable.length) {
    if (existsSync(ESLINT_BIN)) {
      if (run(ESLINT_BIN, ['--no-warn-ignored', ...lintable]) !== 0) failed = true
    } else {
      console.warn('pre-commit: eslint is not installed (run npm ci); skipping lint. CI still lints.')
    }
  }

  const checks = ['noEmDash.js', 'personalData.js', 'noPrivateKeys.js']
  for (const name of checks) {
    if (run(path.join(REPO_ROOT, 'scripts', 'checks', name), ['--staged']) !== 0) failed = true
  }

  if (failed) console.error('\npre-commit blocked the commit. Fix the issues above and commit again.')
  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
