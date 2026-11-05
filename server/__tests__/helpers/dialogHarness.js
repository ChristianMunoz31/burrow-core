// Test harness for the native dialogs: a small Express app with the Folders routes (optionally behind the real desktop
// gate), a capture of the request lines the server would print for the shell, and signed replies like the shell sends.
import crypto from 'node:crypto';
import express from 'express';
import { dialogKeyHexForTests, initDesktopAuth, createDesktopGate, cookieValue, resetDesktopAuth } from '../../desktop/auth.js';
import { __clearDialogsForTests, __setDialogWriterForTests, handleDialogReplyPayload, serveDialogFile } from '../../desktop/dialogBroker.js';
import { requestShellDialog } from '../../desktop/shellChannel.js';
import { registerFolderRoutes } from '../../folderRoutes.js';

export const TEST_SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
export const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });

/** Start capturing request lines. @returns {{ lines: string[], requests: () => object[] }} */
export function captureRequests() {
  const lines = [];
  const out = { write: (chunk) => lines.push(chunk) };
  __setDialogWriterForTests((request) => requestShellDialog(request, { out, desktop: true }));
  return { lines, requests: () => lines.map((l) => JSON.parse(l.slice(l.indexOf('{')))) };
}

/** Install the launch secret, forget old requests and return the key hex. */
export function startDialogs() {
  initDesktopAuth(TEST_SECRET);
  __clearDialogsForTests();
  return dialogKeyHexForTests();
}

export function stopDialogs() {
  __clearDialogsForTests();
  __setDialogWriterForTests(null);
  resetDesktopAuth();
}

const hmac = (message) => crypto.createHmac('sha256', Buffer.from(dialogKeyHexForTests(), 'hex')).update(message, 'utf8').digest('hex');

/** What the shell sends back for a request: one signed reply payload. */
export const signedReply = (id, status, path = '', over = {}) =>
  JSON.stringify({ v: 1, id, status, path, mac: hmac(`burrow-dialog-reply-v1\n${id}\n${status}\n${path}`), ...over });

/** Deliver a reply as the stdin inbox would. */
export const deliver = (id, status, path = '') => handleDialogReplyPayload(signedReply(id, status, path));

/** The proof header value for a file fetch. */
export const fetchProof = (id) => hmac(`burrow-dialog-fetch-v1\n${id}`);

/**
 * @param {{ gate?: boolean, dialogsAvailable?: boolean, maxSaveBytes?: number }} [opts]
 * @returns {import('express').Express}
 */
export function makeDialogApp({ gate = false, dialogsAvailable = true, maxSaveBytes } = {}) {
  const app = express();
  if (gate) app.use(createDesktopGate({ serveDialogFile }));
  app.use(express.json({ limit: '2mb' }));
  registerFolderRoutes(app, { dialogsAvailable: () => dialogsAvailable, ...(maxSaveBytes === undefined ? {} : { maxSaveBytes }) });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

/** Cookie header for requests through the desktop gate (call after startDialogs). */
export const gateCookie = () => `burrow_desktop=${cookieValue()}`;
