// /api/secrets — manage third-party API keys from Settings. Gated by the session
// middleware in server.js; writes also pass secretsWriteLimiter (mounted there).
//
// Responses carry only status metadata (see getSecretStatus): never values,
// ciphertext, iv or auth tags. Error bodies and logs never include request data or
// database error objects.
import { encryptSecret, last4 } from './secrets/crypto.js';
import { getSecretDef, validateSecretValue } from './secrets/registry.js';
import {
  getEncryptionKey,
  getSecret,
  getSecretStatus,
  getSecretsState,
  getSecretsStore,
  invalidateSecrets,
  listSecretStatuses,
  primeSecrets,
} from './secrets/getSecret.js';
import { testSecret } from './secrets/testSecret.js';
import { isEnabled, networkRequiredBody } from './netPolicy.js';
import { recordNetworkCall } from './networkCall.js';

const err = (res, status, code, error) => res.status(status).json({ error, code });

const logFailure = (e) => console.error('Secrets route error:', e?.code ?? 'unknown');

function storeFailure(res, e) {
  if (e?.code === 'schema_missing') {
    return err(res, 503, 'schema_missing', 'Secrets storage is unavailable.');
  }
  logFailure(e);
  return err(res, 500, 'server_error', 'Server error');
}

/**
 * @param {import('express').Express} app
 */
export function registerSecretsRoutes(app) {
  app.use('/api/secrets', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Resolves the def for :name or sends 404 (never echoing the input).
  const withDef = (handler) => async (req, res) => {
    try {
      const def = getSecretDef(req.params.name);
      if (!def) return err(res, 404, 'unknown_secret', 'Unknown secret');
      return await handler(req, res, def);
    } catch (e) {
      logFailure(e);
      return err(res, 500, 'server_error', 'Server error');
    }
  };

  // Shared PUT/DELETE preconditions. Returns { key, store } or sends the refusal.
  const writePrereqs = (res) => {
    const keyRes = getEncryptionKey();
    if (!keyRes.ok) {
      err(res, 503, 'encryption_disabled', "Encrypted key storage is unavailable: Burrow couldn't read or create its key file in the data directory (or set SECRETS_ENCRYPTION_KEY).");
      return null;
    }
    const store = getSecretsStore();
    if (!store) {
      err(res, 503, 'storage_not_configured', 'Local database is unavailable.');
      return null;
    }
    return { key: keyRes.key, store };
  };

  app.get('/api/secrets', async (req, res) => {
    try {
      await primeSecrets();
      const { encryption, storage } = getSecretsState();
      // writesAllowed is always true now; kept so the client contract is unchanged.
      // writable: writes can actually succeed (encryption + storage).
      const secrets = listSecretStatuses();
      res.json({
        encryption,
        storage,
        writesAllowed: true,
        writable: encryption.enabled && storage.available,
        secrets,
      });
    } catch (e) {
      logFailure(e);
      err(res, 500, 'server_error', 'Server error');
    }
  });

  app.put(
    '/api/secrets/:name',
    withDef(async (req, res, def) => {
      const prereqs = writePrereqs(res);
      if (!prereqs) return undefined;
      const raw = req.body?.value;
      if (typeof raw !== 'string') return err(res, 400, 'invalid_body', 'Body must be { "value": string }.');
      const checked = validateSecretValue(def.name, raw);
      if (!checked.ok) {
        return err(res, 400, 'invalid_value', `That doesn't look like a valid ${def.label} key.`);
      }
      const enc = encryptSecret(checked.value, def.name, prereqs.key);
      try {
        await prereqs.store.upsert({
          name: def.name,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          auth_tag: enc.authTag,
          last4: last4(checked.value),
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        return storeFailure(res, e);
      }
      invalidateSecrets(def.name);
      await primeSecrets();
      return res.json(getSecretStatus(def.name));
    }),
  );

  app.delete(
    '/api/secrets/:name',
    withDef(async (req, res, def) => {
      const prereqs = writePrereqs(res);
      if (!prereqs) return undefined;
      try {
        await prereqs.store.remove(def.name);
      } catch (e) {
        return storeFailure(res, e);
      }
      invalidateSecrets(def.name);
      await primeSecrets();
      return res.json(getSecretStatus(def.name));
    }),
  );

  app.post(
    '/api/secrets/:name/test',
    withDef(async (req, res, def) => {
      if (!def.test) return err(res, 400, 'not_testable', 'This key cannot be tested.');
      // The ping calls the provider's host, so it needs the opt-in the def names. A testable
      // def without one is refused rather than pinged ungated.
      const feature = def.networkFeature;
      if (!feature) return err(res, 400, 'not_testable', 'This key cannot be tested.');
      if (!(await isEnabled(feature))) return res.status(403).json(networkRequiredBody(feature));
      const value = await getSecret(def.name);
      if (!value) return res.json({ ok: false, reason: 'not_configured' });
      // Resolve global fetch at call time so it can be stubbed in tests.
      const result = await testSecret(def.name, value, {
        fetchImpl: (...args) => globalThis.fetch(...args),
      });
      // testSecret reports ok only for a 2xx answer; 401, 403, 429, 5xx, a thrown error and a timeout are failures.
      await recordNetworkCall(feature, def.test.url, result.ok ? 'ok' : 'error');
      return res.json(result);
    }),
  );
}
