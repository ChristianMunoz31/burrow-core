// Serves the built SPA (dist/) from the same Express app so `npm run build && npm start`
// runs Burrow as one process. No-op when dist/index.html does not exist (dev uses Vite).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const API_PREFIX_RE = /^\/api(\/|$)/i;

/**
 * @param {import('express').Express} app
 * @param {{ distDir: string }} opts
 * @returns {boolean} true when static serving was enabled
 */
export function registerStaticRoutes(app, { distDir }) {
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) return false;

  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under assets/; index.html must always revalidate.
        const hashed = filePath.split(path.sep).includes('assets');
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  // SPA fallback: any non-API GET/HEAD gets index.html so client-side routes work on reload.
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API_PREFIX_RE.test(req.path)) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });
  return true;
}
