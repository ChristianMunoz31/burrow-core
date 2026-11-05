// Regenerates the Linux visual baselines in e2e/__screenshots__/.
//
//   npm run test:visual:update [-- --docker | --ci]
//
// Baselines must be rendered on Linux with the exact image CI uses (PLAYWRIGHT_IMAGE), otherwise
// every pixel of text differs. Two ways, chosen automatically (Docker first):
//   docker  `docker run` the pinned Playwright image against this checkout. An anonymous volume
//           keeps this machine's node_modules (Windows binaries) out of the container.
//   ci      no usable Docker: dispatch `ci.yml` with `mode=visual-update` on the current branch, wait,
//           fetch the side branch `ci/visual-baselines-<run id>` the run pushes (no artifact: account-wide
//           artifact storage is limited) and copy its e2e/__screenshots__ into the working tree.
//           The branch must already be pushed.
// Nothing is ever committed; review the images, commit them yourself, then delete the side branch.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAYWRIGHT_IMAGE } from './lib/playwrightImage.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS = path.join(REPO_ROOT, 'e2e', '__screenshots__');
export const CONTAINER_SCRIPT = 'npm ci --ignore-scripts && npm run build && npx playwright test --project=visual --update-snapshots';

/**
 * Picks how to render the baselines.
 * @param {{ docker?: boolean, ci?: boolean, dockerUsable: boolean }} opts
 * @returns {'docker' | 'ci'}
 */
export function chooseMode({ docker = false, ci = false, dockerUsable }) {
  if (docker && ci) throw new Error('Use either --docker or --ci, not both.');
  if (ci) return 'ci';
  if (docker) {
    if (!dockerUsable) throw new Error('--docker was requested but Docker is not running. Start Docker Desktop or use --ci.');
    return 'docker';
  }
  return dockerUsable ? 'docker' : 'ci';
}

/**
 * Arguments for `docker run` (no shell involved).
 * @param {string} repoRoot Absolute path of the checkout.
 * @param {string} [image]
 * @returns {string[]}
 */
export function buildDockerArgs(repoRoot, image = PLAYWRIGHT_IMAGE) {
  return ['run', '--rm', '--ipc=host', '-v', `${repoRoot}:/work`, '-v', '/work/node_modules', '-w', '/work', image, 'bash', '-c', CONTAINER_SCRIPT];
}

/**
 * Name of the side branch the visual-update run pushes its baselines to.
 * @param {string} runId
 * @returns {string}
 */
export function sideBranchName(runId) {
  return `ci/visual-baselines-${runId}`;
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO_ROOT, shell: false, encoding: 'utf8', ...opts });

function dockerUsable() {
  const res = run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
  return res.status === 0;
}

function must(res, what) {
  if (res.error || res.status !== 0) {
    throw new Error(`${what} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`}.`);
  }
  return res;
}

function viaDocker() {
  console.log(`Rendering baselines in ${PLAYWRIGHT_IMAGE}`);
  must(run('docker', buildDockerArgs(REPO_ROOT), { stdio: 'inherit', encoding: undefined }), 'docker run');
  console.log(`Baselines written to ${SCREENSHOTS}. Review them, then commit.`);
}

function viaCi() {
  const branch = must(run('git', ['rev-parse', '--abbrev-ref', 'HEAD']), 'git rev-parse').stdout.trim();
  if (!branch || branch === 'HEAD') throw new Error('Check out a branch first; the workflow runs on a pushed branch.');
  console.log(`No usable Docker: dispatching ci.yml (mode=visual-update) on ${branch}. The branch must be pushed.`);
  must(run('gh', ['workflow', 'run', 'ci.yml', '--ref', branch, '-f', 'mode=visual-update'], { stdio: 'inherit' }), 'gh workflow run');
  // The dispatch is accepted before the run exists; give GitHub a moment, then find the newest one.
  let runId = '';
  for (let attempt = 0; attempt < 10 && !runId; attempt += 1) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
    const list = run('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', branch, '--event', 'workflow_dispatch', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId']);
    runId = list.status === 0 ? list.stdout.trim() : '';
  }
  if (!runId) throw new Error('Could not find the dispatched run. Check the Actions tab, then run: git fetch origin ci/visual-baselines-<id> and git checkout FETCH_HEAD -- e2e/__screenshots__');
  must(run('gh', ['run', 'watch', runId, '--exit-status'], { stdio: 'inherit' }), 'gh run watch');
  const sideBranch = sideBranchName(runId);
  must(run('git', ['fetch', 'origin', sideBranch], { stdio: 'inherit' }), `git fetch origin ${sideBranch}`);
  must(run('git', ['checkout', 'FETCH_HEAD', '--', 'e2e/__screenshots__'], { stdio: 'inherit' }), 'git checkout FETCH_HEAD');
  console.log(`Baselines copied from ${sideBranch} into ${SCREENSHOTS} (staged). Review them, commit and push, then delete the side branch: git push origin --delete ${sideBranch}`);
}

function main(argv) {
  const flags = new Set(argv);
  for (const f of flags) if (!['--docker', '--ci'].includes(f)) throw new Error(`Unknown argument: ${f}\nUsage: npm run test:visual:update [-- --docker | --ci]`);
  const mode = chooseMode({ docker: flags.has('--docker'), ci: flags.has('--ci'), dockerUsable: flags.has('--ci') ? false : dockerUsable() });
  if (mode === 'docker') viaDocker();
  else viaCi();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
