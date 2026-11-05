// Shared git helpers for the repo checks. Uses spawnSync without a shell and fixed arguments.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function git(args, cwd = REPO_ROOT) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.error || res.status !== 0) {
    throw new Error(`git ${args[0]} failed${res.stderr ? `: ${res.stderr.trim()}` : ''}`)
  }
  return res.stdout
}

const lines = (out) => out.split(/\r?\n/).filter(Boolean)

/** Folder of the optional nested Pro repo (docs/adr/0001-open-core-split.md); ignored by the core repo. */
export const PRO_DIR = path.join(REPO_ROOT, 'pro')

/**
 * Repo-relative, forward-slash paths of every tracked file. When the nested Pro repo exists, its tracked files are
 * added with a `pro/` prefix, so the em dash, personal-data and key checks also cover Pro copy.
 * @param {{ root?: string }} [opts] test seam
 */
export function listTrackedFiles({ root = REPO_ROOT } = {}) {
  const core = lines(git(['ls-files'], root))
  const proDir = path.join(root, 'pro')
  if (!existsSync(path.join(proDir, '.git'))) return core
  let pro = []
  try {
    pro = lines(git(['ls-files'], proDir)).map((f) => `pro/${f}`)
  } catch {
    // A pro/ folder whose repo has no commit or index yet: nothing tracked there.
  }
  return [...core, ...pro]
}

/** Repo-relative paths added, copied or modified in the index. */
export function listStagedFiles() {
  return lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACM']))
}

/** Content of a file as staged in the index, or null if unreadable. */
export function readStaged(file) {
  try {
    return git(['show', `:${file}`])
  } catch {
    return null
  }
}

/** Working-tree content, or null if the file is missing. */
export function readWorking(file) {
  try {
    return readFileSync(path.join(REPO_ROOT, file), 'utf8')
  } catch {
    return null
  }
}
