# Visual baselines (Linux only)

The `visual` Playwright project compares screenshots against the images that belong here. They are
**not committed yet**: they must be rendered on Linux, with the exact Playwright container image CI
uses (`scripts/lib/playwrightImage.js`), or every pixel of text differs. Never commit images made on
Windows or macOS.

Until they exist the `visual` project fails in CI (Playwright writes the missing images and reports
the test as failed). That is intended: do not turn on `updateSnapshots: 'missing'`.

Generate them:

- With Docker running: `npm run test:visual:update` (renders in the pinned image, writes here).
- Without Docker: push the branch, then `npm run test:visual:update -- --ci`. It dispatches
  `ci.yml` with `mode=visual-update`, waits, fetches the side branch `ci/visual-baselines-<run id>` the
  run pushed and copies this folder from it. (Or run that workflow by hand from the Actions tab and
  fetch that branch yourself.) Delete the side branch afterwards. See docs/PIPELINE.md.

Then review every image and commit them. Layout: `<spec file name>/<screen>-<light|dark>.png`.
Upgrading `@playwright/test` is deliberate: bump the version, the image and these baselines together.
