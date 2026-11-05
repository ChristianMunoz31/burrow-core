const fallbackFilename = () => `burrow-export-${new Date().toISOString().slice(0, 10)}.zip`;
const REVOKE_DELAY_MS = 30_000;

const MESSAGES = {
  rate_limited: 'Too many exports. Try again in a few minutes.',
  session: 'Your session expired. Sign in again and retry.',
  auth_required: 'Export requires sign-in to be enabled.',
  not_configured: "Export needs Burrow's data file, which can't be opened. Try restarting Burrow.",
  network: "Couldn't reach the server. Check your connection and try again.",
  generic: 'Export failed. Try again.',
};

function messageFor({ code, status }) {
  if (code === 'rate_limited' || status === 429) return MESSAGES.rate_limited;
  if (status === 401) return MESSAGES.session;
  if (code === 'auth_required' || status === 403) return MESSAGES.auth_required;
  if (code === 'not_configured') return MESSAGES.not_configured;
  return MESSAGES.generic;
}

function exportError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

const isAbort = (e) => e?.name === 'AbortError';

export function filenameFrom(disposition) {
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  return match ? match[1] : fallbackFilename();
}

/** POSTs /api/export (optionally for a subset of tables). Throws a user-safe Error on failure. */
async function requestExport(tables, signal) {
  const init = tables
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables }), signal }
    : { method: 'POST', signal };
  let response;
  try {
    response = await fetch('/api/export', init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw exportError(e instanceof TypeError ? MESSAGES.network : MESSAGES.generic);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = body?.code;
    throw exportError(messageFor({ code, status: response.status }), {
      code,
      status: response.status,
      tables: Array.isArray(body?.tables) ? body.tables : undefined,
    });
  }
  return response;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Deferred so the browser has started the download before the blob URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

async function saveResponse(response, signal) {
  const filename = filenameFrom(response.headers.get('Content-Disposition'));
  const complete = response.headers.get('X-Export-Complete') === '1';
  const blob = await response.blob();
  // Unmounted or cancelled while downloading: do not save anything.
  signal?.throwIfAborted();
  saveBlob(blob, filename);
  return { filename, bytes: blob.size, complete };
}

/**
 * Requests the full data export and saves it through a temporary download link. When the
 * full export is too large it falls back to one ZIP per table, sequentially.
 * @param {{ signal?: AbortSignal }} [opts]
 * Rejects with `savedParts`/`totalParts` set when the fallback stops partway after saving files.
 * @returns {Promise<{ filename: string, bytes: number, complete: boolean, tooLarge: string[], parts: number }>}
 *   complete is false when any table was incomplete or too large; tooLarge lists tables that
 *   could not be exported even on their own.
 */
export async function downloadExport({ signal } = {}) {
  try {
    const saved = await saveResponse(await requestExport(null, signal), signal);
    return { ...saved, tooLarge: [], parts: 1 };
  } catch (e) {
    if (e?.code !== 'export_too_large' || !e.tables?.length) {
      if (e?.code === 'export_too_large') throw exportError(MESSAGES.generic, { code: e.code, status: e.status });
      throw e;
    }
    return downloadPerTable(e.tables, signal);
  }
}

async function downloadPerTable(tables, signal) {
  const tooLarge = [];
  let bytes = 0;
  let parts = 0;
  let complete = true;
  let filename = fallbackFilename();
  const stopped = (e) => {
    if (parts > 0 && !isAbort(e)) {
      throw Object.assign(e, { savedParts: parts, totalParts: tables.length });
    }
    throw e;
  };
  for (const id of tables) {
    signal?.throwIfAborted();
    try {
      const saved = await saveResponse(await requestExport([id], signal), signal);
      bytes += saved.bytes;
      parts += 1;
      filename = saved.filename;
      if (!saved.complete) complete = false;
    } catch (e) {
      if (e?.code !== 'export_too_large') stopped(e);
      tooLarge.push(id);
    }
  }
  return { filename, bytes, complete: complete && tooLarge.length === 0, tooLarge, parts };
}
