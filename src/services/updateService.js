import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

/**
 * @typedef {'free' | 'included' | 'blocked' | 'unknown'} LicenseImpact
 * @typedef {{ status: 'store_managed' } | { status: 'dev_managed' }
 *   | { status: 'current', current: string, latest: string, channel: 'stable', source: 'manifest' | 'release', checkedAt: string }
 *   | { status: 'available', current: string, latest: string, url: string, publishedAt: string | null, channel: 'stable',
 *       source: 'manifest' | 'release', checkedAt: string, notes: string | null, canInstall: boolean, canDownload: boolean,
 *       licenseImpact: LicenseImpact, updatesUntil: string | null }
 *   | { status: 'unavailable', current: string, reason: string, channel: string, checkedAt: string }} UpdateStatus
 * @typedef {{ status: 'ready', version: string, arch: 'x64' | 'arm64', fileName: string, installerUrl: string,
 *   sha256: string, sumsUrl: string, backupId: string | null }} ManualDownload
 */

/** POST { version } to an update route. The error carries `code` (for example update_not_available, backup_busy). */
async function postVersion(path, version) {
  const response = await fetch(`${PROXY_URL}/settings/updates/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ version }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = buildApiError(response, body);
    if (typeof body?.code === 'string') err.code = body.code;
    throw err;
  }
  return body.data;
}

export const updateService = {
  /** @returns {Promise<UpdateStatus>} */
  async check({ refresh = false } = {}) {
    const response = await fetch(`${PROXY_URL}/settings/updates/check${refresh ? '?refresh=1' : ''}`, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw buildApiError(response, body);
    return body.data;
  },

  /**
   * Start the click-to-install handoff: the server saves a backup, then asks the desktop app to download and
   * install this version.
   * @param {string} version
   * @returns {Promise<{ status: 'handed_off', version: string, backupId: string | null }>}
   */
  install: (version) => postVersion('install', version),

  /**
   * The manual download for a copy that cannot install by itself: the server saves a backup and returns the pinned
   * installer link with its expected SHA-256.
   * @param {string} version
   * @returns {Promise<ManualDownload>}
   */
  manual: (version) => postVersion('manual', version),
};
