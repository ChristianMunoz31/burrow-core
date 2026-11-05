// Content-Security-Policy for the desktop webview. The built index.html has one inline script
// (pre-paint theme); it is allowed by hash so script-src never needs 'unsafe-inline'.
import crypto from 'node:crypto';

// Styles. The React UI (and recharts) set inline style="" attributes on elements at runtime, which only
// style-src-attr 'unsafe-inline' permits; stylesheet elements and files stay limited to 'self' (the build
// emits no inline <style> tags). Attribute styles cannot run script, so this is the narrowest workable policy.
const STYLE_DIRECTIVES = ["style-src 'self'", "style-src-attr 'unsafe-inline'"];

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Policy string for an index.html: every inline script is allowed by its sha256 hash.
 * @param {string} indexHtml
 * @returns {string}
 */
export function buildCsp(indexHtml) {
  const hashes = [];
  for (const match of String(indexHtml).matchAll(INLINE_SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(match[1]) || match[2].trim() === '') continue;
    const hash = `'sha256-${crypto.createHash('sha256').update(match[2], 'utf8').digest('base64')}'`;
    if (!hashes.includes(hash)) hashes.push(hash);
  }
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...hashes].join(' ')}`,
    ...STYLE_DIRECTIVES,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Middleware that sets the CSP and hardening headers on EVERY response (HTML, JSON, assets, error pages).
 * The SPA fallback serves index.html for any non-API path, including ones with a dot (/notes/v1.2, /x.json),
 * so the response type cannot be guessed from the URL; the headers are harmless on non-HTML responses.
 * @param {string} csp
 * @returns {import('express').RequestHandler}
 */
export function createSecurityHeaders(csp) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  };
}
