## What and why

<!-- One or two sentences. Link the issue if there is one. -->

<!--
Tests: CI fails a PR that changes source in src/ or server/ without touching a test.
If a test really is not needed, add the `no-tests-needed` label AND put this line (with a real
reason of at least 10 characters) in this description, outside any HTML comment:
No tests needed because: <your reason>
The same waiver relaxes the 60% coverage floor for the changed files.
-->

## Screenshots or preview

<!-- UI change: add before/after screenshots (light and dark). The CI comment on this PR links the web build (artifact `web-dist`, 3 days); locally: npm run preview:branch -- "#<PR number>". Write "no UI change" otherwise. -->

## Checklist

- [ ] PR title is a conventional commit, for example `feat(budget): add category rollover`
- [ ] Tests added or updated, and `npm test` passes (or the waiver above applies)
- [ ] Any number sent to a model is computed in code first, with a test proving the model is not asked to calculate
- [ ] A new outbound network call has a `server/netPolicy.js` feature, off by default
- [ ] No personal data in code, fixtures, prompts or tests
- [ ] A schema change is a new migration (never an edit to a shipped one) and `migrationSafety` passes
- [ ] Export, import and backups are not paywalled or weakened
- [ ] No em dashes in user-facing copy
- [ ] No Pro code in core: Pro-only code lives in `pro/` (docs/OPEN_CORE.md); core never imports `pro/`
- [ ] Tests pass in both modes (`pro/` present and moved outside the repo)
- [ ] No public copy calls Burrow open source until the core is published (docs/PUBLISHING_CORE.md)
- [ ] First run just works: a new user can download, open and use it with no setup, no config, no network and no AI required (the first-run e2e passes)
- [ ] UI change: screenshots or the preview link are attached, and the Playwright visual baselines are updated when the look changed on purpose (`npm run test:visual:update`)
