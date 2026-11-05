import { AUTO_ADVICE_RATE_LIMIT_WAIT_MS, retryWaitMs } from '../../hooks/useJaviSession';

/**
 * Single source for "how long until this error may be retried": the server's retryAfterMs, or
 * the shared 30s default for rate-limit codes without one. Used by Retry and by the
 * auto-advice suppression so both agree.
 * @param {{ code?: string, retryAfterMs?: number | null, at?: number } | null | undefined} error
 * @param {number} now
 * @returns {number}
 */
export function errorWaitMs(error, now) {
  return retryWaitMs(error, now, AUTO_ADVICE_RATE_LIMIT_WAIT_MS);
}
