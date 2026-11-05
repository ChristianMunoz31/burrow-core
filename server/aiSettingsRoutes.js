// Settings > AI: /api/settings/ai. Registered after the auth gate in server.js; every
// response is no-store. Success bodies are { data }, failures { error, code, message? }.
// Writes return the full GET /api/settings/ai payload.
import fs from 'node:fs';
import os from 'node:os';
import rateLimit from 'express-rate-limit';
import {
  AI_REASONS,
  AiUnavailableError,
  CLOUD_CATEGORY_IDS,
  CLOUD_CONSENT_ACKS,
  CLOUD_CONSENT_VERSION,
  MSG_AI_OFF,
  PULLABLE_MODELS,
  PullError,
  detectOllamaInstall,
  getAiSetupSnapshot,
  getAiSettings,
  getAiStatus,
  getCloudConsent,
  getPullTarget,
  forgetAiHealth,
  invalidateAiHealth,
  isAiEnabled,
  isConsentCurrent,
  isValidModelName,
  listInstalledModels,
  NO_CLOUD_HINT,
  openSse,
  pullModel,
  clearCloudConsent,
  recommendModels,
  recordCloudConsent,
  recordCloudHint,
  updateAiSettings,
  updateCloudCategories,
  validateCloudBaseUrl,
  validateEndpointUrl,
} from './ai/index.js';
import { recordAudit } from './auditHook.js';
import { isEnabled, networkRequiredBody, setNetworkFeature } from './netPolicy.js';
import { getSecret } from './secrets/index.js';
import { sendStorageError } from './storageErrors.js';

const TOKEN_PARAMS = ['max_tokens', 'max_completion_tokens'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (res, status, code, message) => res.status(status).json({ error: code, code, ...(message ? { message } : {}) });

const CLOUD_KEY = 'AI_CLOUD_API_KEY';
const hostOf = (baseUrl) => {
  const v = baseUrl ? validateCloudBaseUrl(baseUrl) : null;
  return v?.ok ? v.hostname : null;
};
// Origin plus path, normalized: what consent is bound to (a new path is a new endpoint).
const normalizedUrlOf = (baseUrl) => {
  const v = baseUrl ? validateCloudBaseUrl(baseUrl) : null;
  return v?.ok ? v.url : null;
};

/**
 * Turn cloud AI fully off: the cloudAi opt-in off FIRST (the gate every outbound call checks), then
 * provider back to local and consent cleared (each best effort, so one failure never stops the
 * others), then a 'disabled' audit row only when something actually changed. The first failure is
 * rethrown at the end so the caller still sees a storage error. Used by the disable route and by
 * the Network settings toggle.
 */
export async function disableCloudAi() {
  let failure = null;
  const attempt = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      failure ??= err;
      return undefined;
    }
  };
  // What was on before, so the audit row means something. An unreadable state counts as changed.
  const wasOn = await attempt(() => isEnabled('cloudAi'));
  const wasCloud = await attempt(async () => (await getAiSettings()).provider === 'openai_compat');
  const hadConsent = await attempt(async () => (await getCloudConsent()) !== null);

  await attempt(() => setNetworkFeature('cloudAi', false));
  await attempt(() => updateAiSettings({ provider: 'ollama' }));
  await attempt(() => clearCloudConsent());

  if (wasOn !== false || wasCloud !== false || hadConsent !== false) {
    await attempt(() =>
      recordAudit({
        kind: 'llm',
        feature: 'cloud_ai_consent',
        provider: 'openai_compat',
        status: 'ok',
        meta: { action: 'disabled' },
      }),
    );
  }
  if (failure) throw failure;
}

/** Category names shared with and withheld from a cloud provider (names only, for the audit row). */
const categorySplit = (categories) => ({
  shared: CLOUD_CATEGORY_IDS.filter((id) => categories[id]),
  withheld: CLOUD_CATEGORY_IDS.filter((id) => !categories[id]),
});

const sendUnavailable = (res, err) =>
  res.status(503).json({
    error: err.code,
    code: err.code,
    reason: err.reason,
    message: err.publicMessage,
    ...(err.hint ? { hint: err.hint } : {}),
  });

const sendOptIn = (res, feature) => res.status(403).json({ ...networkRequiredBody(feature), code: 'network_opt_in_required' });

// Fixed copy for model downloads. Upstream text is never forwarded.
const PULL_MESSAGES = Object.freeze({
  invalid_model: 'Choose one of the suggested models.',
  pull_requires_local_ollama: 'Models can only be downloaded to Ollama running on this computer.',
  pull_in_progress: 'A download is already running.',
  pull_failed: 'The download did not finish. Check your internet connection and try again.',
  timeout: 'The download stalled. Check your internet connection and try again.',
});
/** At most this often is a progress event sent (the last frame is always sent). */
export const PULL_PROGRESS_MIN_MS = 250;
/** Only one model download runs at a time (it is a multi-gigabyte transfer). */
let pullActive = false;

/** Test hook: release the download lock. */
export function __resetPullForTests() {
  pullActive = false;
}

/** The setup state of Ollama for the first-run flow. */
function ollamaState(snap, installed) {
  if (!snap.enabled) return 'disabled';
  if (!snap.loopback) return 'remote';
  if (snap.running) return 'running';
  if (snap.errorCode === 'not_ollama' || snap.errorCode === 'timeout') return 'unreachable';
  return installed ? 'stopped' : 'missing';
}

async function respondStatus(res) {
  res.json({ data: await getAiStatus({ fresh: true }) });
}

/**
 * @param {import('express').Express} app
 * @param {{ exists?: (p: string) => boolean, totalmem?: () => number, pullRateMax?: number, platform?: string }} [deps]
 *   Injection points for tests; production passes none.
 */
export function registerAiSettingsRoutes(app, { exists = fs.existsSync, totalmem = () => os.totalmem(), pullRateMax = 10, platform = process.platform } = {}) {
  // Local to this route so server.js needs no change: model downloads are rare and heavy.
  const pullLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: pullRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
  });

  app.use('/api/settings/ai', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/settings/ai', async (req, res) => {
    try {
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.get('/api/settings/ai/setup', async (req, res) => {
    try {
      const snap = await getAiSetupSnapshot();
      const installed = detectOllamaInstall({ platform, env: process.env, exists });
      const ollama = ollamaState(snap, installed);
      const recommended = recommendModels(totalmem());
      res.json({
        data: {
          ollama,
          host: snap.host,
          version: snap.version,
          models: snap.models,
          ready: snap.enabled && (snap.effectiveProvider === 'openai_compat' || snap.chatModel !== null),
          ramGb: recommended.ramGb,
          recommended,
          canPull: snap.enabled && snap.loopback && snap.running,
          provider: snap.effectiveProvider,
        },
      });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.post('/api/settings/ai/pull', pullLimiter, async (req, res) => {
    const model = isPlainObject(req.body) ? req.body.model : undefined;
    if (typeof model !== 'string' || !PULLABLE_MODELS.has(model)) {
      return fail(res, 400, 'invalid_model', PULL_MESSAGES.invalid_model);
    }
    if (!isAiEnabled()) {
      return sendUnavailable(res, new AiUnavailableError('ai_not_configured', MSG_AI_OFF, undefined, AI_REASONS.disabled));
    }
    if (pullActive) return fail(res, 409, 'pull_in_progress', PULL_MESSAGES.pull_in_progress);
    pullActive = true;
    let held = true;
    const release = () => {
      if (held) pullActive = false;
      held = false;
    };
    let sse = null;
    // Registered before the first await: a client that leaves while the target and model
    // list are still loading must still cancel the download and free the lock.
    const ctl = new AbortController();
    let finished = false;
    const onGone = () => {
      if (!finished) ctl.abort();
    };
    req.on('close', () => {
      if (!req.complete) onGone();
    });
    res.on('close', onGone);
    let auditStatus = null;
    try {
      let target;
      try {
        target = await getPullTarget();
        if (!target.loopback) {
          return fail(res, 409, 'pull_requires_local_ollama', PULL_MESSAGES.pull_requires_local_ollama);
        }
        await listInstalledModels();
      } catch (err) {
        if (err instanceof AiUnavailableError) return sendUnavailable(res, err);
        return sendStorageError(res, err);
      }
      // req.destroyed alone is true after a normal body read, so it only counts when incomplete.
      if ((req.destroyed && !req.complete) || res.destroyed || ctl.signal.aborted) {
        ctl.abort();
        auditStatus = 'aborted';
        return undefined;
      }

      sse = openSse(res);

      let pending = null;
      let lastSentAt = 0;
      let lastPhase = null;
      const flush = () => {
        if (!pending) return;
        sse.send('progress', pending);
        lastPhase = pending.phase;
        lastSentAt = Date.now();
        pending = null;
      };

      let failure = null;
      try {
        for await (const frame of pullModel({ model, signal: ctl.signal })) {
          // Never drop the last frame of a phase.
          if (pending && pending.phase !== frame.phase) flush();
          pending = frame;
          if (frame.phase !== lastPhase || Date.now() - lastSentAt >= PULL_PROGRESS_MIN_MS) flush();
        }
        flush();
        if (ctl.signal.aborted) {
          auditStatus = 'aborted';
          return undefined;
        }
      } catch (err) {
        if (ctl.signal.aborted) {
          auditStatus = 'aborted';
          return undefined;
        }
        flush();
        failure = err instanceof PullError && err.code === 'timeout' ? 'timeout' : 'pull_failed';
      }
      finished = true;
      auditStatus = failure ? 'error' : 'ok';
      if (failure) sse.send('error', { code: failure, message: PULL_MESSAGES[failure] });
      else {
        invalidateAiHealth();
        sse.send('done', { model });
      }
      return undefined;
    } finally {
      finished = true;
      release();
      // Pre-validation rejections leave no row; everything past them does. No upstream text.
      if (auditStatus) {
        await recordAudit({
          kind: 'llm',
          feature: 'model_pull',
          provider: 'ollama',
          model,
          status: auditStatus,
          meta: { outcome: auditStatus },
        });
      }
      sse?.close();
    }
  });

  app.get('/api/settings/ai/models', async (req, res) => {
    try {
      res.json({ data: { models: await listInstalledModels() } });
    } catch (err) {
      if (err instanceof AiUnavailableError) return sendUnavailable(res, err);
      return sendStorageError(res, err);
    }
  });

  app.put('/api/settings/ai/models', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return fail(res, 400, 'invalid_body', 'Body must be { chatModel, toolModel }.');
    const patch = {};
    for (const key of ['chatModel', 'toolModel']) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v !== null && !isValidModelName(v)) return fail(res, 400, 'invalid_body', `${key} must be a model name or null.`);
      patch[key] = v;
    }
    try {
      const named = Object.values(patch).filter((v) => v !== null);
      if (named.length) {
        let models;
        try {
          models = await listInstalledModels();
        } catch (err) {
          if (err instanceof AiUnavailableError) return sendUnavailable(res, err);
          throw err;
        }
        const find = (name) => models.find((m) => m.name === name || m.name === `${name}:latest`);
        for (const [key, name] of Object.entries(patch)) {
          if (name === null) continue;
          const m = find(name);
          if (!m) return fail(res, 400, 'model_not_installed', `${name} is not installed in Ollama.`);
          if (key === 'toolModel' && !m.capabilities.includes('tools')) {
            return fail(res, 400, 'model_lacks_tools', `${name} does not support tool calling. Pick another model for Javi.`);
          }
          patch[key] = m.name;
        }
      }
      await updateAiSettings(patch);
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/ai/host', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || !('host' in body)) return fail(res, 400, 'invalid_host', 'Body must be { host: string | null }.');
    let host = null;
    if (body.host !== null) {
      const v = validateEndpointUrl(body.host);
      if (!v.ok) {
        return fail(res, 400, 'invalid_host', 'Enter an http:// or https:// address with a host and port only, for example http://127.0.0.1:11434.');
      }
      if (!v.loopback && !(await isEnabled('aiLan'))) return sendOptIn(res, 'aiLan');
      host = v.origin;
    }
    try {
      await updateAiSettings({ ollamaHost: host });
      forgetAiHealth();
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/ai/provider', async (req, res) => {
    const provider = isPlainObject(req.body) ? req.body.provider : undefined;
    if (provider !== 'ollama' && provider !== 'openai_compat') {
      return fail(res, 400, 'invalid_body', 'provider must be "ollama" or "openai_compat".');
    }
    try {
      if (provider === 'openai_compat') {
        if (!(await isEnabled('cloudAi'))) return sendOptIn(res, 'cloudAi');
        const { cloud } = await getAiSettings();
        const key = await getSecret(CLOUD_KEY);
        if (!cloud.baseUrl || !cloud.model || !key) {
          return fail(res, 400, 'cloud_not_configured', 'Set the cloud base URL, model and API key first.');
        }
        // Cloud AI only ever turns on through POST /cloud/enable, which records consent.
        if (!isConsentCurrent(await getCloudConsent(), hostOf(cloud.baseUrl), normalizedUrlOf(cloud.baseUrl))) {
          return fail(res, 409, 'cloud_consent_required', 'Turn on cloud AI from Settings > AI and confirm what it can see first.');
        }
      }
      await updateAiSettings({ provider });
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/ai/cloud', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return fail(res, 400, 'invalid_body', 'Body must be { baseUrl, model, tokenParam }.');
    const cloud = {};
    if ('baseUrl' in body) {
      if (body.baseUrl === null) cloud.baseUrl = null;
      else {
        const v = validateCloudBaseUrl(body.baseUrl);
        if (!v.ok) {
          // Same code as the Ollama host form; `reason` says why (https_required, private_address, ...).
          return res.status(400).json({
            error: 'invalid_host',
            code: 'invalid_host',
            reason: v.reason,
            message: "Enter your provider's public https:// address, with no query string.",
          });
        }
        cloud.baseUrl = v.url;
      }
    }
    if ('model' in body) {
      if (body.model !== null && !isValidModelName(body.model)) return fail(res, 400, 'invalid_model', 'model must be a model name or null.');
      cloud.model = body.model;
    }
    if ('tokenParam' in body) {
      if (body.tokenParam !== null && !TOKEN_PARAMS.includes(body.tokenParam)) {
        return fail(res, 400, 'invalid_token_param', 'tokenParam must be "max_tokens", "max_completion_tokens" or null.');
      }
      cloud.tokenParam = body.tokenParam;
    }
    try {
      const patch = { cloud };
      // Any other endpoint (a different host, or the same host with another path) is not what the
      // user agreed to: the old consent no longer applies and cloud AI goes back to off (key,
      // model and address are kept).
      if ('baseUrl' in cloud) {
        const before = normalizedUrlOf((await getAiSettings()).cloud.baseUrl);
        if (before !== normalizedUrlOf(cloud.baseUrl)) {
          await clearCloudConsent();
          patch.provider = 'ollama';
        }
      }
      await updateAiSettings(patch);
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/ai/cloud-categories', async (req, res) => {
    const body = req.body;
    const given = isPlainObject(body) && isPlainObject(body.categories) ? body.categories : null;
    if (!given) return fail(res, 400, 'invalid_body', 'Body must be { categories: { <kind>: true | false } }.');
    for (const [id, value] of Object.entries(given)) {
      if (!CLOUD_CATEGORY_IDS.includes(id) || typeof value !== 'boolean') {
        return fail(res, 400, 'invalid_body', 'categories must use known kinds with true or false values.');
      }
    }
    try {
      const categories = await updateCloudCategories(given);
      await recordAudit({
        kind: 'llm',
        feature: 'cloud_ai_consent',
        provider: 'openai_compat',
        status: 'ok',
        meta: { action: 'categories', ...categorySplit(categories) },
      });
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.post('/api/settings/ai/cloud/enable', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || typeof body.version !== 'number' || typeof body.host !== 'string' || typeof body.baseUrl !== 'string' || !Array.isArray(body.acknowledgements)) {
      return fail(res, 400, 'invalid_body', 'Body must be { version, host, baseUrl, acknowledgements }.');
    }
    const acks = new Set(body.acknowledgements);
    if (!CLOUD_CONSENT_ACKS.every((a) => acks.has(a))) {
      return fail(res, 400, 'acknowledgements_required', 'Tick both boxes to turn on cloud AI.');
    }
    try {
      const { cloud } = await getAiSettings();
      const host = hostOf(cloud.baseUrl);
      if (!host || !cloud.model || !(await getSecret(CLOUD_KEY))) {
        return fail(res, 400, 'cloud_not_configured', 'Set the provider address, model and API key first.');
      }
      if (body.version !== CLOUD_CONSENT_VERSION) {
        return fail(res, 409, 'consent_outdated', 'The consent text changed. Reload and review it again.');
      }
      const savedUrl = normalizedUrlOf(cloud.baseUrl);
      if (body.host !== host || normalizedUrlOf(body.baseUrl) !== savedUrl) {
        return fail(res, 409, 'host_changed', 'The provider address changed. Reload and review it again.');
      }
      await setNetworkFeature('cloudAi', true);
      await recordCloudConsent({ host, baseUrl: savedUrl });
      await updateAiSettings({ provider: 'openai_compat' });
      await recordAudit({
        kind: 'llm',
        feature: 'cloud_ai_consent',
        provider: 'openai_compat',
        model: cloud.model,
        status: 'ok',
        meta: { action: 'enabled', ai_host: host, version: CLOUD_CONSENT_VERSION },
      });
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.post('/api/settings/ai/cloud/disable', async (req, res) => {
    try {
      await disableCloudAi();
      await respondStatus(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.post('/api/settings/ai/cloud-hint', async (req, res) => {
    const event = isPlainObject(req.body) ? req.body.event : undefined;
    if (event !== 'shown' && event !== 'dismissed') return fail(res, 400, 'invalid_body', 'event must be "shown" or "dismissed".');
    try {
      await recordCloudHint(event);
      res.json({ data: { cloudHint: { ...NO_CLOUD_HINT } } });
    } catch (err) {
      sendStorageError(res, err);
    }
  });
}
