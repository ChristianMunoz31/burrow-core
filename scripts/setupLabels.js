// Creates (or updates) the repository labels the pipeline relies on. Run once by the owner:
//   npm run setup:labels
// Needs the GitHub CLI signed in (`gh auth status`). Uses no shell and costs no Actions minutes.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const LABELS = [
  { name: 'hold', color: 'b60205', description: 'Never auto-merge' },
  { name: 'no-tests-needed', color: 'c5def5', description: 'Waives tests-required and the coverage floor; needs a reason line' },
  { name: 'flaky', color: 'fbca04', description: 'Weekly flaky report' },
  { name: 'good-first-task', color: '7057ff', description: 'Small, well-scoped task' },
]

/** The `gh` argument list for one label. */
export function labelArgs(label) {
  return ['label', 'create', label.name, '--color', label.color, '--description', label.description, '--force']
}

export function main(run = spawnSync) {
  for (const label of LABELS) {
    const res = run('gh', labelArgs(label), { stdio: 'inherit', shell: false })
    if (res.error || res.status !== 0) {
      console.error(`Could not create the "${label.name}" label. Is the GitHub CLI installed and signed in (gh auth status)?`)
      return 1
    }
  }
  console.log(`Labels ready: ${LABELS.map((l) => l.name).join(', ')}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
