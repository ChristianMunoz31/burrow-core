// Runs from the npm `prepare` script. Points this clone at .githooks via repo-local git config.
// No-op outside a git checkout (Docker, CI archives, zip installs), and never touches global config.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (existsSync(path.join(root, '.git')) && existsSync(path.join(root, '.githooks'))) {
  const res = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
  if (res.status === 0) console.log('git hooks: core.hooksPath set to .githooks (repo-local)')
}
