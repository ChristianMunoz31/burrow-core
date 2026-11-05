// The AI eval runs Javi tools, which are a Pro capability. In its own throwaway data directory it
// gets the one local 14-day trial that starts on its own at first launch, so no real license, store or
// network is involved and no other data folder is touched.
import { getEntitlements, getLicenseStatus, initLicense, resetLicenseForTests } from '../../server/license/index.js';

/**
 * Starts the licensing module in `dataDir` (the eval's temp directory), which auto-starts the local trial, and confirms Pro is on.
 * @param {string} dataDir The throwaway data directory (BURROW_DATA_DIR).
 * @param {object} [initOpts] Extra initLicense options (tests inject providers).
 * @returns {{ pro: boolean, status: object }}
 * @throws {Error} When Pro is still off after the trial start.
 */
export function startEvalTrial(dataDir, initOpts = {}) {
  resetLicenseForTests();
  initLicense({ dataDir, log: () => {}, ...initOpts });
  const status = getLicenseStatus();
  if (getEntitlements().pro !== true) throw new Error('eval_trial_not_pro');
  return { pro: true, status };
}

/**
 * Whether any result row failed because Pro was off (the eval cannot measure Javi then).
 * @param {Record<string, { rows: Array<{ error?: string | null, why?: string }> }>} results
 * @returns {boolean}
 */
export function hasProRequiredRow(results) {
  return Object.values(results).some((m) => m.rows.some((r) => r.error === 'pro_required'));
}
