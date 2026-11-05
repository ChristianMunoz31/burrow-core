// The one place that names the Playwright container image. CI (`ci.yml` verify job) and
// `scripts/visualUpdate.js` both use it, so Linux visual baselines come out identical.
// The tag must equal the exact `@playwright/test` version in package-lock.json (a unit test checks
// this and that ci.yml contains the same string). Bump version, image and baselines together.
export const PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
