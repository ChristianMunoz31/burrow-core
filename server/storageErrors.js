// Maps a data-layer failure to the HTTP response used across the data routes.
import { httpErrorFor, toDbError } from './db/index.js';

/**
 * Send the mapped storage failure (503 / 400 / 404) or a generic 500.
 * @param {import('express').Response} res
 * @param {unknown} error
 * @returns {import('express').Response}
 */
export function sendStorageError(res, error) {
  // A data-layer error carrying status 503 (unavailable database) keeps that status.
  if (error?.status === 503) return res.status(503).json({ error: 'Local database is unavailable.' });
  const d = toDbError(error);
  const { status, error: message } = httpErrorFor(d);
  if (status >= 500) console.error('Storage error:', d.code);
  return res.status(status).json({ error: message });
}
