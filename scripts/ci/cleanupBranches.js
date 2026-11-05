// Weekly cleanup of merged branches that "Automatically delete head branches" missed (for example
// bot merges). A branch is deleted only when every condition holds:
//  - not the default branch, not protected, not a release-please--* branch
//  - no open PR uses it as head or as its base (stacked PRs)
//  - a PR from this repo was merged from it, its head sha equals the branch tip (no new commits),
//    and it was merged more than 2 days ago
// Usage (CI): GH_TOKEN, GITHUB_REPOSITORY, DRY_RUN=true|false node scripts/ci/cleanupBranches.js
import { pathToFileURL } from 'node:url'
import { GhError, createApi } from './ghApi.js'

export const MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000

/**
 * @param {{ name: string, protected: boolean, commit: { sha: string } }} branch
 * @param {{ state: string, merged_at: string | null, head: { sha: string, ref: string, repo: { full_name: string } | null } }[]} prs every PR with this branch as head
 * @param {{ repo: string, defaultBranch: string, now: number }} ctx
 * @returns {{ delete: boolean, reason: string }}
 */
export function branchVerdict(branch, prs, { repo, defaultBranch, now, isBase = false }) {
  if (branch.name === defaultBranch) return { delete: false, reason: 'default branch' }
  if (branch.protected) return { delete: false, reason: 'protected' }
  if (branch.name.startsWith('release-please--')) return { delete: false, reason: 'release-please branch' }
  if (isBase) return { delete: false, reason: 'base of an open PR' }
  const own = prs.filter((p) => p.head?.ref === branch.name && p.head?.repo?.full_name === repo)
  if (own.some((p) => p.state === 'open')) return { delete: false, reason: 'has an open PR' }
  const merged = own.find(
    (p) => p.merged_at && p.head.sha === branch.commit.sha && now - Date.parse(p.merged_at) > MIN_AGE_MS,
  )
  if (!merged) return { delete: false, reason: 'no merged PR matching the branch tip, older than 2 days' }
  return { delete: true, reason: 'merged more than 2 days ago and unchanged since' }
}

export async function main(env = process.env) {
  const { GH_TOKEN, GITHUB_REPOSITORY } = env
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '')) {
    console.error('cleanupBranches needs GH_TOKEN and GITHUB_REPOSITORY.')
    return 1
  }
  const dryRun = env.DRY_RUN !== 'false'
  const repo = GITHUB_REPOSITORY
  const owner = repo.split('/')[0]
  const api = createApi({ token: GH_TOKEN })
  const { default_branch: defaultBranch } = await api.get(`/repos/${repo}`)
  const branches = await api.paginate(`/repos/${repo}/branches`)
  let deleted = 0
  for (const branch of branches) {
    if (branch.name === defaultBranch || branch.protected || branch.name.startsWith('release-please--')) continue
    const stacked = await api.get(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch.name)}&per_page=1`)
    const prs = await api.get(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch.name}`)}&per_page=100`)
    const result = branchVerdict(branch, prs, { repo, defaultBranch, now: Date.now(), isBase: stacked.length > 0 })
    if (!result.delete) continue
    if (dryRun) {
      console.log(`[dry run] would delete ${branch.name}`)
      continue
    }
    const encoded = branch.name.split('/').map(encodeURIComponent).join('/')
    try {
      await api.del(`/repos/${repo}/git/refs/heads/${encoded}`)
      deleted += 1
      console.log(`deleted ${branch.name}`)
    } catch (err) {
      if (!(err instanceof GhError) || ![404, 422].includes(err.status)) throw err
    }
  }
  console.log(`${dryRun ? 'dry run: ' : ''}checked ${branches.length} branches, deleted ${deleted}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof GhError ? err.message : 'cleanupBranches failed unexpectedly.')
    return 1
  })
}
