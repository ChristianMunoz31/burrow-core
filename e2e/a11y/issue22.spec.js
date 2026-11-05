// Issue #22 (fixed): in the light theme, Settings > AI showed "Ollama is running" in a chip at about
// 4.3:1 (WCAG AA needs 4.5:1 for this small text).
//
// axe-core cannot catch it: the chip sits on the mesh-gradient page background, so axe reports
// color-contrast as "incomplete" (background could not be determined), never as a violation. The
// check here therefore measures the ratio itself (e2e/support/contrast.js) and now guards the fix.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { ISSUE_22_SELECTOR } from '../support/axe.js';
import { measureContrast } from '../support/contrast.js';
import { settingsAi } from '../pages/settingsAi.js';

useBurrow({ seed: true, ollama: 'fake' });

const AA_NORMAL_TEXT = 4.5;

async function openLight(page) {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const ai = settingsAi(page);
  await ai.open();
  await expect(ai.runningChip()).toBeVisible();
  await page.waitForLoadState('networkidle');
  return page.locator(ISSUE_22_SELECTOR).filter({ hasText: 'Ollama is running' });
}

test('issue #22: the "Ollama is running" chip meets AA colour contrast in the light theme', async ({ page }) => {
  const chip = await openLight(page);
  const { ratio, fg, bg } = await measureContrast(chip);
  expect(ratio, `contrast of ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
});

// Guard so the check above cannot pass for the wrong reason: the chip exists, the selector matches
// exactly it, and the measurement is a plausible ratio (not NaN or a parse miss).
test('issue #22 guard: the chip exists and its contrast is measurable', async ({ page }) => {
  const chip = await openLight(page);
  await expect(chip).toHaveCount(1);
  const { ratio } = await measureContrast(chip);
  expect(ratio).toBeGreaterThan(3);
  expect(ratio).toBeLessThan(21);
});
