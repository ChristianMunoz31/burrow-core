// Shared Pro switch for server tests. A test file that exercises a Pro route (Javi tools,
// briefings, Explain, the scheduled briefing) adds, at the top level:
//
//   vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
//
// Everything in the license module stays real except getEntitlements(), which reads the state
// below (Pro by default). Use setEntitlements(FREE) to prove the gate itself.
export const PRO = Object.freeze({ pro: true, edition: 'standard', reasons: ['license'] });
export const TRIAL = Object.freeze({ pro: true, edition: null, reasons: ['local_trial'] });
export const FREE = Object.freeze({ pro: false, edition: null, reasons: [] });
// An expired update window or license reads as free: never Pro.
export const UPDATE_WINDOW_PASSED = Object.freeze({ pro: false, edition: 'standard', reasons: ['update_window_passed'] });

let current = PRO;

/** @param {{ pro: boolean, edition: string|null, reasons: string[] }} next */
export function setEntitlements(next) {
  current = next;
}

export function resetPro() {
  current = PRO;
}

/** Factory for vi.mock('../license/index.js'): the real module with getEntitlements replaced. */
export async function mockLicenseModule(importOriginal) {
  const actual = await importOriginal();
  return { ...actual, getEntitlements: () => current };
}
