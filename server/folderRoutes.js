// /api/folders: add (pasted path or the native folder picker), confirm an imported folder, list, rename, remove, scan, cancel,
// poll, list files, export (download or the native save dialog), and the dialog poll and cancel routes. The report and ask routes
// are Pro: the Pro module registers them through the folders slot (server/proExtensions.js).
// Success bodies are { data }; errors are { error: <code>, code: <code>, message } with fixed copy from
// server/folders/constants.js (AI and Pro errors keep their existing shapes). Every response is no-store.
// Pro-gated routes answer 403 pro_required before any work. No route reads or writes anything inside a folder:
// scanning happens in server/folders/jobs.js, which only ever reads. Request bodies are never logged.
// In the desktop app a folder is added only through the native folder picker (the shell opens the window and returns the
// chosen path over an authenticated channel, server/desktop/dialogBroker.js); a pasted path is refused there
// (409 folder_pick_required) and works only where no dialogs exist (web and Docker).
import rateLimit from 'express-rate-limit';
import { sendAiError, signalOnClose } from './ai/index.js';
import { recordAudit } from './auditHook.js';
import { captureDataGeneration } from './dataGeneration.js';
import { isDbError } from './db/index.js';
import {
  DialogError,
  MAX_SAVE_BYTES,
  cancelDialog,
  createPickRequest,
  createSaveRequest,
  getDialog,
} from './desktop/dialogBroker.js';
import { isShellDialogAvailable } from './desktop/shellChannel.js';
import { slugify } from './export/markdown.js';
import { resolveHostPolicy } from './hostGuard.js';
import { requireProWhen } from './pro.js';
import { proSlotRouter, setFolderRouteHelpers } from './proExtensions.js';
import { makeRequireSameOrigin } from './sameOriginGuard.js';
import { addFolderFromPath, confirmFolderPath } from './folders/addFolder.js';
import { FOLDER_MESSAGES, FOLDER_STATUS, FolderError, PREVIEW_MOVED_MESSAGE, PUBLIC_LIMITS } from './folders/constants.js';
import { folderCsv, folderJson, folderMarkdown } from './folders/exportReport.js';
import { cancelFolderJob, enqueueFolderJob, forgetFolderJobs, getFolderJob, waitForFolderJob } from './folders/jobs.js';
import { previewFile } from './folders/preview.js';
import { clearPreviewFolder } from './folders/previewCache.js';
import { allFileRows, getFile, getFolder, listFiles, listFolders, removeFolder, updateFolder } from './folders/store.js';
import { toFileView, toFolderView } from './folders/views.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hasControlChar = (s) => [...s].some((c) => c.charCodeAt(0) <= 0x1f || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));
const SORTS = new Set(['path', 'size', 'modified', 'status']);
const DIRS = new Set(['asc', 'desc']);
const FORMATS = Object.freeze({
  md: { type: 'text/markdown; charset=utf-8', ext: 'md' },
  json: { type: 'application/json', ext: 'json' },
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
});
const WINDOW_MS = 15 * 60 * 1000;
const DIALOG_ID_RE = /^[0-9a-f]{32}$/;

const send = (res, code) => {
  res.set('Cache-Control', 'no-store');
  return res.status(FOLDER_STATUS[code]).json({ error: code, code, message: FOLDER_MESSAGES[code] });
};

const isPlainBody = (b) => b !== null && typeof b === 'object' && !Array.isArray(b);

/** A name the user typed: 1 to 120 characters after trimming, no control characters. */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 && !hasControlChar(name) ? name : null;
}

const makeLimiter = (max, windowMs = WINDOW_MS) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', code: 'rate_limited', message: FOLDER_MESSAGES.rate_limited },
  });

const requireJson = (req, res, next) => (req.is('application/json') ? next() : send(res, 'unsupported_media_type'));

/**
 * @param {import('express').Express} app
 * @param {{ hostPolicy?: ReturnType<typeof resolveHostPolicy>, dialogsAvailable?: () => boolean, maxSaveBytes?: number }} [opts]
 *   `dialogsAvailable` says whether the shell can open the native dialogs (default: the desktop shell flag); `maxSaveBytes`
 *   is a test seam for the size limit of a save dialog export
 */
export function registerFolderRoutes(
  app,
  { hostPolicy = resolveHostPolicy(), dialogsAvailable = () => isShellDialogAvailable(), maxSaveBytes = MAX_SAVE_BYTES } = {},
) {
  const writeLimiter = makeLimiter(60);
  const aiLimiter = makeLimiter(20);
  const exportLimiter = makeLimiter(30);
  const pollLimiter = makeLimiter(1200);
  const previewLimiter = makeLimiter(240, 5 * 60 * 1000);
  const sameOrigin = makeRequireSameOrigin({ hostPolicy, onBlocked: (res) => send(res, 'folder_origin_blocked') });

  app.use('/api/folders', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Wrap a handler: fixed-copy errors, never provider or database text. */
  const handle = (fn) => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      if (res.headersSent) return undefined;
      if (err instanceof FolderError || err instanceof DialogError) return send(res, err.code);
      if (sendAiError(res, err)) return undefined;
      if (isDbError(err) && err.code === 'constraint') return send(res, 'folder_exists');
      console.error('Folders route failed:', err?.code || err?.name || 'unknown');
      return send(res, 'folder_failed');
    }
  };

  /** The folder row for :id, or a 404 sent (returns null). */
  const folderOr404 = (req, res) => {
    const id = String(req.params.id ?? '');
    const row = UUID_RE.test(id) ? getFolder(id.toLowerCase()) : null;
    if (!row) {
      send(res, 'folder_not_found');
      return null;
    }
    return row;
  };

  const view = (row) => toFolderView(row, getFolderJob(row.id));

  app.get(
    '/api/folders',
    handle((_req, res) => {
      const dialogs = dialogsAvailable();
      return res.json({ data: { folders: listFolders().map(view), limits: PUBLIC_LIMITS, canPickFolder: dialogs, canSaveFile: dialogs } });
    }),
  );

  /** DialogView plus the folder and its job once a pick added one. */
  const dialogPayload = (dialog) => {
    const row = dialog.folderId ? getFolder(dialog.folderId) : null;
    return { ...dialog, folder: row ? view(row) : null, job: dialog.folderId ? getFolderJob(dialog.folderId) : null };
  };

  app.post(
    '/api/folders',
    sameOrigin,
    writeLimiter,
    requireJson,
    handle(async (req, res) => {
      // The desktop app grants read access only through a choice in the native folder window, never a typed path.
      if (dialogsAvailable()) return send(res, 'folder_pick_required');
      const body = req.body;
      if (!isPlainBody(body) || Object.keys(body).some((k) => k !== 'path' && k !== 'name') || typeof body.path !== 'string') {
        return send(res, 'invalid_request');
      }
      let name = null;
      if (body.name !== undefined) {
        name = cleanName(body.name);
        if (name === null) return send(res, 'invalid_request');
      }
      const { folderId, job } = await addFolderFromPath(body.path, { name });
      const row = getFolder(folderId);
      return res.status(201).json({ data: { folder: view(row), job } });
    }),
  );

  app.post(
    '/api/folders/pick',
    sameOrigin,
    writeLimiter,
    requireJson,
    handle((req, res) => {
      const body = req.body;
      const keys = isPlainBody(body) ? Object.keys(body) : null;
      if (keys === null || keys.length > 1 || (keys.length === 1 && (keys[0] !== 'folderId' || typeof body.folderId !== 'string' || !UUID_RE.test(body.folderId)))) {
        return send(res, 'invalid_request');
      }
      if (!dialogsAvailable()) return send(res, 'dialog_unavailable');
      const folderId = keys.length === 1 ? body.folderId.toLowerCase() : null;
      if (folderId) {
        const row = getFolder(folderId);
        if (!row) return send(res, 'folder_not_found');
        if (row.confirm_state !== 'needs_confirm') return send(res, 'folder_already_confirmed');
      } else if (listFolders().length >= PUBLIC_LIMITS.maxFolders) {
        // Checked before any window opens, so the user never picks a folder that cannot be added.
        return send(res, 'folder_limit');
      }
      const dialog = createPickRequest({
        onPicked: (picked, guard) => (folderId ? confirmFolderPath(folderId, picked, guard) : addFolderFromPath(picked, guard)),
      });
      return res.status(202).json({ data: { dialog: dialogPayload(dialog) } });
    }),
  );

  app.get(
    '/api/folders/dialogs/:dialogId',
    pollLimiter,
    handle((req, res) => {
      const dialogId = String(req.params.dialogId ?? '');
      const dialog = DIALOG_ID_RE.test(dialogId) ? getDialog(dialogId) : null;
      if (!dialog) return send(res, 'dialog_not_found');
      return res.json({ data: { dialog: dialogPayload(dialog) } });
    }),
  );

  app.post(
    '/api/folders/dialogs/:dialogId/cancel',
    writeLimiter,
    handle((req, res) => {
      const dialogId = String(req.params.dialogId ?? '');
      const dialog = DIALOG_ID_RE.test(dialogId) ? cancelDialog(dialogId) : null;
      if (!dialog) return send(res, 'dialog_not_found');
      return res.json({ data: { dialog: dialogPayload(dialog) } });
    }),
  );

  app.post(
    '/api/folders/:id/confirm',
    sameOrigin,
    writeLimiter,
    requireJson,
    handle(async (req, res) => {
      const body = req.body;
      if (!isPlainBody(body) || Object.keys(body).length !== 1 || typeof body.path !== 'string') return send(res, 'invalid_request');
      if (dialogsAvailable()) return send(res, 'folder_pick_required');
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const { job } = await confirmFolderPath(row.id, body.path);
      return res.json({ data: { folder: view(getFolder(row.id) ?? row), job } });
    }),
  );

  app.patch(
    '/api/folders/:id',
    requireProWhen('folder_auto_rescan', (req) => req.body?.autoRescan === true),
    writeLimiter,
    requireJson,
    handle((req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const body = req.body;
      const keys = isPlainBody(body) ? Object.keys(body) : [];
      if (keys.length === 0 || keys.some((k) => k !== 'name' && k !== 'autoRescan')) return send(res, 'invalid_request');
      const patch = {};
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (name === null) return send(res, 'invalid_request');
        patch.name = name;
      }
      if (body.autoRescan !== undefined) {
        if (typeof body.autoRescan !== 'boolean') return send(res, 'invalid_request');
        // A folder that came from an import is not read, and not scheduled, until the user confirms it.
        if (body.autoRescan === true && row.confirm_state !== 'ok') return send(res, 'folder_needs_confirm');
        patch.auto_rescan = body.autoRescan;
      }
      const updated = updateFolder(row.id, patch);
      return res.json({ data: { folder: view(updated ?? row) } });
    }),
  );

  app.delete(
    '/api/folders/:id',
    writeLimiter,
    handle(async (req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const job = getFolderJob(row.id);
      if (job && (job.status === 'queued' || job.status === 'running')) {
        try {
          cancelFolderJob(row.id);
        } catch {
          /* it ended on its own */
        }
        await waitForFolderJob(job.id, { timeoutMs: 2000 });
      }
      // Rows go with the folder (cascade). Files on disk are never touched.
      removeFolder(row.id);
      forgetFolderJobs(row.id);
      clearPreviewFolder(row.id);
      return res.json({ data: { removed: true } });
    }),
  );

  app.post(
    '/api/folders/:id/scan',
    writeLimiter,
    handle((req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const job = enqueueFolderJob({ folderId: row.id, kind: 'scan', trigger: 'user' });
      return res.status(202).json({ data: { job } });
    }),
  );

  app.post(
    '/api/folders/:id/cancel',
    writeLimiter,
    handle(async (req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const started = cancelFolderJob(row.id);
      // A running job needs a moment to reach its next checkpoint: answer with where it ended up.
      const job = (await waitForFolderJob(started.id, { timeoutMs: 1500 })) ?? started;
      return res.json({ data: { job } });
    }),
  );

  app.get(
    '/api/folders/:id/job',
    pollLimiter,
    handle((req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      return res.json({ data: { job: getFolderJob(row.id) } });
    }),
  );

  app.get(
    '/api/folders/:id/files',
    handle((req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const { offset: rawOffset, limit: rawLimit, sort: rawSort, dir: rawDir } = req.query;
      const isIntText = (v) => typeof v === 'string' && /^\d{1,9}$/.test(v);
      if (
        (rawOffset !== undefined && !isIntText(rawOffset)) ||
        (rawLimit !== undefined && !isIntText(rawLimit)) ||
        (rawSort !== undefined && (typeof rawSort !== 'string' || !SORTS.has(rawSort))) ||
        (rawDir !== undefined && (typeof rawDir !== 'string' || !DIRS.has(rawDir)))
      ) {
        return send(res, 'invalid_request');
      }
      const offset = rawOffset === undefined ? 0 : Number(rawOffset);
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (limit < 1 || limit > 200) return send(res, 'invalid_request');
      const { rows, total } = listFiles(row.id, { offset, limit, sort: rawSort ?? 'path', dir: rawDir ?? 'asc' });
      return res.json({ data: { files: rows.map(toFileView), total, offset, limit } });
    }),
  );

  // The read-only preview of one inventory file (ids only, never a path). Free. Own limiter; the global one skips it (server.js).
  app.get(
    '/api/folders/:id/files/:fileId/preview',
    previewLimiter,
    handle(async (req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const fileId = String(req.params.fileId ?? '');
      const file = UUID_RE.test(fileId) ? getFile(fileId.toLowerCase()) : null;
      if (!file || file.folder_id !== row.id) return send(res, 'folder_file_not_found');
      if (row.confirm_state !== 'ok') return send(res, 'folder_needs_confirm');
      const closed = signalOnClose(res);
      let body;
      try {
        body = await previewFile(row, file, { signal: closed });
      } catch (err) {
        if (closed.aborted) return undefined;
        if (err instanceof FolderError && err.code === 'folder_moved') {
          res.set('Cache-Control', 'no-store');
          return res.status(FOLDER_STATUS.folder_moved).json({ error: 'folder_moved', code: 'folder_moved', message: PREVIEW_MOVED_MESSAGE });
        }
        throw err;
      }
      if (closed.aborted) return undefined;
      return res.json({ data: body });
    }),
  );

  app.post(
    '/api/folders/:id/export',
    exportLimiter,
    requireJson,
    handle(async (req, res) => {
      const row = folderOr404(req, res);
      if (!row) return undefined;
      const body = req.body;
      if (
        !isPlainBody(body) ||
        Object.keys(body).some((k) => k !== 'format' && k !== 'target') ||
        typeof body.format !== 'string' ||
        !Object.hasOwn(FORMATS, body.format) ||
        (body.target !== undefined && body.target !== 'download' && body.target !== 'choose')
      ) {
        return send(res, 'invalid_request');
      }
      const format = body.format;
      const choose = body.target === 'choose';
      if (choose && !dialogsAvailable()) return send(res, 'dialog_unavailable');
      const files = allFileRows(row.id);
      let text;
      if (format === 'md') text = folderMarkdown(row, files);
      else if (format === 'json') text = folderJson(row, files, new Date());
      else text = folderCsv(files);
      const { type, ext } = FORMATS[format];
      const date = new Date().toISOString().slice(0, 10);
      const fileName = `burrow-folder-${slugify(row.name, 'folder')}-${date}.${ext}`;
      if (choose) {
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > maxSaveBytes) return send(res, 'save_too_large');
        const dataGen = captureDataGeneration();
        // One audit row per save, when the request ends: format, file count, target and result only (never a path or name).
        const onResult = async (result) => {
          if (dataGen.isStale()) return;
          await recordAudit({
            kind: 'export',
            feature: 'folder_export',
            page: 'folders',
            status: result === 'saved' ? 'ok' : 'error',
            meta: { format, files: files.length, target: 'chosen', result },
          });
        };
        const dialog = createSaveRequest({ name: fileName, ext, bytes, onResult });
        return res.status(202).json({ data: { dialog: dialogPayload(dialog) } });
      }
      await recordAudit({ kind: 'export', feature: 'folder_export', page: 'folders', status: 'ok', meta: { format, files: files.length, target: 'download' } });
      res.set('Content-Type', type);
      res.set('Content-Disposition', `attachment; filename="${fileName}"`);
      res.set('Access-Control-Expose-Headers', 'Content-Disposition');
      return res.status(200).send(text);
    }),
  );

  // The report and ask routes belong to the Pro module (docs/adr/0001-open-core-split.md 3.4). Core mounts the gate
  // (requirePro, the AI limiter and the JSON type check) in front of them; without the module they answer 501 pro_not_included.
  setFolderRouteHelpers({ handle, send, folderOr404, aiLimiter, requireJson, isPlainBody });
  app.use(proSlotRouter('folders'));

  // Malformed JSON, an oversized body and similar body-parser errors on these routes answer with the Folders error shape
  // (the global handler would answer another shape). Registered last in this module so it runs before the global handler;
  // routes outside /api/folders are unaffected.
  app.use('/api/folders', (err, _req, res, next) => {
    const status = err?.status ?? err?.statusCode;
    if (typeof err?.type !== 'string' || !Number.isInteger(status) || status < 400 || status >= 500) return next(err);
    return send(res, status === 415 ? 'unsupported_media_type' : 'invalid_request');
  });
}
