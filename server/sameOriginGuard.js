// Same-origin guard for the routes that must only ever be driven from Burrow's own window (Erase all my data, the import
// from the direct Burrow). It runs ahead of the sign-in check and is independent of ALLOWED_ORIGINS: the browser must say
// which page it is (Origin present), that page must be served from the same origin as this request's Host (so another
// page on a loopback port, such as the dev server, is refused), and Sec-Fetch-Site, when sent, must be same-origin or
// none. A page on another origin can neither get a token nor use the route.
import { isSameOrigin, resolveHostPolicy } from './hostGuard.js';

/**
 * @param {{ hostPolicy?: ReturnType<typeof resolveHostPolicy>, onBlocked: (res: import('express').Response) => unknown }} opts
 *   `onBlocked` sends the route's own 403 body.
 * @returns {import('express').RequestHandler}
 */
export function makeRequireSameOrigin({ hostPolicy = resolveHostPolicy(), onBlocked }) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const siteOk = site === undefined || ['same-origin', 'none'].includes(site.trim().toLowerCase());
    if (!origin || !siteOk || !isSameOrigin(origin, req.get('host'), hostPolicy)) return onBlocked(res);
    return next();
  };
}
