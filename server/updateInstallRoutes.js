// POST /api/settings/updates/install: the click-to-install handoff. This route never downloads or installs
// anything. It re-checks that the clicked version is still the newest, saves a backup first, then asks the
// desktop shell (through one authenticated stdout line, server/desktop/shellChannel.js) to download, verify and
// install it. The shell re-derives the endpoint, signing key, URL and signature check from its own baked config.
// Success: 202 { data: { status: 'handed_off', version, backupId } }. Errors: { error: <code>, code: <code>, message }.
// POST /api/settings/updates/manual serves a copy without a working shell updater (the placeholder key): it
// re-checks, reads the pinned SHA256SUMS.txt, saves a backup and returns the pinned installer URL plus the expected
// SHA-256 for the user's browser to download; it downloads no installer itself.
// Every step is injectable for tests.
import { STABLE_VERSION_RE } from './channel.js';
import { isBackupError } from './backup/errors.js';
import { limiter as makeLimiter, requireJson } from './backup/routes.js';
import { currentOp, isGateClosed } from './backup/lock.js';
import { createBackup } from './backup/service.js';
import {
  installerArch,
  isManualDownloadAvailable,
  isShellUpdaterAvailable,
  requestShellUpdate,
} from './desktop/shellChannel.js';
import { networkRequiredBody, requireNetwork } from './netPolicy.js';
import { recordNetworkCall } from './networkCall.js';
import { checkForUpdate, fetchInstallerChecksum, installerUrl, sumsUrl } from './updateCheck.js';

export const INSTALL_PATH = '/api/settings/updates/install';
export const MANUAL_PATH = '/api/settings/updates/manual';
/**
 * After a handoff the shell owns the update. A second request inside this window is refused. It covers the shell's
 * whole flow: the check (30 s), the download timeout (15 min) and the sidecar stop, so a second click cannot start a
 * second update while the first one is still downloading.
 */
export const HANDOFF_LEASE_MS = 16 * 60 * 1000;
/** A repeat "Get the installer" click for the same version reuses the backup it just saved for this long. */
export const MANUAL_BACKUP_REUSE_MS = 10 * 60 * 1000;

/** Lease resets of every registered route, so a server shutdown (or a test) can free a held lease. */
const leaseResets = new Set();

/** Frees every held install lease. Called when the server stops. */
export function releaseUpdateInstallLease() {
  for (const reset of leaseResets) reset();
}

/** A backup, restore or erase holds the data lock, or a restore or erase is closing the request gate. */
const dataBusyCode = () => {
  const op = currentOp();
  if (op === 'restore') return 'db_restoring';
  return op !== null || isGateClosed() ? 'backup_busy' : null;
};

const ERRORS = Object.freeze({
  invalid_request: { status: 400, message: 'That request was not valid. Close and reopen Settings, then try again.' },
  update_install_unsupported: {
    status: 409,
    message: "This copy of Burrow can't install updates by itself. Download the new version from the releases page.",
  },
  update_not_available: {
    status: 409,
    message: 'That update is no longer the newest one. Check again to see the current update.',
  },
  update_in_progress: { status: 409, message: 'An update is already starting. Wait a moment.' },
  backup_busy: { status: 409, message: 'Burrow is busy with a backup. Try again in a minute.' },
  db_restoring: { status: 503, message: 'Burrow is restoring a backup. This takes a few seconds.' },
  update_check_unavailable: {
    status: 503,
    message: "Burrow couldn't reach GitHub to confirm the update. Check your connection and try again.",
  },
  disk_low: {
    status: 507,
    message:
      "There isn't enough free disk space to save a backup first, so the update was not started. Free some space and try again.",
  },
  disk_full: {
    status: 507,
    message:
      "There isn't enough free disk space to save a backup first, so the update was not started. Free some space and try again.",
  },
  update_backup_failed: {
    status: 500,
    message: "Burrow couldn't save a backup first, so the update was not started. Your data is unchanged.",
  },
  update_handoff_failed: {
    status: 500,
    message: "Burrow couldn't start the update. Close and reopen Burrow, then try again.",
  },
  update_manual_unsupported: {
    status: 409,
    message: "This copy of Burrow can't get the installer for you. Download the new version from the releases page.",
  },
  update_checksum_unavailable: {
    status: 503,
    message:
      "Burrow couldn't get the checksum for this update from GitHub, so it did not show the download. Check your connection and try again.",
  },
});

const send = (res, code) => {
  const { status, message } = ERRORS[code];
  res.set('Cache-Control', 'no-store');
  if (code === 'db_restoring') res.set('Retry-After', '5');
  return res.status(status).json({ error: code, code, message });
};

/** Maps a failed createBackup to the install error table (anything unknown is `update_backup_failed`). */
const backupErrorCode = (err) => {
  const code = isBackupError(err) || err?.name === 'DbError' ? err.code : null;
  return code === 'backup_busy' || code === 'db_restoring' || code === 'disk_low' || code === 'disk_full'
    ? code
    : 'update_backup_failed';
};

const isValidBody = (body) =>
  body !== null &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  Object.keys(body).length === 1 &&
  typeof body.version === 'string' &&
  STABLE_VERSION_RE.test(body.version);

/**
 * @param {import('express').Express} app
 * @param {{
 *   isInstallSupported?: () => boolean,
 *   dataBusyCode?: () => 'backup_busy' | 'db_restoring' | null,
 *   checkForUpdate?: typeof checkForUpdate,
 *   createBackup?: typeof createBackup,
 *   requestShellUpdate?: typeof requestShellUpdate,
 *   recordNetworkCall?: typeof recordNetworkCall,
 *   now?: () => number,
 *   gate?: import('express').RequestHandler,
 *   limiter?: import('express').RequestHandler,
 * }} [deps] every step is a test seam
 */
export function registerUpdateInstallRoute(app, deps = {}) {
  const {
    isInstallSupported = () => isShellUpdaterAvailable(),
    dataBusyCode: busyCode = dataBusyCode,
    checkForUpdate: check = checkForUpdate,
    createBackup: backup = createBackup,
    requestShellUpdate: handoff = requestShellUpdate,
    recordNetworkCall: audit = recordNetworkCall,
    now = Date.now,
    gate = requireNetwork('updates'),
    limiter = makeLimiter(5),
  } = deps;

  // Single flight: one install request at a time, and none for HANDOFF_LEASE_MS after a handoff (released at once on
  // failure and when the server stops).
  let inFlight = false;
  let heldUntil = 0;
  leaseResets.add(() => {
    inFlight = false;
    heldUntil = 0;
  });

  app.post(INSTALL_PATH, gate, requireJson, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isValidBody(req.body)) return send(res, 'invalid_request');
    const { version } = req.body;
    if (!isInstallSupported()) return send(res, 'update_install_unsupported');
    if (inFlight || now() < heldUntil) return send(res, 'update_in_progress');
    // Never start while a backup, restore or erase holds the data (an erase must not be followed by an update, and a
    // restore swaps the database file). The backup step below would refuse too, but only after a network check.
    const busy = busyCode();
    if (busy !== null) return send(res, busy);

    inFlight = true;
    let handedOff = false;
    try {
      let status;
      try {
        status = await check({ refresh: true });
      } catch (err) {
        if (err?.status === 403) return res.status(403).json(networkRequiredBody('updates'));
        return send(res, 'update_check_unavailable');
      }
      if (status?.status === 'unavailable') return send(res, 'update_check_unavailable');
      if (status?.status !== 'available' || status.latest !== version) return send(res, 'update_not_available');

      let backupId = null;
      try {
        const result = await backup({ kind: 'manual', skipIfUnchanged: false });
        backupId = typeof result?.meta?.id === 'string' ? result.meta.id : null;
      } catch (err) {
        return send(res, backupErrorCode(err));
      }

      try {
        handoff(version);
      } catch {
        return send(res, 'update_handoff_failed');
      }
      handedOff = true;
      try {
        await audit('updates', 'https://github.com', 'ok', { result: 'started', by: 'app' });
      } catch (err) {
        // The update is already under way: a failed audit row must not turn this into an error answer.
        console.error('Update install audit failed:', err?.code ?? err?.name ?? 'unknown');
      }
      return res.status(202).json({ data: { status: 'handed_off', version, backupId } });
    } catch (err) {
      console.error('Update install failed:', err?.code ?? err?.name ?? 'unknown');
      return res.headersSent ? undefined : send(res, 'update_handoff_failed');
    } finally {
      inFlight = false;
      heldUntil = handedOff ? now() + HANDOFF_LEASE_MS : 0;
    }
  });
}

/**
 * POST /api/settings/updates/manual: for a copy that cannot install by itself. Returns the pinned installer URL and
 * the expected SHA-256 after a fresh check, and a backup. Downloads no installer.
 * @param {import('express').Express} app
 * @param {{
 *   isManualSupported?: () => boolean,
 *   installerArch?: () => 'x64' | 'arm64' | null,
 *   dataBusyCode?: () => 'backup_busy' | 'db_restoring' | null,
 *   checkForUpdate?: typeof checkForUpdate,
 *   fetchInstallerChecksum?: typeof fetchInstallerChecksum,
 *   createBackup?: typeof createBackup,
 *   now?: () => number,
 *   gate?: import('express').RequestHandler,
 *   limiter?: import('express').RequestHandler,
 * }} [deps] every step is a test seam
 */
export function registerManualDownloadRoute(app, deps = {}) {
  const {
    isManualSupported = () => isManualDownloadAvailable(),
    installerArch: archOf = () => installerArch(),
    dataBusyCode: busyCode = dataBusyCode,
    checkForUpdate: check = checkForUpdate,
    fetchInstallerChecksum: fetchChecksum = fetchInstallerChecksum,
    createBackup: backup = createBackup,
    now = Date.now,
    gate = requireNetwork('updates'),
    limiter = makeLimiter(5),
  } = deps;

  let inFlight = false;
  // The backup of the last successful answer (per process). The checksum re-check still runs on
  // every click; only the full backup is not repeated for the same version inside MANUAL_BACKUP_REUSE_MS.
  let lastBackup = null;

  app.post(MANUAL_PATH, gate, requireJson, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isValidBody(req.body)) return send(res, 'invalid_request');
    const { version } = req.body;
    const arch = archOf();
    if (!isManualSupported() || arch === null) return send(res, 'update_manual_unsupported');
    if (inFlight) return send(res, 'update_in_progress');
    const busy = busyCode();
    if (busy !== null) return send(res, busy);

    inFlight = true;
    try {
      let status;
      try {
        status = await check({ refresh: true, source: 'release' });
      } catch (err) {
        if (err?.status === 403) return res.status(403).json(networkRequiredBody('updates'));
        return send(res, 'update_check_unavailable');
      }
      if (status?.status === 'unavailable') return send(res, 'update_check_unavailable');
      if (status?.status !== 'available' || status.latest !== version) return send(res, 'update_not_available');

      let checksum;
      try {
        checksum = await fetchChecksum({ version, arch });
      } catch (err) {
        if (err?.status === 403) return res.status(403).json(networkRequiredBody('updates'));
        return send(res, 'update_checksum_unavailable');
      }
      if (!checksum?.ok) return send(res, 'update_checksum_unavailable');

      let backupId = null;
      if (lastBackup && lastBackup.version === version && now() < lastBackup.until) {
        backupId = lastBackup.backupId;
      } else {
        try {
          const result = await backup({ kind: 'manual', skipIfUnchanged: false });
          backupId = typeof result?.meta?.id === 'string' ? result.meta.id : null;
        } catch (err) {
          return send(res, backupErrorCode(err));
        }
        lastBackup = { version, backupId, until: now() + MANUAL_BACKUP_REUSE_MS };
      }

      return res.status(200).json({
        data: {
          status: 'ready',
          version,
          arch,
          fileName: `Burrow-Setup-${arch}.exe`,
          installerUrl: installerUrl(version, arch),
          sha256: checksum.sha256,
          sumsUrl: sumsUrl(version),
          backupId,
        },
      });
    } catch (err) {
      console.error('Update download failed:', err?.code ?? err?.name ?? 'unknown');
      return res.headersSent ? undefined : send(res, 'update_checksum_unavailable');
    } finally {
      inFlight = false;
    }
  });
}
