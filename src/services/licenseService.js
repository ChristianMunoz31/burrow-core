import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

async function req(path, options = {}) {
  const response = await fetch(`${PROXY_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, body);
    // { error: <code>, message, detail? } (docs/LICENSING.md 10.7). Store text is never echoed by the server.
    if (typeof body?.error === 'string') err.code = body.error;
    if (body?.detail && typeof body.detail === 'object') err.detail = body.detail;
    // Without a server message the UI shows its own copy for the code, never the HTTP status text.
    if (!body?.message || typeof body.message !== 'string') err.message = '';
    throw err;
  }
  return body;
}

/**
 * @typedef {{
 *   state: 'free'|'pro'|'trial'|'update_window_passed'|'expired'|'clock_issue'|'invalid',
 *   pro: boolean,
 *   edition: string|null,
 *   reasons: string[],
 *   message: string,
 *   invalidReason: 'tampered'|'no_key'|null,
 *   license: null | { store: 'gumroad'|'lemonsqueezy', storeLabel: string, edition: string,
 *     purchaseDate: string, updatesUntil: string, expiresAt: string|null, activatedAt: string,
 *     email: string|null, keyLast4: string, test: boolean, canDeactivate: boolean },
 *   trialDaysLeft: number|null,
 *   build: { date: string|null, source: string, version: string },
 *   clock: { rollbackDetected: boolean },
 *   licenseState: 'free'|'pro'|'update_window_passed'|'expired'|'clock_issue'|'invalid',
 *   proSource: 'license'|'local_trial'|null,
 *   trial: { state: 'available'|'active'|'ended' (available: no trial record yet), startedAt: string|null, endsAt: string|null,
 *     daysLeft: number|null, remindToday: boolean,
 *     notice: 'welcome'|'ending_soon'|'ended'|null },
 *   perks: { founderBackground: boolean },
 *   stores: Array<{ id: 'gumroad'|'lemonsqueezy', label: string, configured: boolean }>,
 *   purchaseUrl: string|null,
 *   supportContact: string|null
 * }} LicenseStatus
 */

export const licenseService = {
  /** @returns {Promise<LicenseStatus>} */
  get: () => req('/license'),
  /**
   * Contacts the store once (the only call that does, with deactivate). Errors carry `code` and the server `message`.
   * @param {{ licenseKey: string, store?: 'gumroad'|'lemonsqueezy' }} input
   * @returns {Promise<LicenseStatus>}
   */
  activate: ({ licenseKey, store }) =>
    req('/license/activate', {
      method: 'POST',
      body: JSON.stringify(store ? { licenseKey, store } : { licenseKey }),
    }),
  /**
   * Lemon Squeezy only: releases this computer's activation. 409 license_key_needed asks for the key.
   * @param {{ licenseKey?: string }} [input]
   * @returns {Promise<LicenseStatus>}
   */
  deactivate: ({ licenseKey } = {}) =>
    req('/license/deactivate', {
      method: 'POST',
      body: JSON.stringify(licenseKey ? { licenseKey } : {}),
    }),
  /** Forgets the license on this computer. No network, idempotent. @returns {Promise<LicenseStatus>} */
  remove: () => req('/license', { method: 'DELETE' }),
  /**
   * Marks a trial notice as shown so it never comes back (kept on the server, no network). 400 invalid_request.
   * @param {'welcome'|'ending_soon'|'ended'} notice
   * @returns {Promise<LicenseStatus>}
   */
  dismissTrialNotice: (notice) =>
    req('/license/trial/notice', { method: 'POST', body: JSON.stringify({ notice }) }),
};
