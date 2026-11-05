// Shared sign-in guard for the bulk data routes (export, import). Without sign-in enabled,
// only loopback clients may call them (fail closed otherwise).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopback = (req) => LOOPBACK.has(req.ip) && LOOPBACK.has(req.socket?.remoteAddress);

/**
 * @param {{ authEnabled?: boolean, action?: string }} [opts] action is the noun used in the 403 message
 * @returns {import('express').RequestHandler}
 */
export function makeRequireSignIn({ authEnabled = false, action = 'Export' } = {}) {
  return (req, res, next) => {
    if (!authEnabled && !isLoopback(req)) {
      res.set('Cache-Control', 'no-store');
      return res.status(403).json({ error: `${action} requires sign-in to be enabled.`, code: 'auth_required' });
    }
    return next();
  };
}
