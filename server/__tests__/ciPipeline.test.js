// ci:always-run
// Unit tests for the CI pipeline logic (scripts/ci, scripts/checks/testsRequired.js, changedCoverage.js,
// bundle metric, labels, Playwright image pin) plus static guards over the workflow files. This file
// reads .github/workflows, so it is on the always-run list of scripts/ci/runUnitTests.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../scripts/checks/gitFiles.js';
import { evaluate, initialAssetNames, summarize, toMarkdown as budgetMarkdown } from '../../scripts/checks/bundleBudget.js';
import { coverageTargets, evaluateCoverage, main as coverageMain, relativizeSummary, toMarkdown as coverageMarkdown } from '../../scripts/checks/changedCoverage.js';
import {
  evaluateTestsRequired,
  fetchLivePr,
  isWaived,
  labelApplier,
  ownerOf,
  ownerVerifiedLabels,
  stripHtmlComments,
  verifiedLabels,
  waiverReason,
} from '../../scripts/checks/testsRequired.js';
import { FULL_SUITE_PATHS, changeKinds, fromApiFile, parseNameStatus, removesSource } from '../../scripts/ci/changeKinds.js';
import { MIN_AGE_MS, branchVerdict } from '../../scripts/ci/cleanupBranches.js';
import {
  ISSUE_TITLE,
  buildComment,
  buildReportBody,
  collectFailures,
  findFlakyIssue,
  isHardFailure,
  tally,
} from '../../scripts/ci/flakyReport.js';
import { escapeMd } from '../../scripts/ci/markdown.js';
import {
  HOLD_REASON,
  MARKER,
  WAIVED_REASON,
  decide,
  dependabotVerdict,
  deleteMergedBranch,
  findSticky,
  gateFilesIn,
  gather,
  getRunInfo,
  isMajorBump,
  otherChecksVerdict,
  packageGateFor,
  packageJsonGate,
  pickLatestRun,
  renderComment,
  runMerge,
  staleReason,
  stepRows,
  trustedRuns,
  verifyVerdict,
  visualDiffNames,
  visualDiffsFor,
} from '../../scripts/ci/prBot.js';
import { ALWAYS_RUN, MAX_COVERAGE_FILES, cleanCoverage, planUnitTests, plannedSources } from '../../scripts/ci/runUnitTests.js';
import { PLAYWRIGHT_IMAGE } from '../../scripts/lib/playwrightImage.js';
import { LABELS, labelArgs, main as setupLabels } from '../../scripts/setupLabels.js';
import { hasAllPrivateFiles, hasPrivateFile, readPrivateFile } from './helpers/privateFiles.js';

const f = (p, status = 'modified') => ({ path: p, status });
const REPO_SLUG = 'ChristianMunoz31/burrow';
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// The release workflows are private-only (left out of the public core export); their guards run only where they exist.
const WF = (name) => `.github/workflows/${name}`;
const RELEASE_WORKFLOWS = ['release.yml', 'release-please.yml', 'desktop-windows.yml'];
const presentWorkflows = (names) => names.filter((n) => hasPrivateFile(WF(n)));
const hasReleaseWorkflows = hasAllPrivateFiles(...RELEASE_WORKFLOWS.map(WF));

describe('changeKinds', () => {
  it('treats markdown, docs/ and LICENSE as docs only', () => {
    const k = changeKinds([f('README.md'), f('docs/PRODUCT.md'), f('LICENSE')]);
    expect(k).toMatchObject({ docsOnly: true, appChanged: false, frontendChanged: false, fullSuite: false });
  });

  it('an empty change set is not docs only', () => {
    expect(changeKinds([]).docsOnly).toBe(false);
  });

  it('a source change is an app change and related-mode eligible', () => {
    const k = changeKinds([f('src/pages/Todos.jsx'), f('src/pages/__tests__/Todos.test.jsx')]);
    expect(k).toMatchObject({ docsOnly: false, appChanged: true, frontendChanged: true, fullSuite: false });
  });

  it('a server-only change is an app change but not a frontend change', () => {
    const k = changeKinds([f('server/dataAccess.js')]);
    expect(k).toMatchObject({ appChanged: true, frontendChanged: false, fullSuite: false });
  });

  it('pipeline-only changes are not app changes', () => {
    const k = changeKinds([f('.github/workflows/ci.yml'), f('scripts/ci/prBot.js'), f('src-tauri/src/lib.rs')]);
    expect(k.appChanged).toBe(false);
    expect(k.docsOnly).toBe(false);
  });

  it('frontend-affecting files turn visual and a11y on', () => {
    for (const p of ['public/favicon.svg', 'index.html', 'tailwind.config.cjs', 'postcss.config.js', 'vite.config.js', 'package-lock.json', 'e2e/flows/a.spec.js', 'playwright.config.js']) {
      expect(changeKinds([f(p)]).frontendChanged, p).toBe(true);
    }
    expect(changeKinds([f('server/aiRoutes.js')]).frontendChanged).toBe(false);
  });

  it('full suite: dependabot, manifests, test setup, migrations, scripts, non-js source, many files, not a PR', () => {
    expect(changeKinds([f('src/a.js')], { author: 'dependabot[bot]' }).fullSuite).toBe(true);
    expect(changeKinds([f('src/a.js')], { isPullRequest: false }).fullSuite).toBe(true);
    for (const p of ['package.json', 'package-lock.json', 'vitest.config.js', 'vite.config.js', 'server/__tests__/setup/dataDir.js', 'server/__tests__/helpers/testDb.js', 'server/db/migrations/009_x.sql', 'scripts/seedDemo.js', 'src/index.css', 'server/data.json']) {
      expect(changeKinds([f(p)]).fullSuite, p).toBe(true);
    }
    const many = Array.from({ length: 41 }, (_, i) => f(`src/c/C${i}.jsx`));
    expect(changeKinds(many).fullSuite).toBe(true);
    expect(changeKinds(many.slice(0, 40)).fullSuite).toBe(false);
  });

  it('config and shared files always fall back to the full suite', () => {
    const shared = [
      'package.json',
      'package-lock.json',
      'vitest.config.js',
      'vite.config.js',
      'server/__tests__/setup/networkGuard.js',
      'server/__tests__/helpers/testDb.js',
      'src/pages/__tests__/helpers/render.jsx',
      'src/components/__tests__/setup/mocks.js',
      'src/test-utils/entitlements.js',
      'server/db/index.js',
      'server/db/query.js',
      'server/db/migrations/009_x.sql',
      'server/ai/index.js',
      'server/netPolicy.js',
      'scripts/ci/runUnitTests.js',
      'scripts/ci/changeKinds.js',
    ];
    for (const p of shared) {
      expect(FULL_SUITE_PATHS.some((re) => re.test(p)), p).toBe(true);
      expect(changeKinds([f(p)]).fullSuite, p).toBe(true);
    }
    for (const p of ['server/ai/gate.js', 'server/dataAccess.js', 'src/pages/Todos.jsx', 'src/hooks/useTodos.js']) {
      expect(changeKinds([f(p)]).fullSuite, p).toBe(false);
    }
  });

  it('removing or renaming a src or server JS file runs the whole suite (--changed cannot see its old importers)', () => {
    expect(changeKinds([f('src/old.js', 'removed')]).fullSuite).toBe(true);
    expect(changeKinds([f('server/old.js', 'removed')]).fullSuite).toBe(true);
    expect(changeKinds([f('src/pages/Old.jsx', 'removed'), f('src/a.js')]).fullSuite).toBe(true);
    expect(changeKinds([{ path: 'src/new.js', status: 'renamed', previous: 'src/old.js' }]).fullSuite).toBe(true);
    expect(changeKinds([{ path: 'lib/new.js', status: 'renamed', previous: 'src/old.js' }]).fullSuite).toBe(true);
    expect(changeKinds([{ path: 'src/new.js', status: 'renamed', previous: 'lib/old.js' }]).fullSuite).toBe(true);
    expect(removesSource([f('src/a.js', 'removed'), f('docs/x.md')])).toBe(true);
    // not source JS, or not removed or renamed
    expect(changeKinds([f('docs/old.md', 'removed')]).fullSuite).toBe(false);
    expect(changeKinds([f('src/a.js', 'modified'), f('src/b.js', 'added')]).fullSuite).toBe(false);
    expect(removesSource([f('e2e/flows/old.spec.js', 'removed')])).toBe(false);
  });

  it('a rename counts both names', () => {
    const k = changeKinds([{ path: 'docs/x.md', status: 'renamed', previous: 'src/old.js' }]);
    expect(k.docsOnly).toBe(false);
    expect(k.appChanged).toBe(true);
  });

  it('parses git name-status -z output including renames and deletions', () => {
    const out = ['M', 'src/a.js', 'A', 'src/b.js', 'D', 'src/c.js', 'R087', 'src/old.js', 'src/new.js', 'C100', 'x.js', 'y.js', ''].join('\0');
    expect(parseNameStatus(out)).toEqual([
      { path: 'src/a.js', status: 'modified' },
      { path: 'src/b.js', status: 'added' },
      { path: 'src/c.js', status: 'removed' },
      { path: 'src/new.js', status: 'renamed', previous: 'src/old.js' },
      { path: 'y.js', status: 'added' },
    ]);
  });

  it('normalizes API file entries', () => {
    expect(fromApiFile({ filename: 'a.js', status: 'copied' })).toEqual({ path: 'a.js', status: 'added' });
    expect(fromApiFile({ filename: 'b.js', status: 'renamed', previous_filename: 'a.js' })).toEqual({ path: 'b.js', status: 'renamed', previous: 'a.js' });
  });
});

describe('evaluateTestsRequired', () => {
  const src = [f('src/utils/a.js', 'added')];
  const waiverBody = 'Intro\nNo tests needed because: pure copy change in a label\n';

  it('passes when no source changed', () => {
    expect(evaluateTestsRequired({ files: [f('README.md')] }).ok).toBe(true);
    expect(evaluateTestsRequired({ files: [f('scripts/x.js')] }).ok).toBe(true);
  });

  it('fails on source without a test', () => {
    const r = evaluateTestsRequired({ files: [f('server/a.js'), f('server.js'), f('src/b.jsx')] });
    expect(r.ok).toBe(false);
    expect(r.sourceFiles).toEqual(['server/a.js', 'server.js', 'src/b.jsx']);
    expect(r.message).toContain('no-tests-needed');
  });

  it('passes when a test (any recognized form) changed with the source', () => {
    for (const t of ['server/__tests__/a.test.js', 'src/x/__tests__/b.jsx', 'src/c.test.jsx', 'e2e/flows/a.spec.js']) {
      expect(evaluateTestsRequired({ files: [...src, f(t)] }).ok, t).toBe(true);
    }
  });

  it('a test file is never counted as source', () => {
    const r = evaluateTestsRequired({ files: [f('src/x/__tests__/b.test.jsx')] });
    expect(r.sourceFiles).toEqual([]);
  });

  it('deletions never need tests and a deleted test does not count', () => {
    expect(evaluateTestsRequired({ files: [f('src/old.js', 'removed')] }).ok).toBe(true);
    expect(evaluateTestsRequired({ files: [...src, f('server/__tests__/old.test.js', 'removed')] }).ok).toBe(false);
  });

  it('a rename counts as a source change and as a test change', () => {
    expect(evaluateTestsRequired({ files: [f('src/moved.js', 'renamed')] }).ok).toBe(false);
    expect(evaluateTestsRequired({ files: [...src, f('server/__tests__/moved.test.js', 'renamed')] }).ok).toBe(true);
  });

  it('the waiver needs the label AND the marker line', () => {
    expect(evaluateTestsRequired({ files: src, labels: ['no-tests-needed'], body: waiverBody })).toMatchObject({ ok: true, waived: true });
    expect(evaluateTestsRequired({ files: src, labels: [], body: waiverBody }).ok).toBe(false);
    expect(evaluateTestsRequired({ files: src, labels: ['no-tests-needed'], body: 'nothing here' }).ok).toBe(false);
  });

  it('a reason shorter than 10 characters is rejected', () => {
    expect(isWaived(['no-tests-needed'], 'No tests needed because: ok fine')).toBe(false);
    expect(isWaived(['no-tests-needed'], 'No tests needed because: 123456789')).toBe(false);
    expect(isWaived(['no-tests-needed'], 'No tests needed because: 1234567890')).toBe(true);
    expect(isWaived(['no-tests-needed'], 'No tests needed because:          x')).toBe(false);
  });

  it('the marker inside an HTML comment (the template hint) does not count', () => {
    const body = '<!--\nNo tests needed because: <your reason of enough length>\n-->\nText';
    expect(stripHtmlComments(body)).not.toContain('No tests needed');
    expect(waiverReason(body)).toBeNull();
    expect(evaluateTestsRequired({ files: src, labels: ['no-tests-needed'], body }).ok).toBe(false);
  });

  it('accepts CRLF bodies and indentation, and takes the first valid line', () => {
    expect(waiverReason('x\r\n  No tests needed because: copy only change\r\ny')).toBe('copy only change');
    expect(waiverReason('No tests needed because: no\nNo tests needed because: a long enough reason')).toBe('a long enough reason');
  });

  it('the same waiver is used for the coverage floor', () => {
    expect(isWaived(['no-tests-needed'], waiverBody)).toBe(true);
    expect(isWaived([], waiverBody)).toBe(false);
  });
});

describe('owner-applied waiver label', () => {
  const waiverBody = 'No tests needed because: wording tweak only';
  const ev = (event, login, label = 'no-tests-needed') => ({ event, actor: { login }, label: { name: label }, created_at: '2026-10-01T10:00:00Z' });

  it('reads who applied the label; a later unlabel clears it and the last labeler wins', () => {
    expect(labelApplier([ev('labeled', 'ChristianMunoz31')], 'no-tests-needed')).toBe('ChristianMunoz31');
    expect(labelApplier([ev('labeled', 'ChristianMunoz31'), ev('unlabeled', 'ChristianMunoz31')], 'no-tests-needed')).toBeNull();
    expect(labelApplier([ev('labeled', 'ChristianMunoz31'), ev('unlabeled', 'x'), ev('labeled', 'github-actions[bot]')], 'no-tests-needed')).toBe('github-actions[bot]');
    expect(labelApplier([ev('labeled', 'ChristianMunoz31', 'hold'), { event: 'commented' }], 'no-tests-needed')).toBeNull();
    expect(labelApplier([{ event: 'labeled', label: { name: 'no-tests-needed' } }], 'no-tests-needed')).toBeNull();
  });

  it('keeps the waiver label only when the repo owner applied it, and fails closed otherwise', () => {
    const labels = ['no-tests-needed', 'hold'];
    expect(ownerVerifiedLabels(labels, [ev('labeled', 'ChristianMunoz31')], 'ChristianMunoz31')).toEqual(labels);
    expect(ownerVerifiedLabels(labels, [ev('labeled', 'christianmunoz31')], 'ChristianMunoz31')).toEqual(labels);
    expect(ownerVerifiedLabels(labels, [ev('labeled', 'github-actions[bot]')], 'ChristianMunoz31')).toEqual(['hold']);
    expect(ownerVerifiedLabels(labels, [ev('labeled', 'someone-else')], 'ChristianMunoz31')).toEqual(['hold']);
    expect(ownerVerifiedLabels(labels, [], 'ChristianMunoz31')).toEqual(['hold']);
    expect(ownerVerifiedLabels(labels, [ev('labeled', 'ChristianMunoz31')], null)).toEqual(['hold']);
    expect(ownerVerifiedLabels(['hold'], [], 'ChristianMunoz31')).toEqual(['hold']);
  });

  it('validates the owner taken from the repo slug', () => {
    expect(ownerOf('ChristianMunoz31/burrow')).toBe('ChristianMunoz31');
    for (const bad of ['', undefined, 'a', 'a/b/c', '/b', 'a/', '../x', 'a b/c', 'a;rm/b']) expect(ownerOf(bad), String(bad)).toBeNull();
  });

  it('only fetches the timeline when the label is present', async () => {
    const paginate = vi.fn(async () => [ev('labeled', 'ChristianMunoz31')]);
    expect(await verifiedLabels({ paginate }, REPO_SLUG, 12, ['hold'])).toEqual(['hold']);
    expect(paginate).not.toHaveBeenCalled();
    expect(await verifiedLabels({ paginate }, REPO_SLUG, 12, ['no-tests-needed'])).toEqual(['no-tests-needed']);
    expect(paginate).toHaveBeenCalledWith('/repos/ChristianMunoz31/burrow/issues/12/timeline');
    const bot = { paginate: async () => [ev('labeled', 'github-actions[bot]')] };
    expect(await verifiedLabels(bot, REPO_SLUG, 12, ['no-tests-needed'])).toEqual([]);
  });

  it('fetchLivePr drops a waiver label that the owner did not apply', async () => {
    const mk = (login) => ({
      get: async () => ({ labels: [{ name: 'no-tests-needed' }], body: waiverBody }),
      paginate: async () => [ev('labeled', login)],
    });
    expect((await fetchLivePr(mk('ChristianMunoz31'), REPO_SLUG, 12)).labels).toEqual(['no-tests-needed']);
    const stripped = await fetchLivePr(mk('github-actions[bot]'), REPO_SLUG, 12);
    expect(stripped.labels).toEqual([]);
    expect(isWaived(stripped.labels, stripped.body)).toBe(false);
  });
});

describe('changedCoverage', () => {
  it('targets changed src and server js, not tests, main.jsx or deletions', () => {
    expect(
      coverageTargets([f('src/a.jsx'), f('server/b.js'), f('server/__tests__/b.test.js'), f('src/main.jsx'), f('src/gone.js', 'removed'), f('scripts/x.js'), f('src/style.css')]),
    ).toEqual(['src/a.jsx', 'server/b.js']);
  });

  it('aggregates covered over total lines against the 60 percent floor', () => {
    const byFile = new Map([
      ['src/a.js', { lines: { total: 10, covered: 9 } }],
      ['src/b.js', { lines: { total: 10, covered: 3 } }],
      ['src/empty.js', { lines: { total: 0, covered: 0 } }],
    ]);
    const r = evaluateCoverage(['src/a.js', 'src/b.js', 'src/empty.js', 'src/unreported.js'], byFile);
    expect(r).toMatchObject({ ok: true, covered: 12, total: 20, missing: ['src/unreported.js'] });
    expect(r.pct).toBe(60);
    expect(evaluateCoverage(['src/b.js'], byFile).ok).toBe(false);
  });

  it('passes when there is nothing to measure and renders a table', () => {
    const r = evaluateCoverage(['src/x.js'], new Map());
    expect(r.ok).toBe(true);
    expect(coverageMarkdown(r, false)).toContain('No executable lines');
    const bad = evaluateCoverage(['src/b.js'], new Map([['src/b.js', { lines: { total: 4, covered: 1 } }]]));
    expect(coverageMarkdown(bad)).toContain('Below the floor');
    expect(coverageMarkdown(bad)).toContain('human');
  });

  describe('main exit code (the step never reads the waiver)', () => {
    const run = (changed, summary, env = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-covmain-'));
      try {
        fs.writeFileSync(path.join(dir, 'changed.json'), JSON.stringify(changed));
        let summaryPath = path.join(dir, 'missing.json');
        if (summary) {
          summaryPath = path.join(dir, 'coverage-summary.json');
          const body = Object.fromEntries(Object.entries(summary).map(([rel, lines]) => [path.join(REPO_ROOT, rel), { lines }]));
          fs.writeFileSync(summaryPath, JSON.stringify({ total: {}, ...body }));
        }
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          return coverageMain({ CHANGED_JSON: path.join(dir, 'changed.json'), ...env }, summaryPath);
        } finally {
          log.mockRestore();
          err.mockRestore();
          warn.mockRestore();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    // a waiver in the environment, the label or the body changes nothing: there is no API access at all
    const waiverEnv = { GH_TOKEN: 'x', GITHUB_REPOSITORY: REPO_SLUG, PR_NUMBER: '12', LABELS: 'no-tests-needed' };

    it('exits 1 below the floor, also with a waiver present', () => {
      const low = { 'src/b.js': { total: 10, covered: 3 } };
      expect(run([f('src/b.js')], low)).toBe(1);
      expect(run([f('src/b.js')], low, waiverEnv)).toBe(1);
    });

    it('exits 1 when the summary is missing, also with a waiver present', () => {
      expect(run([f('src/b.js')], null)).toBe(1);
      expect(run([f('src/b.js')], null, waiverEnv)).toBe(1);
    });

    it('exits 0 at or above the floor and when nothing needs coverage', () => {
      expect(run([f('src/b.js')], { 'src/b.js': { total: 10, covered: 6 } })).toBe(0);
      expect(run([f('docs/a.md')], null)).toBe(0);
    });

    it('skips the floor with a note for more than 200 changed sources', () => {
      const many = Array.from({ length: MAX_COVERAGE_FILES + 1 }, (_, i) => f(`src/c${i}.js`));
      expect(run(many, null)).toBe(0);
      expect(run(many.slice(0, MAX_COVERAGE_FILES), null)).toBe(1);
      expect(plannedSources(many)).toHaveLength(MAX_COVERAGE_FILES + 1);
    });

    it('needs CHANGED_JSON', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(coverageMain({})).toBe(1);
      err.mockRestore();
    });
  });

  it('makes summary keys repo-relative', () => {
    const root = path.resolve('/repo');
    const map = relativizeSummary({ total: {}, [path.join(root, 'src', 'a.js')]: { lines: { total: 1, covered: 1 } } }, root);
    expect([...map.keys()]).toEqual(['src/a.js']);
  });
});

describe('runUnitTests plan', () => {
  it('full mode runs everything with coverage on the changed sources only', () => {
    const plan = planUnitTests({ files: [f('src/a.js'), f('server/__tests__/a.test.js')], fullSuite: true, alwaysRun: ALWAYS_RUN });
    expect(plan.mode).toBe('full');
    expect(plan.runs).toEqual([['run', '--coverage.enabled', '--coverage.include=src/a.js']]);
  });

  it('full mode without source changes has no coverage flags', () => {
    expect(planUnitTests({ files: [f('package.json')], fullSuite: true, alwaysRun: [] }).runs).toEqual([['run']]);
  });

  const BASE = 'b'.repeat(40);

  it('changed mode runs vitest --changed against the base sha, then the always-run list without coverage', () => {
    const plan = planUnitTests({ files: [f('src/a.jsx'), f('src/__tests__/a.test.jsx'), f('src/gone.css', 'removed'), f('README.md')], fullSuite: false, alwaysRun: ['t/x.test.js'], baseSha: BASE });
    expect(plan.mode).toBe('changed');
    expect(plan.runs).toEqual([
      ['run', '--changed', BASE, '--passWithNoTests', '--coverage.enabled', '--coverage.include=src/a.jsx'],
      ['run', 't/x.test.js'],
    ]);
  });

  it('a removed or renamed src or server JS file runs everything, whatever fullSuite says', () => {
    const gone = planUnitTests({ files: [f('src/a.jsx'), f('src/gone.js', 'removed')], fullSuite: false, alwaysRun: ['t/x.test.js'], baseSha: BASE });
    expect(gone.mode).toBe('full');
    expect(gone.runs).toEqual([['run', '--coverage.enabled', '--coverage.include=src/a.jsx']]);
    const moved = planUnitTests({ files: [{ path: 'src/new.js', status: 'renamed', previous: 'src/old.js' }], fullSuite: false, alwaysRun: [], baseSha: BASE });
    expect(moved.mode).toBe('full');
    expect(planUnitTests({ files: [f('docs/a.md', 'removed')], fullSuite: false, alwaysRun: [], baseSha: BASE }).mode).toBe('changed');
  });

  it('changed mode with nothing runnable only runs the always-run list', () => {
    expect(planUnitTests({ files: [f('README.md')], fullSuite: false, alwaysRun: ['t/x.test.js'], baseSha: BASE }).runs).toEqual([['run', 't/x.test.js']]);
  });

  it('falls back to the full suite without a valid base sha (manual run, bad input)', () => {
    for (const baseSha of [undefined, '', 'main', 'abc123', `${BASE}0`, 'B'.repeat(40)]) {
      const plan = planUnitTests({ files: [f('src/a.js')], fullSuite: false, alwaysRun: ['t/x.test.js'], baseSha });
      expect(plan.mode, String(baseSha)).toBe('full');
      expect(plan.runs).toEqual([['run', '--coverage.enabled', '--coverage.include=src/a.js']]);
    }
  });

  it('the full-suite decision wins over a valid base sha', () => {
    expect(planUnitTests({ files: [f('package.json')], fullSuite: true, alwaysRun: ['t/x.test.js'], baseSha: BASE }).runs).toEqual([['run']]);
  });

  it('drops coverage flags past the file cap and lists only real test files as always-run', () => {
    const many = Array.from({ length: MAX_COVERAGE_FILES + 1 }, (_, i) => f(`src/c${i}.js`));
    expect(planUnitTests({ files: many, fullSuite: true, alwaysRun: [] }).runs).toEqual([['run']]);
    for (const rel of ALWAYS_RUN) expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
  });
});

// ---- PR bot ----

const REPO = 'ChristianMunoz31/burrow';
const SHA = 'a'.repeat(40);
const pr = (over = {}) => ({
  number: 12,
  state: 'open',
  draft: false,
  title: 'feat(budget): add category rollover',
  user: { login: 'ChristianMunoz31' },
  author_association: 'OWNER',
  base: { ref: 'main' },
  head: { ref: 'feat/rollover', sha: SHA, repo: { full_name: REPO } },
  mergeable: true,
  mergeable_state: 'clean',
  ...over,
});
const files = [f('src/pages/Budget.jsx'), f('src/pages/__tests__/Budget.test.jsx')];
const steps = (over = {}) =>
  Object.entries({
    'hygiene: gitleaks': 'success',
    lint: 'success',
    'tests-required': 'success',
    'unit tests': 'success',
    'coverage (changed files)': 'success',
    build: 'success',
    'bundle budget': 'success',
    'e2e (Playwright)': 'success',
    ...over,
  }).map(([name, conclusion]) => ({ name, conclusion, status: conclusion ? 'completed' : 'in_progress' }));
const run = (stepOver = {}, over = {}) => ({
  run: { id: 99, status: 'completed', conclusion: 'success', ...over },
  jobs: [{ name: 'verify', conclusion: 'success', steps: steps(stepOver) }],
});
const live = (over = {}) => ({ repo: REPO, labels: [], body: '', ...over });
const rustOk = [{ id: 5, name: 'rust', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }];

describe('decide', () => {
  const go = (p = pr(), fl = files, ri = run(), cr = [], lv = live()) => decide(p, fl, ri, cr, lv);

  it('merges when every condition holds', () => {
    expect(go()).toMatchObject({ action: 'merge', kind: 'merge' });
  });

  it('refuses closed PRs, other bases, forks and drafts', () => {
    expect(go(pr({ state: 'closed' })).action).toBe('none');
    expect(go(pr({ base: { ref: 'dev' } })).reason).toContain('base branch');
    expect(go(pr({ head: { ref: 'x', sha: SHA, repo: { full_name: 'someone/burrow' } } })).reason).toContain('fork');
    expect(go(pr({ head: { ref: 'x', sha: SHA, repo: null } })).reason).toContain('fork');
    expect(go(pr({ draft: true }))).toMatchObject({ action: 'none', kind: 'waiting' });
  });

  it('waits on conflicts and unknown mergeability', () => {
    expect(go(pr({ mergeable: false })).reason).toContain('conflicts');
    expect(go(pr({ mergeable_state: 'dirty' })).reason).toContain('conflicts');
    expect(go(pr({ mergeable: null })).kind).toBe('waiting');
  });

  it('never merges release-please heads or github-actions authored PRs', () => {
    expect(go(pr({ head: { ref: 'release-please--branches--main', sha: SHA, repo: { full_name: REPO } } })).kind).toBe('human');
    expect(go(pr({ head: { ref: 'release-please--branches--main--components--burrow', sha: SHA, repo: { full_name: REPO } } })).kind).toBe('human');
    expect(go(pr({ user: { login: 'github-actions[bot]' }, author_association: 'OWNER' })).kind).toBe('human');
  });

  it('checks the author: the owner or dependabot (by login); nobody else, not even members or collaborators', () => {
    expect(go(pr({ author_association: 'OWNER' })).action).toBe('merge');
    for (const a of ['MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) expect(go(pr({ author_association: a })).kind, a).toBe('human');
    const bot = { login: 'dependabot[bot]', type: 'Bot' };
    const title = 'chore(deps): bump x from 1.0.0 to 1.0.1';
    expect(go(pr({ user: bot, author_association: 'NONE', title })).action).toBe('merge');
    expect(go(pr({ user: { login: 'dependabot[bot]', type: 'User' }, author_association: 'NONE', title })).kind).toBe('human');
  });

  it('the hold label blocks', () => {
    expect(go(pr(), files, run(), [], live({ labels: ['hold'] }))).toMatchObject({ action: 'none', kind: 'held' });
  });

  it('the title must be a conventional commit', () => {
    for (const t of ['Add rollover', 'feat: ', 'feature(x): y', 'feat(Budget): y', 'feat(x):y', '']) expect(go(pr({ title: t })).reason, t).toContain('conventional');
    for (const t of ['fix: x', 'feat(budget)!: x', 'chore(deps-dev): bump y', 'revert: oops']) expect(go(pr({ title: t })).action, t).toBe('merge');
  });

  it('gate files need a human merge, including a rename away from one', () => {
    for (const p of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'scripts/ci/prBot.js', 'scripts/checks/testsRequired.js', 'scripts/lib/playwrightImage.js', '.gitleaks.toml', '.githooks/pre-commit', 'vitest.config.js', 'playwright.config.js', 'e2e/support/fixtures.js', 'release-please-config.json', '.release-please-manifest.json', 'scripts/release/notes.js', 'scripts/desktop/sign.js', 'scripts/license/issue.js', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.dev.conf.json', 'src-tauri/capabilities/default.json', 'config/store.json', 'Dockerfile', 'compose.yaml', 'compose.ollama.yaml', 'compose.dev.yml', 'src/pages/__tests__/helpers/render.jsx', 'src/components/__tests__/setup/mocks.js', 'src/test-utils/entitlements.js', 'scripts/lib/fakeOllamaServer.js']) {
      const r = go(pr(), [...files, f(p)]);
      expect(r, p).toMatchObject({ action: 'none', kind: 'human' });
      expect(r.reason).toContain('changes');
    }
    expect(go(pr(), [...files, { path: 'src/x.js', status: 'renamed', previous: '.github/x.yml' }]).kind).toBe('human');
    expect(gateFilesIn(files)).toEqual([]);
    expect(go(pr(), [...files, f('e2e/flows/a.spec.js')]).action).toBe('merge');
    // near misses stay ordinary code
    for (const p of ['scripts/releases.js', 'src-tauri/icons/icon.png', 'src-tauri/binaries/x.txt', 'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml.bak', 'src-tauri/srcs/a.rs', 'configs/a.json', 'Dockerfile.md', 'src/pages/__tests__/Budget.test.jsx', 'src/test-utilities/a.js', 'server/dataAccess.js']) {
      expect(gateFilesIn([f(p)]), p).toEqual([]);
    }
  });

  it('Rust shell code is a gate file (src, Cargo.toml, build.rs)', () => {
    for (const p of ['src-tauri/src/main.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/nested/mod.rs', 'src-tauri/Cargo.toml', 'src-tauri/build.rs']) {
      expect(gateFilesIn([f(p)]), p).toEqual([p]);
      expect(go(pr(), [...files, f(p)]), p).toMatchObject({ action: 'none', kind: 'human' });
    }
  });

  it('more than MAX_COVERAGE_FILES changed source files is a human merge with a clear reason', () => {
    const many = Array.from({ length: MAX_COVERAGE_FILES + 1 }, (_, i) => f(`src/c${i}.js`));
    const r = go(pr(), many);
    expect(r).toMatchObject({ action: 'none', kind: 'human' });
    expect(r.reason).toContain(String(MAX_COVERAGE_FILES + 1));
    expect(r.reason).toContain('coverage');
    // exactly the limit is not routed to a human by this rule
    expect(go(pr(), many.slice(0, MAX_COVERAGE_FILES)).kind).not.toBe('human');
    // test files and non-source files do not count
    const tests = Array.from({ length: MAX_COVERAGE_FILES + 1 }, (_, i) => f(`src/__tests__/t${i}.test.js`));
    expect(go(pr(), tests).kind).not.toBe('human');
  });

  it('too many files is a human merge', () => {
    expect(go(pr(), Array.from({ length: 3000 }, (_, i) => f(`docs/${i}.md`))).kind).toBe('human');
  });

  it('pending and failed CI both block, with different reasons', () => {
    expect(go(pr(), files, null).reason).toContain('not run');
    expect(go(pr(), files, run({}, { status: 'in_progress', conclusion: null })).reason).toContain('running');
    expect(go(pr(), files, run({}, { conclusion: 'failure' })).reason).toContain('failure');
    // the CI tests-required step is non-fatal and ignored: decide() evaluates it live
    expect(go(pr(), files, run({ 'tests-required': 'failure' })).action).toBe('merge');
  });

  it('other check runs (rust) must be complete and green', () => {
    expect(go(pr(), files, run(), rustOk).action).toBe('merge');
    expect(go(pr(), files, run(), [{ ...rustOk[0], status: 'in_progress', conclusion: null }]).reason).toContain('rust');
    expect(go(pr(), files, run(), [{ ...rustOk[0], conclusion: 'failure' }]).reason).toContain('rust');
    expect(go(pr(), files, run(), [{ ...rustOk[0], app: { slug: 'some-app' }, conclusion: 'failure' }]).action).toBe('merge');
  });

  it('removing the waiver after CI still blocks (live tests-required)', () => {
    const noTests = [f('src/pages/Budget.jsx')];
    const waived = live({ labels: ['no-tests-needed'], body: 'No tests needed because: wording tweak only' });
    expect(go(pr(), noTests, run({ 'tests-required': 'failure' }), [], waived)).toMatchObject({ action: 'none', kind: 'human', reason: WAIVED_REASON });
    expect(go(pr(), noTests, run(), [], live()).reason).toContain('tests-required');
    expect(go(pr(), noTests, run({ 'tests-required': 'failure' }), [], live()).reason).toContain('tests-required');
  });

  it('a used waiver is always a human merge, also for a waived coverage failure', () => {
    const waived = live({ labels: ['no-tests-needed'], body: 'No tests needed because: wording tweak only' });
    const covFail = run({ 'coverage (changed files)': 'failure' }, { conclusion: 'failure' });
    covFail.jobs[0].conclusion = 'failure';
    expect(go(pr(), files, covFail, [], waived)).toMatchObject({ kind: 'human', reason: WAIVED_REASON });
    expect(go(pr(), files, covFail, [], live()).action).toBe('none');
  });

  it('a waived coverage failure is accepted only with a live waiver, and always goes to a human', () => {
    const covFail = run({ 'coverage (changed files)': 'failure' }, { conclusion: 'failure' });
    covFail.jobs[0].conclusion = 'failure';
    const waived = live({ labels: ['no-tests-needed'], body: 'No tests needed because: wording tweak only' });
    expect(go(pr(), files, covFail, [], waived)).toMatchObject({ action: 'none', kind: 'human', reason: WAIVED_REASON });
    // waiver removed (or the label dropped as not owner-applied) after CI: the stale failure blocks, never merges
    expect(go(pr(), files, covFail, [], live())).toMatchObject({ action: 'none', kind: 'waiting' });
    expect(go(pr(), files, covFail, [], live({ body: 'No tests needed because: wording tweak only' })).action).toBe('none');
    expect(go(pr(), files, covFail, [], live({ labels: ['no-tests-needed'] })).action).toBe('none');
    // a coverage failure plus any other failure is never accepted
    const lintToo = run({ 'coverage (changed files)': 'failure', lint: 'failure' }, { conclusion: 'failure' });
    lintToo.jobs[0].conclusion = 'failure';
    expect(go(pr(), files, lintToo, [], waived).kind).toBe('waiting');
    // a passing coverage step with tests present still merges
    expect(go(pr(), files, run(), [], waived).action).toBe('merge');
  });

  it('gather drops a no-tests-needed label that the owner did not apply', async () => {
    const make = (login) => {
      const pull = pr({ labels: [{ name: 'no-tests-needed' }], body: 'No tests needed because: wording tweak only', base: { ref: 'main', sha: 'b'.repeat(40) } });
      return {
        get: vi.fn(async (p) => (p.includes('/actions/workflows/') ? { workflow_runs: [] } : pull)),
        paginate: vi.fn(async (p) => {
          if (p.endsWith('/files')) return [{ filename: 'src/pages/Budget.jsx', status: 'modified' }];
          if (p.endsWith('/timeline')) return [{ event: 'labeled', actor: { login }, label: { name: 'no-tests-needed' }, created_at: '2026-10-01T10:00:00Z' }];
          return [];
        }),
      };
    };
    const byOwner = await gather(make('ChristianMunoz31'), REPO, 12);
    expect(byOwner.live.labels).toContain('no-tests-needed');
    const byBot = await gather(make('github-actions[bot]'), REPO, 12);
    expect(byBot.live.labels).not.toContain('no-tests-needed');
    expect(byBot.testsRequired.waived).toBe(false);
  });

  it('package.json changes beyond dependency versions need a human', () => {
    expect(go(pr(), files, run(), [], live({ packageGate: 'it changes package.json scripts/engines/overrides/workspaces' })).kind).toBe('human');
  });

  it('holds Dependabot majors and unreadable bumps, never merges them', () => {
    const bot = { login: 'dependabot[bot]', type: 'Bot' };
    const dep = (title, body = '') => go(pr({ user: bot, author_association: 'NONE', title }), files, run(), [], live({ body }));
    expect(dep('chore(deps): bump x from 1.2.3 to 2.0.0').kind).toBe('held');
    expect(dep('chore(deps): bump x').kind).toBe('held');
    expect(dep('chore(deps): bump x from 1.2.3 to 1.3.0', 'Updates y from 3.0.0 to 4.0.0').kind).toBe('held');
    expect(dep('chore(deps): bump x from 0.4.1 to 0.5.0').kind).toBe('held');
    expect(dep('chore(deps): bump x from 0.4.1 to 0.4.2').action).toBe('merge');
  });
});

describe('required check set', () => {
  it('ignores the non-fatal tests-required step; coverage success or skipped (or waived failure), e2e success', () => {
    expect(verifyVerdict(run(), true).ok).toBe(true);
    expect(verifyVerdict(run({ 'coverage (changed files)': 'skipped' }), true).ok).toBe(true);
    expect(verifyVerdict(run({ 'coverage (changed files)': 'failure' }), true).ok).toBe(false);
    expect(verifyVerdict(run({ 'tests-required': 'failure' }), true).ok).toBe(true);
    const covFail = run({ 'coverage (changed files)': 'failure' }, { conclusion: 'failure' });
    covFail.jobs[0].conclusion = 'failure';
    expect(verifyVerdict(covFail, true, true).ok).toBe(true);
    expect(verifyVerdict(covFail, true, false).ok).toBe(false);
    const both = run({ 'coverage (changed files)': 'failure', lint: 'failure' }, { conclusion: 'failure' });
    both.jobs[0].conclusion = 'failure';
    expect(verifyVerdict(both, true, true).ok).toBe(false);
    expect(verifyVerdict(run({ 'e2e (Playwright)': 'failure' }), true).ok).toBe(false);
  });

  it('a skipped e2e step is fine only when the app did not change', () => {
    expect(verifyVerdict(run({ 'e2e (Playwright)': 'skipped' }), false).ok).toBe(true);
    expect(verifyVerdict(run({ 'e2e (Playwright)': 'skipped' }), true).ok).toBe(false);
  });

  it('a docs-only PR can merge with everything heavy skipped', () => {
    const docs = [f('README.md')];
    const skipped = run({ 'coverage (changed files)': 'skipped', 'e2e (Playwright)': 'skipped', lint: 'skipped' });
    expect(decide(pr({ title: 'docs: update readme' }), docs, skipped, [], live()).action).toBe('merge');
  });

  it('the verify job itself must have succeeded', () => {
    const bad = run();
    bad.jobs[0].conclusion = 'failure';
    expect(verifyVerdict(bad, true).ok).toBe(false);
    expect(verifyVerdict({ run: run().run, jobs: [] }, true).ok).toBe(false);
  });

  it('ignores bot jobs and verify when scanning other checks, and takes the latest of duplicates', () => {
    const slug = { slug: 'github-actions' };
    const checks = [
      { id: 1, name: 'pr-status', status: 'in_progress', conclusion: null, app: slug },
      { id: 2, name: 'verify', status: 'completed', conclusion: 'failure', app: slug },
      { id: 3, name: 'rust', status: 'completed', conclusion: 'failure', app: slug },
      { id: 9, name: 'rust', status: 'completed', conclusion: 'success', app: slug },
    ];
    expect(otherChecksVerdict(checks).ok).toBe(true);
  });

  it('picks the latest run by id', () => {
    expect(pickLatestRun([{ id: 1 }, { id: 7 }, { id: 3 }]).id).toBe(7);
    expect(pickLatestRun([])).toBeNull();
  });
});

describe('trusted CI runs', () => {
  const pull = pr();
  const goodRun = { id: 5, head_repository: { full_name: REPO }, head_branch: 'feat/rollover', head_sha: SHA, path: '.github/workflows/ci.yml', created_at: '2026-10-01T10:00:00Z' };

  it('accepts only this repo, this head branch and sha, and ci.yml', () => {
    expect(trustedRuns([goodRun], REPO, pull)).toHaveLength(1);
    expect(trustedRuns([{ ...goodRun, head_repository: { full_name: 'x/burrow' } }], REPO, pull)).toHaveLength(0);
    expect(trustedRuns([{ ...goodRun, head_branch: 'other' }], REPO, pull)).toHaveLength(0);
    expect(trustedRuns([{ ...goodRun, path: '.github/workflows/evil.yml' }], REPO, pull)).toHaveLength(0);
    expect(trustedRuns([{ ...goodRun, head_sha: 'b'.repeat(40) }], REPO, pull)).toHaveLength(0);
  });

  it('a base_ref_changed event newer than the run, or a moved base sha, is stale', () => {
    expect(staleReason(goodRun, pull, [{ event: 'base_ref_changed', created_at: '2026-10-01T11:00:00Z' }])).toContain('base changed');
    expect(staleReason(goodRun, pull, [{ event: 'base_ref_changed', created_at: '2026-10-01T09:00:00Z' }])).toBeNull();
    expect(staleReason(goodRun, pull, [{ event: 'labeled', created_at: '2026-10-02T09:00:00Z' }])).toBeNull();
    const tested = { ...goodRun, pull_requests: [{ number: 12, base: { sha: 'old' } }] };
    expect(staleReason(tested, { ...pull, base: { ref: 'main', sha: 'new' } }, [])).toContain('moved');
  });

  it('verifyVerdict waits on a stale run', () => {
    expect(verifyVerdict({ ...run(), stale: 'the base changed' }, true)).toMatchObject({ ok: false, pending: true });
  });

  it('getRunInfo ignores foreign runs and reports staleness', async () => {
    const foreign = { ...goodRun, id: 9, head_repository: { full_name: 'x/burrow' } };
    const api = {
      get: vi.fn(async (p) => (p.includes('/jobs') ? { jobs: [] } : { workflow_runs: [foreign, goodRun] })),
      paginate: vi.fn(async () => [{ event: 'base_ref_changed', created_at: '2026-10-01T11:00:00Z' }]),
    };
    const info = await getRunInfo(api, REPO, pull);
    expect(info.run.id).toBe(5);
    expect(info.stale).toContain('base changed');
    expect(await getRunInfo({ ...api, get: async () => ({ workflow_runs: [foreign] }) }, REPO, pull)).toBeNull();
  });
});

describe('gate files and package.json', () => {
  it('covers every file that can weaken a check', () => {
    for (const p of ['eslint.config.js', '.npmrc', 'server/__tests__/setup/dataDir.js', 'server/__tests__/helpers/testDb.js', 'server/db/migrations.lock.json', '.gitleaksignore', 'coverage/lcov.info', 'playwright.config.js', 'e2e/support/x.js', 'vite.config.js', 'scripts/lib/sandboxSafety.js', 'scripts/checks/bundle-budget.json', 'scripts/license/sign.js', 'config/store.json', 'Dockerfile', 'src-tauri/capabilities/main.json']) {
      expect(gateFilesIn([f(p)]), p).toEqual([p]);
    }
  });

  const pkg = (over = {}) => JSON.stringify({ name: 'x', scripts: { test: 'vitest' }, engines: { node: '22' }, dependencies: { a: '1.0.0' }, ...over });

  it('allows dependency version changes only', () => {
    expect(packageJsonGate(pkg(), pkg({ dependencies: { a: '1.0.1', b: '2.0.0' } }))).toBeNull();
    for (const over of [{ scripts: { test: 'vitest', prepare: 'node x.js' } }, { engines: { node: '24' } }, { overrides: { a: '1' } }, { workspaces: ['w'] }]) {
      expect(packageJsonGate(pkg(), pkg(over)), JSON.stringify(over)).toContain('package.json');
    }
    expect(packageJsonGate('{', pkg())).toContain('could not be compared');
  });

  it('fetches base and head through the contents API; unreadable means human', async () => {
    const enc = (t) => ({ encoding: 'base64', content: Buffer.from(t).toString('base64') });
    const pull = pr({ base: { ref: 'main', sha: 'b'.repeat(40) } });
    const api = { get: async (p) => enc(p.includes(SHA) ? pkg({ scripts: {} }) : pkg()) };
    expect(await packageGateFor(api, REPO, pull, [f('package.json')])).toContain('package.json');
    expect(await packageGateFor(api, REPO, pull, [f('src/a.js')])).toBeNull();
    const broken = {
      get: async () => {
        throw new Error('x');
      },
    };
    expect(await packageGateFor(broken, REPO, pull, [f('package.json')])).toContain('could not be compared');
  });
});

describe('dependabot verdict', () => {
  it('parses titles, bodies and tables; majors, 0.x minors and unparseable input are held', () => {
    expect(dependabotVerdict('bump x from 1.0.0 to 1.4.2', '').ok).toBe(true);
    expect(dependabotVerdict('bump x from 1.0.0 to 2.0.0', '').ok).toBe(false);
    expect(dependabotVerdict('bump x', '').ok).toBe(false);
    expect(dependabotVerdict('bump x from 1.0.0 to 1.0.1', '| y | 4.1.0 | 5.0.0 |').ok).toBe(false);
    expect(dependabotVerdict('bump x from 1.0.0 to latest', '').ok).toBe(false);
    expect(dependabotVerdict(null, null).ok).toBe(false);
    expect(isMajorBump({ major: 0, minor: 1, patch: 0 }, { major: 0, minor: 2, patch: 0 })).toBe(true);
    expect(isMajorBump({ major: 0, minor: 1, patch: 0 }, { major: 0, minor: 1, patch: 5 })).toBe(false);
  });

  it('dependabot.yml sets a valid cooldown', () => {
    const y = read('.github/dependabot.yml');
    expect(y).toMatch(/cooldown:\s*\n\s+default-days: \d+/);
    expect(y).toMatch(/semver-major-days: \d+/);
  });
});

describe('runMerge reports the merge for the main run dispatch', () => {
  const mk = ({ ciSuccess, put }) => {
    const pull = pr({ labels: [], body: '', base: { ref: 'main', sha: 'b'.repeat(40) } });
    const workflowRun = { id: 99, status: 'completed', conclusion: ciSuccess ? 'success' : 'failure', head_repository: { full_name: REPO }, head_branch: 'feat/rollover', head_sha: SHA, path: '.github/workflows/ci.yml', created_at: '2026-10-01T10:00:00Z' };
    return {
      get: vi.fn(async (p) => {
        if (p.includes('/actions/workflows/')) return { workflow_runs: [workflowRun] };
        if (p.includes('/jobs')) return { jobs: [{ name: 'verify', status: 'completed', conclusion: ciSuccess ? 'success' : 'failure', steps: steps() }] };
        if (p.includes('/artifacts')) return { artifacts: [] };
        if (p.includes('/git/ref/')) return { object: { sha: SHA } };
        if (p.includes('/pulls?')) return [];
        return pull;
      }),
      paginate: vi.fn(async (p) => (p.endsWith('/files') ? [{ filename: 'src/pages/Budget.jsx', status: 'modified' }, { filename: 'src/pages/__tests__/Budget.test.jsx', status: 'added' }] : [])),
      put,
      post: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      del: vi.fn(async () => null),
    };
  };

  it('sets merged only after GitHub accepted the merge', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = mk({ ciSuccess: true, put: vi.fn(async () => ({ sha: 'c'.repeat(40) })) });
    const out = { merged: false };
    expect(await runMerge(api, REPO, 12, SHA, out)).toBe(0);
    log.mockRestore();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(out.merged).toBe(true);
  });

  it('leaves merged false when the bot does not merge', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = mk({ ciSuccess: false, put: vi.fn() });
    const out = { merged: false };
    expect(await runMerge(api, REPO, 12, SHA, out)).toBe(0);
    log.mockRestore();
    expect(api.put).not.toHaveBeenCalled();
    expect(out.merged).toBe(false);
  });
});

describe('mergeability retry and branch deletion', () => {
  it('retries a null mergeable up to 3 times with backoff', async () => {
    const base = { number: 1, state: 'open', head: { sha: SHA, repo: { full_name: REPO } }, base: { ref: 'main' }, labels: [] };
    const answers = [{ mergeable: null }, { mergeable: null }, { mergeable: true }].map((a) => ({ ...base, ...a }));
    let i = 0;
    const api = {
      get: vi.fn(async (p) => (/\/pulls\/1$/.test(p) ? answers[Math.min(i++, 2)] : { workflow_runs: [] })),
      paginate: vi.fn(async () => []),
    };
    const sleeps = [];
    const out = await gather(api, REPO, 1, { sleepImpl: async (ms) => sleeps.push(ms), backoffMs: [1, 2, 3] });
    expect(sleeps).toEqual([1, 2]);
    expect(out.pr.mergeable).toBe(true);
  });

  it('never deletes a base of an open PR or a ref that moved; deletes the merged ref', async () => {
    const pull = { number: 3, head: { ref: 'feat/x', sha: SHA, repo: { full_name: REPO } } };
    const mk = ({ stacked = [], sha = SHA } = {}) => ({
      get: vi.fn(async (p) => (p.includes('base=') ? stacked : p.includes('/git/ref/') ? { object: { sha } } : [])),
      del: vi.fn(async () => ({})),
    });
    const ok = mk();
    await deleteMergedBranch(ok, REPO, pull);
    expect(ok.del).toHaveBeenCalledTimes(1);
    const stacked = mk({ stacked: [{ number: 4 }] });
    await deleteMergedBranch(stacked, REPO, pull);
    expect(stacked.del).not.toHaveBeenCalled();
    const moved = mk({ sha: 'c'.repeat(40) });
    await deleteMergedBranch(moved, REPO, pull);
    expect(moved.del).not.toHaveBeenCalled();
  });

  it('branchVerdict keeps the base of an open PR', () => {
    const b = { name: 'feat/x', protected: false, commit: { sha: 'tip' } };
    const m = { state: 'closed', merged_at: '2026-10-05T00:00:00Z', head: { ref: 'feat/x', sha: 'tip', repo: { full_name: REPO } } };
    const ctx = { repo: REPO, defaultBranch: 'main', now: Date.parse('2026-10-10T12:00:00Z') };
    expect(branchVerdict(b, [m], { ...ctx, isBase: true }).delete).toBe(false);
    expect(branchVerdict(b, [m], ctx).delete).toBe(true);
  });
});

describe('tests-required e2e and coverage guards', () => {
  it('only real e2e spec files count as tests', () => {
    const src = [f('src/utils/a.js', 'added')];
    for (const t of ['e2e/flows/a.spec.js', 'e2e/x.test.mjs', 'e2e/a/b.spec.ts']) expect(evaluateTestsRequired({ files: [...src, f(t)] }).ok, t).toBe(true);
    for (const t of ['e2e/support/fixtures.js', 'e2e/pages/p.js', 'e2e/visual/a.png', 'e2e/flows/readme.md']) expect(evaluateTestsRequired({ files: [...src, f(t)] }).ok, t).toBe(false);
  });

  it('cleanCoverage removes a stale coverage folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-cov-'));
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), '{}');
    cleanCoverage(root);
    expect(fs.existsSync(path.join(root, 'coverage'))).toBe(false);
    cleanCoverage(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('sticky comment', () => {
  const base = { sha: SHA, number: 12, repo: REPO, runInfo: run(), checkRuns: [], decision: { action: 'merge', kind: 'merge', reason: 'ok' }, appChanged: true, artifact: null };

  it('starts with the marker and lists the step rows', () => {
    const body = renderComment(base);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('aaaaaaa');
    for (const label of ['hygiene', 'lint', 'tests-required', 'unit tests', 'coverage (changed files)', 'build', 'bundle budget', 'e2e (Playwright)']) {
      expect(body).toContain(`| ${label} | passed |`);
    }
    expect(body).toContain('npm run preview:branch -- "#12"');
  });

  it('shows running, failed and skipped states, and the hygiene group', () => {
    const rows = stepRows(run({ 'hygiene: dev keys': 'failure', 'unit tests': null, build: 'skipped' }));
    const state = (l) => rows.find((r) => r.label === l).state;
    expect(state('hygiene')).toBe('FAILED');
    expect(state('unit tests')).toBe('running');
    expect(state('build')).toBe('skipped');
    expect(stepRows(null).every((r) => r.state === 'not run yet')).toBe(true);
  });

  it('describes each auto-merge state', () => {
    const line = (decision, extra = {}) => renderComment({ ...base, decision, ...extra });
    expect(line({ action: 'none', kind: 'held', reason: HOLD_REASON })).toContain('held: the `hold` label');
    expect(line({ action: 'none', kind: 'held', reason: 'a major update' })).toContain('held: a major update');
    expect(line({ action: 'none', kind: 'human', reason: 'it changes .github/x' })).toContain('needs a human merge: it changes .github/x');
    expect(line({ action: 'none', kind: 'waiting', reason: 'CI is still running' })).toContain('waiting: CI is still running');
    expect(line(base.decision, { mergedSha: 'abcdef1234567' })).toContain('Merged as `abcdef1`');
  });

  it('links the web-dist artifact by numeric ids only, or explains why there is none', () => {
    expect(renderComment({ ...base, artifact: { runId: 99, id: 1234 } })).toContain(`https://github.com/${REPO}/actions/runs/99/artifacts/1234`);
    expect(renderComment({ ...base, artifact: { runId: '99/../x', id: 1 } })).toContain('not available yet');
    expect(renderComment({ ...base, appChanged: false })).toContain('none (no app change)');
  });

  it('escapes untrusted text and cannot fake the marker', () => {
    const evil = 'x | y <!-- burrow-pr-bot --> `code` [l](http://e.test) @octocat <script>';
    const body = renderComment({
      ...base,
      decision: { action: 'none', kind: 'human', reason: evil },
      checkRuns: [{ id: 1, name: evil, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
    });
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body.split(MARKER).length).toBe(2);
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('@octocat');
    expect(body).not.toContain('[l](');
    expect(body).toContain('\\|');
    expect(escapeMd('a'.repeat(300)).length).toBeLessThanOrEqual(120);
    expect(escapeMd('line1\nline2\r\n| `x`')).toBe('line1 line2 \\| &#96;x&#96;');
  });

  it('only a github-actions[bot] comment that starts with the marker is the sticky one', () => {
    const forged = { id: 1, user: { login: 'someone' }, body: `${MARKER}\nfake` };
    const real = { id: 2, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nreal` };
    const quoted = { id: 3, user: { login: 'github-actions[bot]' }, body: `see ${MARKER}` };
    expect(findSticky([forged, quoted, real]).id).toBe(2);
    expect(findSticky([forged, quoted])).toBeNull();
  });

  describe('visual snapshot diffs (from the verify job annotations, no artifact)', () => {
    const fail = (message, title = '[visual] \u203A visual/screens.spec.js:10:5 \u203A home dark') => ({ annotation_level: 'failure', title, message });
    const shot = (name) => `1) x\n  Error: Screenshot comparison failed:\n  Expected: /work/e2e/__screenshots__/${name}\n  Received: test-results/a-actual.png`;

    it('lists the differing or missing snapshot files, unique and sorted', () => {
      const names = visualDiffNames([
        fail(shot('screens.spec.js/home-dark.png')),
        fail(shot('screens.spec.js/budget-light.png')),
        fail(shot('screens.spec.js/home-dark.png')),
        fail("A snapshot doesn't exist at C:\\work\\e2e\\__screenshots__\\onboarding.spec.js\\step1-dark.png, writing actual."),
      ]);
      expect(names).toEqual(['onboarding.spec.js/step1-dark.png', 'screens.spec.js/budget-light.png', 'screens.spec.js/home-dark.png']);
    });

    it('ignores other projects, non-failures and anything that is not a plain png path', () => {
      expect(visualDiffNames([fail(shot('a.spec.js/x.png'), '[a11y] \u203A a11y/dark.spec.js:3:3 \u203A home')])).toEqual([]);
      expect(visualDiffNames([{ annotation_level: 'warning', title: '[visual] \u203A x', message: shot('a.spec.js/x.png') }])).toEqual([]);
      expect(visualDiffNames([fail('__screenshots__/a.spec.js/x y.png and __screenshots__/../../etc/passwd')])).toEqual([]);
      expect(visualDiffNames([fail('__screenshots__/../../evil.png')])).toEqual([]);
      expect(visualDiffNames(null)).toEqual([]);
      expect(visualDiffNames(Array.from({ length: 40 }, (_, i) => fail(shot(`s.spec.js/n${String(i).padStart(2, '0')}.png`)))).length).toBe(20);
    });

    it('is shown in the comment with a link to the run, and absent when nothing differs', () => {
      const body = renderComment({ ...base, visualDiffs: ['screens.spec.js/home-dark.png'] });
      expect(body).toContain('**Visual snapshots that differ or are missing (1):**');
      expect(body).toContain('- `screens.spec.js/home-dark.png`');
      expect(body).toContain(`https://github.com/${REPO}/actions/runs/99`);
      expect(body.indexOf('Visual snapshots')).toBeLessThan(body.indexOf('Preview locally'));
      expect(renderComment({ ...base, visualDiffs: [] })).not.toContain('Visual snapshots');
      expect(renderComment({ ...base })).not.toContain('Visual snapshots');
    });

    it('caps a snapshot name at 200 characters, in the reader and again in the comment', () => {
      const ok = `${'a'.repeat(196)}.png`;
      const tooLong = `${'a'.repeat(197)}.png`;
      expect(ok).toHaveLength(200);
      expect(visualDiffNames([fail(shot(`s.spec.js/${'b'.repeat(190)}.png`))])).toEqual([]);
      expect(visualDiffNames([fail(shot(ok)), fail(shot(tooLong))])).toEqual([ok]);
      const body = renderComment({ ...base, visualDiffs: [ok, tooLong] });
      expect(body).toContain('(1):');
      expect(body).toContain(`\`${ok}\``);
      expect(body).not.toContain(tooLong);
    });

    it('only passes plain png names into the comment', () => {
      const body = renderComment({ ...base, visualDiffs: ['a b.png', '[x](http://e.test).png', '<script>.png', 'ok/fine-1.png'] });
      expect(body).toContain('(1):');
      expect(body).toContain('`ok/fine-1.png`');
      expect(body).not.toContain('<script>');
    });

    it('visualDiffsFor reads the annotations of a failed verify job only, and never throws', async () => {
      const annotations = [fail(shot('screens.spec.js/home-dark.png'))];
      const api = { get: vi.fn(async () => annotations) };
      const failed = { run: { id: 99 }, jobs: [{ id: 555, name: 'verify', conclusion: 'failure', steps: [] }] };
      expect(await visualDiffsFor(api, REPO, failed)).toEqual(['screens.spec.js/home-dark.png']);
      expect(api.get).toHaveBeenCalledWith(`/repos/${REPO}/check-runs/555/annotations?per_page=100`);
      api.get.mockClear();
      expect(await visualDiffsFor(api, REPO, { ...failed, jobs: [{ id: 555, name: 'verify', conclusion: 'success' }] })).toEqual([]);
      expect(await visualDiffsFor(api, REPO, { run: { id: 99 }, jobs: [{ name: 'verify', conclusion: 'failure' }] })).toEqual([]);
      expect(await visualDiffsFor(api, REPO, null)).toEqual([]);
      expect(api.get).not.toHaveBeenCalled();
      const broken = { get: vi.fn(async () => { throw new Error('403'); }) };
      expect(await visualDiffsFor(broken, REPO, failed)).toEqual([]);
    });
  });
});

describe('branch cleanup selection', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z');
  const ctx = { repo: REPO, defaultBranch: 'main', now: NOW };
  const branch = (over = {}) => ({ name: 'feat/x', protected: false, commit: { sha: 'tip' }, ...over });
  const merged = (over = {}) => ({ state: 'closed', merged_at: '2026-10-05T00:00:00Z', head: { ref: 'feat/x', sha: 'tip', repo: { full_name: REPO } }, ...over });

  it('deletes a merged, unchanged branch older than 2 days', () => {
    expect(branchVerdict(branch(), [merged()], ctx).delete).toBe(true);
  });

  it('keeps main, protected and release-please branches', () => {
    expect(branchVerdict(branch({ name: 'main' }), [merged()], ctx).delete).toBe(false);
    expect(branchVerdict(branch({ protected: true }), [merged()], ctx).delete).toBe(false);
    expect(branchVerdict(branch({ name: 'release-please--branches--main' }), [merged({ head: { ref: 'release-please--branches--main', sha: 'tip', repo: { full_name: REPO } } })], ctx).delete).toBe(false);
  });

  it('keeps a branch with an open PR, new commits, a young merge, a closed-unmerged PR or a fork PR', () => {
    expect(branchVerdict(branch(), [merged(), { ...merged(), state: 'open', merged_at: null }], ctx).delete).toBe(false);
    expect(branchVerdict(branch({ commit: { sha: 'newer' } }), [merged()], ctx).delete).toBe(false);
    expect(branchVerdict(branch(), [merged({ merged_at: new Date(NOW - MIN_AGE_MS + 1000).toISOString() })], ctx).delete).toBe(false);
    expect(branchVerdict(branch(), [merged({ merged_at: null })], ctx).delete).toBe(false);
    expect(branchVerdict(branch(), [merged({ head: { ref: 'feat/x', sha: 'tip', repo: { full_name: 'fork/burrow' } } })], ctx).delete).toBe(false);
    expect(branchVerdict(branch(), [], ctx).delete).toBe(false);
  });
});

describe('flaky report', () => {
  const report = (over = {}) => ({ runs: 3, failedRuns: 1, project: 'all', os: 'ubuntu-latest', sha: 'abcdef1234', rows: [{ test: 'server/a.test.js :: a | b', count: 1 }], ...over });

  it('collects failing tests from vitest json and tallies them', () => {
    const result = { testResults: [{ name: '/w/server/a.test.js', assertionResults: [{ status: 'passed', fullName: 'ok' }, { status: 'failed', fullName: 'bad' }] }] };
    const lines = collectFailures(result, '/w');
    expect(lines).toEqual(['/server/a.test.js :: bad']);
    expect(tally([...lines, ...lines, 'z :: y'])).toEqual([
      { test: '/server/a.test.js :: bad', count: 2 },
      { test: 'z :: y', count: 1 },
    ]);
  });

  it('marks 3 of 3 failures as failing on main, not flaky', () => {
    expect(isHardFailure(report({ failedRuns: 3 }))).toBe(true);
    expect(isHardFailure(report())).toBe(false);
    const body = buildReportBody({ date: '2026-10-10', runUrl: 'https://x/run/1', report: report({ failedRuns: 3 }) });
    expect(body).toContain('Failing on main, not flaky');
    expect(body).toContain('2026-10-10');
    expect(body).toContain('https://x/run/1');
    expect(buildReportBody({ date: 'd', runUrl: 'u', report: report() })).toContain('1 of 3 runs failed');
  });

  it('escapes test names in the table', () => {
    const body = buildReportBody({ date: 'd', runUrl: 'u', report: report({ rows: [{ test: 'x | <b>y</b>', count: 2 }] }) });
    expect(body).toContain('x \\| &lt;b&gt;y&lt;/b&gt;');
  });

  it('writes comments for clean, failing and report-less runs', () => {
    expect(buildComment({ date: 'd', runUrl: 'u', report: report({ failedRuns: 0 }) })).toContain('clean run');
    expect(buildComment({ date: 'd', runUrl: 'u', report: report({ failedRuns: 3 }) })).toContain('not flaky');
    expect(buildComment({ date: 'd', runUrl: 'u', report: null })).toContain('before it produced a report');
  });

  it('finds only the bot-authored open issue with the exact title', () => {
    const issues = [
      { number: 1, title: ISSUE_TITLE, user: { login: 'someone' } },
      { number: 2, title: ISSUE_TITLE, user: { login: 'github-actions[bot]' }, pull_request: {} },
      { number: 3, title: 'Other', user: { login: 'github-actions[bot]' } },
      { number: 4, title: ISSUE_TITLE, user: { login: 'github-actions[bot]' } },
    ];
    expect(findFlakyIssue(issues).number).toBe(4);
    expect(findFlakyIssue(issues.slice(0, 3))).toBeNull();
  });
});

describe('bundle initial JS metric', () => {
  const html = `<script>inline()</script>
    <script type="module" crossorigin src="/assets/index-A.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-B.js">
    <link rel="modulepreload" href="/assets/index-A.js?x=1">
    <link rel="stylesheet" crossorigin href="/assets/index-C.css">
    <script src="/assets/classic-D.js"></script>`;

  it('lists the entry module and modulepreload scripts only', () => {
    expect(initialAssetNames(html)).toEqual(['index-A.js', 'react-B.js']);
  });

  it('sums their gzip size and leaves the old summary shape alone without it', () => {
    const assets = [
      { name: 'index-A.js', gzipBytes: 2048 },
      { name: 'react-B.js', gzipBytes: 1024 },
      { name: 'Lazy-E.js', gzipBytes: 4096 },
      { name: 'index-C.css', gzipBytes: 512 },
    ];
    expect(summarize(assets, ['index-A.js', 'react-B.js']).initialJsGzipKb).toBe(3);
    expect('initialJsGzipKb' in summarize(assets)).toBe(false);
  });

  it('checks the key only when the budget has it', () => {
    const measured = { totalJsGzipKb: 1, largestJsGzipKb: 1, totalCssGzipKb: 1, initialJsGzipKb: 5 };
    const old = { totalJsGzipKb: 2, largestJsGzipKb: 2, totalCssGzipKb: 2 };
    expect(evaluate(measured, old).rows).toHaveLength(3);
    expect(evaluate(measured, old).ok).toBe(true);
    const withKey = evaluate(measured, { ...old, initialJsGzipKb: 4 });
    expect(withKey.ok).toBe(false);
    expect(budgetMarkdown(withKey.rows)).toContain('initialJsGzipKb | 5 | 4 | OVER');
    expect(evaluate(measured, { ...old, initialJsGzipKb: 5 }).ok).toBe(true);
  });

  it('the committed budget has the key, and total JS is raised to 470 while largest JS, CSS and initial JS are not', () => {
    const budget = JSON.parse(read('scripts/checks/bundle-budget.json'));
    expect(typeof budget.initialJsGzipKb).toBe('number');
    expect(budget.totalJsGzipKb).toBeLessThanOrEqual(470);
    expect(budget.largestJsGzipKb).toBeLessThanOrEqual(125);
    expect(budget.initialJsGzipKb).toBeLessThanOrEqual(146);
    expect(budget.totalCssGzipKb).toBeLessThanOrEqual(31.9);
  });
});

describe('labels', () => {
  it('defines the four labels with gh arguments and no shell', () => {
    expect(LABELS.map((l) => l.name)).toEqual(['hold', 'no-tests-needed', 'flaky', 'good-first-task']);
    expect(labelArgs(LABELS[0])).toEqual(['label', 'create', 'hold', '--color', 'b60205', '--description', 'Never auto-merge', '--force']);
  });

  it('stops at the first failure with a hint', () => {
    const calls = [];
    const code = setupLabels((cmd, args, opts) => {
      calls.push([cmd, args[2], opts.shell]);
      return { status: calls.length === 2 ? 1 : 0 };
    });
    expect(code).toBe(1);
    expect(calls).toEqual([['gh', 'hold', false], ['gh', 'no-tests-needed', false]]);
  });
});

describe('Playwright image pin', () => {
  it('uses the exact @playwright/test version and a digest', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const version = lock.packages['node_modules/@playwright/test'].version;
    expect(PLAYWRIGHT_IMAGE).toMatch(new RegExp(`^mcr\\.microsoft\\.com/playwright:v${version.replace(/\./g, '\\.')}-noble@sha256:[0-9a-f]{64}$`));
    expect(JSON.parse(read('package.json')).devDependencies['@playwright/test']).toBe(version);
  });

  it('ci.yml and flaky.yml contain the same image string', () => {
    expect(read('.github/workflows/ci.yml')).toContain(PLAYWRIGHT_IMAGE);
    expect(read('.github/workflows/flaky.yml')).toContain(PLAYWRIGHT_IMAGE);
  });
});

// ---- Static guards over the workflow files ----

const WORKFLOWS = fs.readdirSync(path.join(REPO_ROOT, '.github', 'workflows')).filter((n) => n.endsWith('.yml'));

/** Text of every `run:` block (inline or literal) in a workflow file. */
function runBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && !/^[|>][+-]?$/.test(m[2])) {
      blocks.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('workflow files', () => {
  it('the expected set exists and hygiene.yml is gone', () => {
    for (const name of ['ci.yml', 'pr-bot.yml', 'flaky.yml', 'branch-cleanup.yml', 'desktop-check.yml']) expect(WORKFLOWS).toContain(name);
    for (const name of presentWorkflows(['release-please.yml', 'release.yml'])) expect(WORKFLOWS).toContain(name);
    expect(WORKFLOWS).not.toContain('hygiene.yml');
  });

  it.each(WORKFLOWS)('%s pins every action by full commit SHA with a version comment', (name) => {
    const uses = read(`.github/workflows/${name}`)
      .split(/\r?\n/)
      .filter((l) => /^\s*(?:- )?uses:/.test(l));
    for (const line of uses) {
      if (/uses:\s*\.\//.test(line)) continue;
      expect(line, line).toMatch(/uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+(\.\d+)*/);
    }
  });

  it.each(WORKFLOWS)('%s sets top-level permissions', (name) => {
    expect(read(`.github/workflows/${name}`)).toMatch(/^permissions:/m);
  });

  it.each(WORKFLOWS)('%s keeps untrusted values out of run: lines', (name) => {
    const forbidden = /\$\{\{[^}]*(github\.event\.(pull_request|issue|comment|review|workflow_run|head_commit|commits|pages)|github\.head_ref|inputs\.)[^}]*\}\}/;
    for (const block of runBlocks(read(`.github/workflows/${name}`))) expect(block).not.toMatch(forbidden);
  });

  it('ci.yml has the step names pr-bot reads and one required job named verify', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const step of ['name: tests-required', 'name: coverage (changed files)', 'name: e2e (Playwright)', 'name: classify', 'name: tools']) expect(ci).toContain(step);
    expect(ci).toContain("\n  verify:\n    name: verify\n    if: github.event_name != 'push'");
  });

  it('ci.yml: a manual full run on main runs the sharded main jobs instead of verify', () => {
    const ci = read('.github/workflows/ci.yml');
    const mainRun = "github.event_name == 'workflow_dispatch' && inputs.mode == 'full' && github.ref == 'refs/heads/main'";
    expect(ci).toContain(`if: github.event_name != 'push' && inputs.mode != 'visual-update' && !(${mainRun})`);
    expect(ci.split(`(github.event_name == 'push' || (${mainRun}))`)).toHaveLength(3);
    expect(ci).not.toContain('so every main commit is tested');
  });

  it('ci.yml: bundle budget, web upload and e2e need a successful build; CHANGED_JSON comes from $RUNNER_TEMP', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/- name: build\n\s+id: build\n/);
    for (const name of ['bundle budget', 'Upload web build', 'e2e (Playwright)']) {
      const at = ci.indexOf(`- name: ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      expect(ci.slice(at, at + 400), name).toContain("steps.build.outcome == 'success'");
    }
    expect(ci).not.toContain('runner.temp');
    expect(ci.match(/CHANGED_JSON="\$RUNNER_TEMP\/changed\.json"/g)).toHaveLength(3);
  });

  it('ci.yml: the trusted-config step verifies the base ref, separates a missing file from a missing ref and fails closed on git diff errors', () => {
    const ci = read('.github/workflows/ci.yml');
    const at = ci.indexOf('- name: "hygiene: trusted config"');
    const step = ci.slice(at, ci.indexOf('- name: "hygiene: gitleaks"'));
    expect(step).toContain('git rev-parse --verify "origin/${BASE_REF}^{commit}"');
    expect(step.indexOf('git rev-parse --verify')).toBeLessThan(step.indexOf('git diff'));
    expect(step).toContain('git cat-file -e "origin/${BASE_REF}:${GITLEAKS_CONFIG}"');
    expect(step).toContain('git cat-file -e "origin/${BASE_REF}:${ALLOW_FILE}"');
    expect(step).toContain('git cat-file -e "origin/${BASE_REF}:.gitleaksignore"');
    expect(step).toContain('if ! changed="$(git diff --name-only');
    expect(step).toContain('if ! git diff --no-color --text -U0');
    expect(step).not.toMatch(/\|\| true\)"\n\s+if \[ -n "\$changed"/);
    expect(step).not.toContain('2>/dev/null; then\n              GITLEAKS_CONFIG');
    expect(step.match(/exit 1/g).length).toBeGreaterThanOrEqual(4);
  });

  it('ci.yml runs on main pushes with docs-only paths ignored, never cancelled, and sharded three ways', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/push:\n\s+branches: \[main\]\n\s+paths-ignore: \['\*\*\/\*\.md', 'docs\/\*\*', 'LICENSE'\]/);
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).toContain("github.event_name == 'push' && github.sha");
    expect(ci).toContain('matrix:\n        shard: [1, 2, 3]');
    expect(ci).toContain('npx vitest run --shard=${{ matrix.shard }}/3');
    const mainJobs = ci.slice(ci.indexOf('\n  main-unit:'));
    expect(mainJobs).not.toMatch(/playwright|tests-required|coverage \(changed|upload-artifact|check:/);
    expect(mainJobs.match(/if: \(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'full' && github\.ref == 'refs\/heads\/main'\)\)/g)).toHaveLength(2);
  });

  it('pr-bot.yml only reacts to workflow runs of pull_request events, so main pushes and release dispatches never merge', () => {
    const bot = read('.github/workflows/pr-bot.yml');
    expect(bot).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(bot).toMatch(/workflows: \[CI, Desktop check\]/);
  });

  it('pr-bot.yml never checks out the PR head and only runs trusted scripts', () => {
    const bot = read('.github/workflows/pr-bot.yml');
    expect(bot).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(bot).not.toMatch(/head\.sha\s*\}\}\s*\n\s*persist/);
    expect(bot).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.(pull_request|workflow_run)/);
    expect(bot).not.toContain('npm ci');
    expect(bot).toContain('persist-credentials: false');
  });

  it('ci.yml: trusted gitleaks ignore, no inline allow, non-fatal tests-required', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('--gitleaks-ignore-path "$GITLEAKS_IGNORE"');
    expect(ci).toContain('origin/${BASE_REF}:.gitleaksignore');
    expect(ci).toContain('marker="gitleaks:""allow"');
    expect(ci).toMatch(/- name: tests-required\n\s+if: [^\n]+\n\s+continue-on-error: true/);
  });

  it('pr-bot.yml: actions write only on the merge job (it dispatches the main run), same-repo pull_request_target, label job only on opened/reopened', () => {
    const bot = read('.github/workflows/pr-bot.yml');
    const noComments = bot.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(noComments.match(/actions:\s*write/g)).toHaveLength(1);
    const mergeJob = noComments.slice(noComments.indexOf('\n  merge:'), noComments.indexOf('\n  dependabot-hold:'));
    expect(mergeJob).toMatch(/permissions:[\s\S]*actions: write/);
    expect(mergeJob).toContain("if: steps.merge.outputs.merged == 'true'");
    expect(mergeJob).toContain('run: gh workflow run ci.yml --ref main -f mode=full');
    expect(noComments.match(/gh workflow run /g)).toHaveLength(1);
    expect(noComments).not.toContain('rerun');
    expect(bot).toMatch(/head\.repo\.full_name == github\.repository\s+&& contains\(fromJSON\('\["labeled","unlabeled","edited"\]'\)/);
    expect(bot).toContain(`contains(fromJSON('["opened","reopened"]'), github.event.action)`);
  });

  it.skipIf(!hasPrivateFile(WF('release-please.yml')))('release-please.yml dispatches only ci.yml (full mode), keeps the hold label, and accepts the component branch name', () => {
    const rp = read('.github/workflows/release-please.yml');
    const commands = runBlocks(rp).join('\n');
    expect(commands).toContain('gh workflow run ci.yml --ref "$branch" -f mode=full');
    expect(commands).not.toContain('hygiene.yml');
    expect(commands.match(/gh workflow run /g)).toHaveLength(1);
    expect(commands).toContain('gh label create hold');
    expect(commands).toContain('gh pr edit "$number" --add-label hold');
    const m = /\[\[ "\$branch" =~ (\^release-please[^ ]+) \]\]/.exec(commands);
    expect(m).not.toBeNull();
    const re = new RegExp(m[1]);
    expect(re.test('release-please--branches--main--components--burrow')).toBe(true);
    expect(re.test('release-please--branches--main')).toBe(true);
    expect(re.test('feat/release-please--branches--main')).toBe(false);
    expect(re.test('release-please--branches--main; rm -rf /')).toBe(false);
  });

  it.skipIf(!hasPrivateFile(WF('release-please.yml')))('release-please.yml builds the desktop installers and publishes on a release, on a daily schedule', () => {
    const rp = read('.github/workflows/release-please.yml');
    expect(rp).toContain('desktop: true');
    expect(rp).toContain('publish: release');
    expect(rp).toContain("cron: '23 5 * * *'");
  });

  it.skipIf(!hasAllPrivateFiles(WF('release.yml'), WF('desktop-windows.yml')))('the release builds native x64 and ARM64 Windows installers through desktop-windows.yml', () => {
    expect(read('.github/workflows/release.yml')).toContain('./.github/workflows/desktop-windows.yml');
    const win = read('.github/workflows/desktop-windows.yml');
    expect(win).toContain('aarch64-pc-windows-msvc');
    expect(win).toContain('x86_64-pc-windows-msvc');
  });
});

describe('hygiene steps in ci.yml (hygiene.yml merged into ci.yml, not removed)', () => {
  const ci = read('.github/workflows/ci.yml');
  const scripts = JSON.parse(read('package.json')).scripts;
  const stepNames = [...ci.matchAll(/^\s*- name: "?([^"\n]+)"?$/gm)].map((m) => m[1]);
  const stepBody = (name) => {
    const at = ci.indexOf(`- name: "${name}"`) >= 0 ? ci.indexOf(`- name: "${name}"`) : ci.indexOf(`- name: ${name}\n`);
    expect(at, name).toBeGreaterThan(-1);
    const next = ci.indexOf('\n      - ', at + 10);
    return ci.slice(at, next === -1 ? undefined : next);
  };

  it('the gitleaks step exists, pinned by checksum, and the workflow set has no hygiene.yml', () => {
    expect(stepNames).toContain('hygiene: gitleaks');
    expect(ci).toContain('GITLEAKS_SHA256:');
    expect(ci).toContain('sha256sum --check --strict');
    expect(stepBody('hygiene: gitleaks')).toContain('gitleaks" git --redact');
    expect(WORKFLOWS).not.toContain('hygiene.yml');
  });

  it.each([
    ['hygiene: em dash', 'check:em-dash'],
    ['hygiene: personal data', 'check:personal'],
    ['hygiene: keys', 'check:keys'],
    ['bundle budget', 'check:bundle'],
  ])('step "%s" runs npm run %s and the script exists', (step, script) => {
    expect(stepNames).toContain(step);
    expect(stepBody(step)).toContain(`run: npm run ${script}`);
    expect(scripts[script], script).toBeTypeOf('string');
  });

  it('the dev key check is gone from package.json and from ci.yml', () => {
    expect(scripts['check:dev' + 'keys']).toBeUndefined();
    expect(ci).not.toMatch(new RegExp('dev' + 'keys|no' + 'DevKeys', 'i'));
  });

  it.each(WORKFLOWS)('%s only references check:* scripts that exist in package.json', (name) => {
    const used = [...read(`.github/workflows/${name}`).matchAll(/npm run (check:[A-Za-z0-9:-]+)/g)].map((m) => m[1]);
    for (const script of used) expect(scripts[script], `${name} -> ${script}`).toBeTypeOf('string');
  });

  it('hygiene steps are unconditional, so manual runs and release PRs run them; a manual run has no base and runs the full suite', () => {
    const hygiene = stepNames.filter((n) => n.startsWith('hygiene'));
    expect(hygiene).toEqual(['hygiene: trusted config', 'hygiene: gitleaks', 'hygiene: em dash', 'hygiene: keys', 'hygiene: personal data']);
    for (const name of hygiene) expect(stepBody(name), name).not.toMatch(/\n\s+if:/);
    expect(changeKinds([], { isPullRequest: false }).fullSuite).toBe(true);
    expect(stepBody('unit tests')).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
  });
});

describe('artifact retention', () => {
  const retention = (name) => {
    const text = read(`.github/workflows/${name}`);
    return [...text.matchAll(/upload-artifact@[^\n]+\n\s+(?:if:[^\n]*\n\s+)?with:\n\s+name: ([^\n]+)\n(?:(?!\n\s*- ).*\n)*?\s+retention-days: (\d+)/g)].map((m) => [m[1], Number(m[2])]);
  };

  it('CI artifacts keep 1 day, the PR web preview 3 days', () => {
    expect(Object.fromEntries(retention('ci.yml'))).toEqual({ 'web-dist': 3, 'playwright-report': 1 });
  });

  it('flaky.yml artifacts keep 1 day', () => {
    expect(retention('flaky.yml').map(([, d]) => d)).toEqual([1, 1]);
  });

  it('every upload in every workflow sets a retention of at most 3 days', () => {
    for (const name of WORKFLOWS) {
      const text = read(`.github/workflows/${name}`);
      const uploads = text.match(/upload-artifact@/g) ?? [];
      const days = [...text.matchAll(/retention-days: (\d+)/g)].map((m) => Number(m[1]));
      expect(days, name).toHaveLength(uploads.length);
      for (const d of days) expect(d, name).toBeLessThanOrEqual(3);
    }
  });

  it.skipIf(!hasAllPrivateFiles(WF('release.yml'), WF('release-please.yml')))('the release workflows add no artifacts beyond the existing short-lived one', () => {
    expect(read('.github/workflows/release-please.yml')).not.toContain('upload-artifact');
    expect((read('.github/workflows/release.yml').match(/upload-artifact@/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('the preview and failure-report uploads are non-fatal, and there is no baseline artifact', () => {
    const ci = read('.github/workflows/ci.yml');
    const body = (name) => ci.slice(ci.indexOf(`- name: ${name}`), ci.indexOf('uses:', ci.indexOf(`- name: ${name}`)));
    expect(body('Upload web build')).toContain('continue-on-error: true');
    expect(body('Upload Playwright report')).toContain('continue-on-error: true');
    expect(ci).not.toContain('Upload visual baselines');
  });

  it('web-dist is uploaded only for pull requests', () => {
    const ci = read('.github/workflows/ci.yml');
    const at = ci.indexOf('name: Upload web build');
    expect(ci.slice(at, at + 400)).toContain("github.event_name == 'pull_request'");
  });
});

describe('visual-baselines job (visual-update mode pushes a side branch, no artifact)', () => {
  const ci = read('.github/workflows/ci.yml');
  const jobNames = [...ci.matchAll(/^ {2}([\w-]+):\n {4}name:/gm)].map((m) => m[1]);
  const jobBlock = (name) => {
    const at = ci.indexOf(`\n  ${name}:\n`);
    expect(at, name).toBeGreaterThan(-1);
    const rest = ci.slice(at + 1);
    const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const noComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const job = jobBlock('visual-baselines');

  it('exists and runs only for a workflow_dispatch in visual-update mode', () => {
    expect(jobNames).toContain('visual-baselines');
    expect(job).toContain("if: github.event_name == 'workflow_dispatch' && inputs.mode == 'visual-update'");
  });

  it('is the only job with contents: write; verify keeps contents: read and skips this mode', () => {
    for (const name of jobNames) {
      const block = noComments(jobBlock(name));
      if (name === 'visual-baselines') expect(block).toMatch(/permissions:\n\s+contents: write\n/);
      else expect(block, name).not.toMatch(/contents:\s*write/);
    }
    expect(ci).toMatch(/^permissions: \{\}$/m);
    expect(jobBlock('verify')).toMatch(/permissions:\n\s+contents: read\n/);
    expect(jobBlock('verify')).toContain("inputs.mode != 'visual-update'");
  });

  it('refuses main, release-please branches and non-branch refs before checking anything out', () => {
    expect(job).toContain('refs/heads/main | refs/heads/release-please--* | refs/heads/dependabot/*)');
    expect(job).toMatch(/refs\/heads\/\*\) ;;\n\s+\*\)[\s\S]*?exit 1/);
    expect(job.indexOf('refuse main and release branches')).toBeLessThan(job.indexOf('actions/checkout'));
  });

  it('pushes only e2e/__screenshots__ to a new ci/visual-baselines-<run id> branch as the actions bot', () => {
    expect(job).toContain('branch="ci/visual-baselines-${RUN_ID}"');
    expect(job).toContain('RUN_ID: ${{ github.run_id }}');
    expect(job).toContain('git switch -c "$branch"');
    expect(job).toContain('git add -A -- e2e/__screenshots__');
    expect(job).toContain('push origin "HEAD:refs/heads/${branch}"');
    expect(job).toContain('git -c core.hooksPath=/dev/null commit');
    expect(job).not.toMatch(/--force|push -f|--delete/);
    expect(job).toContain('git config user.name "github-actions[bot]"');
    expect(job).toContain('GITHUB_STEP_SUMMARY');
    expect(job).not.toContain('upload-artifact');
  });

  it('persists no credentials anywhere and runs npm ci without scripts there', () => {
    expect(ci).not.toContain('persist-credentials: true');
    expect(job).toContain('persist-credentials: false');
    expect(ci.match(/persist-credentials: false/g)).toHaveLength(4);
    expect(job).toContain('npm ci --ignore-scripts');
  });

  it('hands the token to the final push step only, as a one-off extraheader', () => {
    const code = noComments(job);
    expect(code.match(/TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1);
    const steps = code.split(/\n {6}- /);
    const withToken = steps.filter((s) => s.includes('github.token') || s.includes('GITHUB_TOKEN') || s.includes('$TOKEN'));
    expect(withToken).toHaveLength(1);
    const push = withToken[0];
    expect(push).toContain('name: push visual baselines to a side branch');
    expect(push).toContain(
      `git -c core.hooksPath=/dev/null -c http.https://github.com/.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)" push origin "HEAD:refs/heads/\${branch}"`,
    );
    // the token is never written to git config or echoed
    expect(code).not.toMatch(/git config[^\n]*(TOKEN|extraheader)/);
    expect(code).not.toMatch(/echo[^\n]*\$TOKEN/);
  });

  it('fails unless every staged path is a PNG under e2e/__screenshots__, before the commit and push', () => {
    expect(job).toContain("grep -Ev '^e2e/__screenshots__/.+\\.png$'");
    const check = job.indexOf("grep -Ev '^e2e/__screenshots__/.+\\.png$'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(job.indexOf('commit -m'));
    expect(check).toBeLessThan(job.indexOf('push origin'));
    expect(job).toMatch(/Unexpected files staged[\s\S]*?exit 1/);
  });

  it('uses the same pinned image and no ${{ }} in run lines', () => {
    expect(job).toContain(PLAYWRIGHT_IMAGE);
    for (const block of runBlocks(job)) expect(block).not.toContain('${{');
  });
});

describe('container jobs', () => {
  it.each(['ci.yml', 'flaky.yml'])('%s: a job in the Playwright container runs its scripts with bash (the default sh has no pipefail)', (name) => {
    const text = read(`.github/workflows/${name}`);
    const at = text.indexOf('    container:');
    expect(at).toBeGreaterThan(-1);
    const jobHead = text.slice(at, text.indexOf('    steps:', at));
    expect(jobHead).toMatch(/defaults:\s+run:\s+shell: bash/);
  });
});

describe('container checkouts', () => {
  it.each(['ci.yml', 'flaky.yml'])('%s marks the workspace as a safe git directory before git-based checks', (name) => {
    const text = read(`.github/workflows/${name}`);
    expect(text).toContain('git config --global --add safe.directory "$GITHUB_WORKSPACE"');
  });
});

describe('flaky.yml schedule', () => {
  it('runs weekly, not nightly', () => {
    const flaky = read('.github/workflows/flaky.yml');
    expect(flaky).toContain("cron: '17 6 * * 0'");
    expect(flaky).not.toMatch(/cron: '\d+ \d+ \* \* \*'/);
    expect(LABELS.find((l) => l.name === 'flaky').description).toMatch(/weekly/i);
    expect(LABELS.find((l) => l.name === 'flaky').description).not.toMatch(/nightly/i);
  });

  it('a failed e2e-weekly run opens or updates a flaky issue from a separate job with issues: write', () => {
    const flaky = read('.github/workflows/flaky.yml');
    const noComments = flaky.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const block = (name, next) => noComments.slice(noComments.indexOf(`\n  ${name}:`), next ? noComments.indexOf(`\n  ${next}:`) : undefined);
    const e2e = block('e2e-weekly', 'e2e-report');
    expect(e2e).not.toMatch(/issues:\s*write/);
    const reportJob = block('e2e-report');
    expect(reportJob).toContain('needs: e2e-weekly');
    expect(reportJob).toContain("needs.e2e-weekly.result == 'failure'");
    expect(reportJob).toMatch(/permissions:\n\s+issues: write\n/);
    expect(reportJob).toContain('gh issue create --title "$title" --label flaky');
    expect(reportJob).toContain('gh issue edit "$number"');
    expect(reportJob).not.toContain('actions/checkout');
    expect(noComments.match(/issues:\s*write/g)).toHaveLength(2);
    for (const run of runBlocks(reportJob)) expect(run).not.toContain('${{');
  });
});

describe('release tags', () => {
  it('release-please emits vX.Y.Z tags without a component prefix', () => {
    const cfg = JSON.parse(read('release-please-config.json'));
    expect(cfg.packages['.']['include-v-in-tag']).toBe(true);
    expect(cfg.packages['.']['include-component-in-tag']).toBe(false);
  });

  it('no workflow or release script assumes a component-prefixed tag', () => {
    const list = (dir, ext) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => `${dir}/${n}`);
    const files = [...list('.github/workflows', '.yml'), ...list('scripts/release', '.js'), ...list('scripts/desktop', '.js')];
    for (const rel of files) expect(read(rel), rel).not.toMatch(/burrow-v/);
    for (const name of presentWorkflows(['release.yml', 'desktop-windows.yml'])) expect(read(`.github/workflows/${name}`)).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+');
  });

  it('every tag check uses the strict vX.Y.Z[-prerelease] pattern', () => {
    const strict = '^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$';
    const counts = { 'release.yml': 3, 'desktop-windows.yml': 1 };
    for (const [name, count] of Object.entries(counts).filter(([n]) => hasPrivateFile(WF(n)))) {
      const text = read(`.github/workflows/${name}`);
      expect(text.split(`"$TAG" =~ ${strict}`).length - 1, name).toBe(count);
      expect(text).not.toContain('([-.][0-9A-Za-z.]+)?');
    }
    const re = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
    for (const ok of ['v1.2.3', 'v10.20.30', 'v1.2.3-rc.1', 'v1.2.3-beta']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v1.2.3.rc1', 'v1.2.3-', 'v1.2.3-rc 1', 'v1.2.3-rc;rm', 'v1.2.3\n', 'burrow-v1.2.3']) expect(re.test(bad), bad).toBe(false);
  });
});

/** Top-level trigger names of a workflow file (the keys under `on:`), comments ignored. */
function triggersOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  expect(start, 'on: block').toBeGreaterThan(-1);
  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^ {2}([a-z_]+):/.exec(l);
    if (m) keys.push(m[1]);
  }
  return keys;
}

const withoutComments = (text) => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('self-hosted runner safety', () => {
  const PR_TRIGGERS = ['pull_request', 'pull_request_target'];
  const files = WORKFLOWS.map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

  it('no workflow triggered by pull_request or pull_request_target can select a self-hosted label or call a release workflow', () => {
    const prFiles = files.filter(({ text }) => triggersOf(text).some((t) => PR_TRIGGERS.includes(t)));
    expect(prFiles.map((x) => x.name)).toContain('ci.yml');
    for (const { name, text } of prFiles) {
      const code = withoutComments(text);
      expect(code, name).not.toMatch(/self-hosted/i);
      expect(code, name).not.toMatch(/runs-on:[^\n]*(burrow|ARM64|fromJSON)/);
      expect(code, name).not.toMatch(/uses:\s*\.\/\.github\/workflows\/(desktop-windows|release|release-please)\.yml/);
    }
  });

  it('only the release path (release-please.yml, release.yml, desktop-windows.yml) names the self-hosted labels', () => {
    const named = files.filter(({ text }) => /self-hosted/i.test(withoutComments(text))).map((x) => x.name);
    expect(named.sort()).toEqual(presentWorkflows(['desktop-windows.yml', 'release-please.yml', 'release.yml']));
  });

  it.skipIf(!hasReleaseWorkflows)('the release workflows are only workflow_call, dispatch or tag runs: never pull_request, never a branch push', () => {
    expect(triggersOf(read('.github/workflows/desktop-windows.yml'))).toEqual(['workflow_call']);
    const release = read('.github/workflows/release.yml');
    expect(triggersOf(release).sort()).toEqual(['push', 'workflow_call', 'workflow_dispatch']);
    expect(release).toMatch(/\n {2}push:\n {4}tags: \['v\*'\]\n/);
    expect(release).not.toMatch(/\n {2}push:\n {4}branches/);
    for (const name of ['release.yml', 'release-please.yml', 'desktop-windows.yml']) {
      expect(triggersOf(read(`.github/workflows/${name}`)).filter((t) => PR_TRIGGERS.includes(t)), name).toEqual([]);
    }
  });

  it.skipIf(!hasPrivateFile(WF('desktop-windows.yml')))('pick-runner: ubuntu (or the PC in whole-release mode), contents read, no checkout, the only job that reads the admin token, hosted by default', () => {
    const win = withoutComments(read('.github/workflows/desktop-windows.yml'));
    const pickAt = win.indexOf('\n  pick-runner:');
    const winAt = win.indexOf('\n  windows:');
    expect(pickAt).toBeGreaterThan(-1);
    expect(winAt).toBeGreaterThan(pickAt);
    const pick = win.slice(pickAt, winAt);
    const rest = win.slice(winAt);
    expect(pick).toContain(`runs-on: \${{ vars.RELEASE_RUNNER == 'self-hosted' && fromJSON('["self-hosted","Windows","ARM64","burrow"]') || 'ubuntu-latest' }}`);
    expect(pick).toMatch(/permissions:\n\s+contents: read/);
    // In whole-release mode the admin token is never handed to the job on the PC.
    expect(pick).toContain("ADMIN_TOKEN: ${{ vars.RELEASE_RUNNER != 'self-hosted' && secrets.RUNNER_ADMIN_READ_TOKEN || '' }}");
    expect(pick).not.toContain('actions/checkout');
    expect(pick).toContain('RUNNER_ADMIN_READ_TOKEN');
    expect(rest).not.toContain('RUNNER_ADMIN_READ_TOKEN');
    expect(win.match(/secrets\.RUNNER_ADMIN_READ_TOKEN/g)).toHaveLength(1);
    expect(pick).toContain(`hosted='"windows-11-arm"'`);
    for (const guard of ['push|workflow_dispatch|schedule', '"$STRICT_VERSION" != "true"', '"$private" != "true"']) expect(pick, guard).toContain(guard);
    expect(rest).toContain('needs: pick-runner');
    expect(rest).toContain('runs-on: ${{ fromJSON(matrix.runs_on) }}');
    expect(pick).toContain(`x64_choice='"windows-latest"'`);
    expect(rest).toContain('runs_on: ${{ needs.pick-runner.outputs.x64_runs_on }}');
    expect(rest).toContain('runs_on: ${{ needs.pick-runner.outputs.arm64_runs_on }}');
    // The windows job never names the label list itself: only pick-runner chooses it.
    expect(rest).not.toContain('["self-hosted"');
  });

  it('the optional admin token is passed explicitly down the release chain, never inherited', () => {
    for (const name of presentWorkflows(['release.yml', 'release-please.yml'])) {
      const text = withoutComments(read(`.github/workflows/${name}`));
      expect(text, name).toContain('RUNNER_ADMIN_READ_TOKEN: ${{ secrets.RUNNER_ADMIN_READ_TOKEN }}');
      expect(text, name).not.toContain('secrets: inherit');
    }
  });
});

describe.skipIf(!hasReleaseWorkflows)('updater signing in the release pipeline', () => {
  const KEY = 'TAURI_SIGNING_PRIVATE_KEY';
  const PASSWORD = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';
  const win = withoutComments(readPrivateFile(WF('desktop-windows.yml')));
  const release = withoutComments(readPrivateFile(WF('release.yml')));
  /** The steps of a workflow file (a step starts with `- name:` or `- uses:` at the step indent). */
  const stepsOf = (text) => text.split(/\n(?= {6}- )/).slice(1);
  const stepNamed = (text, name) => {
    const step = stepsOf(text).find((s) => s.startsWith(`      - name: ${name}`));
    expect(step, name).toBeTruthy();
    return step;
  };

  const BUNDLE = 'Bundle and sign installer';
  const COMPILE = 'Compile installer';
  const releasePlease = withoutComments(readPrivateFile(WF('release-please.yml')));

  it('the signing secrets are read in exactly one place: the env of the bundle step, never the compile step', () => {
    const readers = (text) => text.match(/\$\{\{\s*secrets\.TAURI_SIGNING_[A-Z_]+\s*\}\}/g) ?? [];
    expect(readers(win).sort()).toEqual([`\${{ secrets.${KEY} }}`, `\${{ secrets.${PASSWORD} }}`].sort());
    const bundle = stepNamed(win, BUNDLE);
    expect(readers(bundle)).toHaveLength(2);
    expect(bundle).toMatch(/\n {8}env:\n(?: {10}[A-Z_]+: .*\n)*? {10}TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}\n/);
    for (const step of stepsOf(win).filter((s) => !s.startsWith(`      - name: ${BUNDLE}`))) expect(step).not.toContain('TAURI_SIGNING');
    // The job-level and workflow-level env never carry them.
    expect(win.slice(0, win.indexOf('\n    steps:'))).not.toMatch(/env:[\s\S]*TAURI_SIGNING_PRIVATE_KEY: \$\{\{/);
  });

  it('the build is split: compile without the key, then bundle with it, both through buildInstaller.js', () => {
    const compile = stepNamed(win, COMPILE);
    expect(compile).toContain('run: node scripts/release/buildInstaller.js --phase build');
    expect(compile).not.toMatch(/\n {8}env:/);
    expect(stepNamed(win, BUNDLE)).toContain('run: node scripts/release/buildInstaller.js --phase bundle');
    const names = stepsOf(win).map((s) => /^ {6}- name: (.*)/.exec(s)?.[1]);
    expect(names.indexOf(COMPILE)).toBeGreaterThan(-1);
    expect(names.indexOf(BUNDLE)).toBe(names.indexOf(COMPILE) + 1);
    expect(win).not.toMatch(/npx tauri (build|bundle)/);
  });

  it('only a real tag build can read the secrets: the windows job selects the "release" environment on strict_version only', () => {
    const fromWindows = win.slice(win.indexOf('\n  windows:'));
    expect(fromWindows.slice(0, fromWindows.indexOf('\n    steps:'))).toContain("environment: ${{ inputs.strict_version && 'release' || '' }}");
    expect(win.slice(0, win.indexOf('\n  windows:'))).not.toContain('environment:');
    // release.yml turns strict_version on exactly when the plan says private=true, which a source_ref dry run never gets.
    const job = release.slice(release.indexOf('\n  desktop-windows:'), release.indexOf('\n  publish-public:'));
    expect(job).toContain("strict_version: ${{ needs.plan.outputs.private == 'true' }}");
    expect(release).toMatch(/if \[ -n "\$SOURCE_REF" \]; then[\s\S]*?private=false/);
  });

  it('the signing secrets are environment secrets: not declared as workflow_call secrets, not passed down the chain, never inherited', () => {
    for (const [name, text] of [['desktop-windows.yml', win], ['release.yml', release], ['release-please.yml', releasePlease]]) {
      expect(text, name).not.toMatch(/\n {6}TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?:\n/);
      expect(text, name).not.toContain('secrets: inherit');
      if (name !== 'desktop-windows.yml') expect(text, name).not.toContain('TAURI_SIGNING');
    }
  });

  it('no other workflow, Dev script or Dev workflow references the signing variables or the release overlay', () => {
    const allowed = new Set(['desktop-windows.yml', 'release.yml', 'release-please.yml']);
    for (const name of WORKFLOWS.filter((n) => !allowed.has(n))) {
      expect(read(`.github/workflows/${name}`), name).not.toMatch(/TAURI_SIGNING|tauri\.release\.conf/);
    }
    for (const rel of ['.github/workflows/dev-build.yml', 'scripts/desktop/buildDev.js', 'scripts/desktop/dev.js', 'scripts/desktop/buildSidecar.js'].filter(hasPrivateFile)) {
      expect(read(rel), rel).not.toMatch(/TAURI_SIGNING|tauri\.release\.conf/);
    }
    expect(read('scripts/desktop/build.js')).not.toContain('tauri.release.conf');
  });

  it('publish-public writes latest.json before it hashes the public files, and widens the checks to the six names', () => {
    const publish = release.slice(release.indexOf('\n  publish-public:'), release.indexOf('\n  cleanup-staging:'));
    const manifestAt = publish.indexOf('node scripts/release/updaterManifest.js');
    const sumsAt = publish.indexOf('> SHA256SUMS.txt');
    expect(manifestAt).toBeGreaterThan(-1);
    expect(sumsAt).toBeGreaterThan(manifestAt);
    expect(publish).toContain("--pattern 'Burrow-Setup-*.exe.sig'");
    expect(publish).toContain('for extra in Burrow-Setup-x64.exe.sig Burrow-Setup-arm64.exe.sig latest.json');
    expect(publish).toContain('\\(Burrow-Setup-\\(x64\\|arm64\\)\\.exe\\(\\.sig\\)\\?\\|latest\\.json\\)');
    expect(publish).not.toMatch(/TAURI_SIGNING/);
    expect(publish).toContain('node scripts/release/publishPublic.js');
  });

  it('desktop-windows collects and uploads the .sig and lists it in the per-arch sums', () => {
    const collect = stepNamed(win, 'Collect and rename the installer');
    expect(collect).toContain('Burrow-Setup-${ARCH}.exe.sig');
    expect(collect).toMatch(/sha256sum --text "\$\{files\[@\]\}"/);
    expect(stepNamed(win, 'Attach to the private release')).toContain('Burrow-Setup-${ARCH}.exe.sig');
  });

  it('package.json has release:installer and desktop:build strips the signing variables', async () => {
    expect(JSON.parse(read('package.json')).scripts['release:installer']).toBe('node scripts/release/buildInstaller.js');
    const { stableChildEnv } = await import('../../scripts/desktop/build.js');
    const env = stableChildEnv({ PATH: 'p', [KEY]: 'k', [PASSWORD]: 'p', TAURI_SIGNING_PRIVATE_KEY_PATH: 'x', TAURI_CONFIG: '{}' });
    expect(env).toEqual({ PATH: 'p', BURROW_CHANNEL: 'stable' });
  });
});
