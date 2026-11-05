// AI settings persisted in app_state under `ai.settings`, plus endpoint URL validation.
// Shape: { provider, ollamaHost, chatModel, toolModel, cloud: { baseUrl, model, tokenParam } }.
// A stored value wins over env; env wins over the built-in default.
import { getState, setState } from '../dataAccess.js';
import { isLoopbackHost } from '../config.js';
import { isBlockedHostname, isPublicIp } from './cloudGuard.js';
import net from 'node:net';

export const AI_SETTINGS_KEY = 'ai.settings';
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_PORT = '11434';
export const MAX_URL_CHARS = 200;
export const MAX_MODEL_CHARS = 200;
export const TOKEN_PARAMS = Object.freeze(['max_tokens', 'max_completion_tokens']);
export const PROVIDERS = Object.freeze(['ollama', 'openai_compat']);

// Ollama model names: name[:tag], optionally namespaced (library/user/host paths).
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** @returns {{ provider: 'ollama', ollamaHost: null, chatModel: null, toolModel: null, cloud: { baseUrl: null, model: null, tokenParam: null } }} */
export const defaultAiSettings = () => ({
  provider: 'ollama',
  ollamaHost: null,
  chatModel: null,
  toolModel: null,
  cloud: { baseUrl: null, model: null, tokenParam: null },
});

/**
 * Whether a string is an acceptable model name (no path tricks, bounded length).
 * @param {unknown} name
 * @returns {boolean}
 */
export const isValidModelName = (name) =>
  typeof name === 'string' && name.length <= MAX_MODEL_CHARS && MODEL_NAME_RE.test(name) && !name.includes('..');

const stripBrackets = (h) => String(h || '').replace(/^\[/, '').replace(/\]$/, '');

/**
 * Validate an endpoint base URL (Ollama host or cloud base URL).
 * Rules: <= 200 chars, parses, http/https only, no credentials, no query or hash, no
 * wildcard bind address. For the Ollama host (`allowPath` false) the path must be '/'
 * and the stored value is the origin. Loopback is decided on the bracket-stripped hostname;
 * a hostname that merely resolves to loopback still counts as non-loopback.
 * @param {unknown} raw
 * @param {{ allowPath?: boolean, requireHttpsForRemote?: boolean }} [opts]
 * @returns {{ ok: true, url: string, origin: string, hostname: string, loopback: boolean } | { ok: false, reason: string }}
 */
export function validateEndpointUrl(raw, { allowPath = false, requireHttpsForRemote = false } = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  const text = raw.trim();
  if (!text || text.length > MAX_URL_CHARS) return { ok: false, reason: 'length' };
  // The URL parser silently drops an empty "?" or "#", so check the raw text too.
  if (/[?#\s]/.test(text)) return { ok: false, reason: 'query_or_hash' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'protocol' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.search || url.hash) return { ok: false, reason: 'query_or_hash' };
  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (!hostname || hostname === '0.0.0.0' || hostname === '::') return { ok: false, reason: 'wildcard' };
  let pathname = url.pathname;
  if (!allowPath && pathname !== '/') return { ok: false, reason: 'path' };
  if (allowPath) {
    pathname = pathname.replace(/\/+$/, '');
    if (pathname.includes('..') || /%2e/i.test(pathname)) return { ok: false, reason: 'path' };
  }
  const loopback = isLoopbackHost(hostname);
  if (requireHttpsForRemote && !loopback && url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
  const origin = url.origin;
  return { ok: true, url: allowPath ? `${origin}${pathname}` : origin, origin, hostname, loopback };
}

/**
 * Validate the cloud AI base URL. Stricter than the Ollama host: https only, no credentials,
 * query or hash, and the host must be a public name or a public IP (never this computer, a
 * private network or a local-looking name; connect-time DNS is checked again by cloudGuard).
 * `reason` is one of not_a_string, length, query_or_hash, unparseable, protocol, credentials,
 * path, https_required, private_address, local_name.
 * @param {unknown} raw
 * @returns {{ ok: true, url: string, origin: string, hostname: string } | { ok: false, reason: string }}
 */
export function validateCloudBaseUrl(raw) {
  const v = validateEndpointUrl(raw, { allowPath: true });
  if (!v.ok) return { ok: false, reason: v.reason === 'wildcard' ? 'private_address' : v.reason };
  if (net.isIP(v.hostname)) {
    if (!isPublicIp(v.hostname)) return { ok: false, reason: 'private_address' };
  } else if (isBlockedHostname(v.hostname)) {
    return { ok: false, reason: 'local_name' };
  }
  if (!v.url.startsWith('https://')) return { ok: false, reason: 'https_required' };
  return { ok: true, url: v.url, origin: v.origin, hostname: v.hostname };
}

/**
 * Normalize an OLLAMA_HOST-style value: no scheme means http:// with port 11434, and a
 * wildcard bind address (0.0.0.0 or ::) means this machine (127.0.0.1).
 * @param {unknown} raw
 * @returns {string | null} An origin, or null when the value is unusable.
 */
export function normalizeOllamaHost(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let text = raw.trim().replace(/\/+$/, '');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hasScheme) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = stripBrackets(url.hostname);
  if (host === '0.0.0.0' || host === '::' || host === '') url.hostname = '127.0.0.1';
  if (!hasScheme && !url.port) url.port = DEFAULT_OLLAMA_PORT;
  const v = validateEndpointUrl(url.origin);
  return v.ok ? v.origin : null;
}

const sanitizeCloud = (raw) => {
  const out = { baseUrl: null, model: null, tokenParam: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.baseUrl === 'string') {
    const v = validateCloudBaseUrl(raw.baseUrl);
    if (v.ok) out.baseUrl = v.url;
  }
  if (isValidModelName(raw.model)) out.model = raw.model;
  if (TOKEN_PARAMS.includes(raw.tokenParam)) out.tokenParam = raw.tokenParam;
  return out;
};

/**
 * Drop anything malformed from a stored settings object.
 * @param {unknown} raw
 * @returns {ReturnType<typeof defaultAiSettings>}
 */
export function sanitizeAiSettings(raw) {
  const out = defaultAiSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (PROVIDERS.includes(raw.provider)) out.provider = raw.provider;
  if (typeof raw.ollamaHost === 'string') {
    const v = validateEndpointUrl(raw.ollamaHost);
    if (v.ok) out.ollamaHost = v.origin;
  }
  if (isValidModelName(raw.chatModel)) out.chatModel = raw.chatModel;
  if (isValidModelName(raw.toolModel)) out.toolModel = raw.toolModel;
  out.cloud = sanitizeCloud(raw.cloud);
  return out;
}

/**
 * Saved settings, sanitized. Storage failures resolve to the defaults (never throws).
 * @returns {Promise<ReturnType<typeof defaultAiSettings>>}
 */
export async function getAiSettings() {
  try {
    return sanitizeAiSettings(await getState(AI_SETTINGS_KEY, null));
  } catch {
    return defaultAiSettings();
  }
}

/**
 * Merge a patch into the saved settings. Throws when storage is unavailable.
 * The patch must already be validated by the caller.
 * @param {Partial<ReturnType<typeof defaultAiSettings>>} patch
 * @returns {Promise<ReturnType<typeof defaultAiSettings>>}
 */
export async function updateAiSettings(patch) {
  const current = sanitizeAiSettings(await getState(AI_SETTINGS_KEY, null));
  const next = sanitizeAiSettings({
    ...current,
    ...patch,
    cloud: { ...current.cloud, ...(patch?.cloud || {}) },
  });
  await setState(AI_SETTINGS_KEY, next);
  return next;
}

/**
 * The Ollama host to use and where it came from: saved setting > OLLAMA_HOST env > default.
 * Loopback is recomputed on every call.
 * @param {ReturnType<typeof defaultAiSettings>} settings
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ host: string, hostSource: 'settings'|'env'|'default', loopback: boolean }}
 */
export function resolveOllamaHost(settings, env = process.env) {
  let host = DEFAULT_OLLAMA_HOST;
  let hostSource = 'default';
  if (settings?.ollamaHost) {
    host = settings.ollamaHost;
    hostSource = 'settings';
  } else if (env.OLLAMA_HOST && env.OLLAMA_HOST.trim()) {
    const fromEnv = normalizeOllamaHost(env.OLLAMA_HOST);
    if (fromEnv) {
      host = fromEnv;
      hostSource = 'env';
    }
  }
  const v = validateEndpointUrl(host);
  return { host, hostSource, loopback: v.ok ? v.loopback : false };
}

/**
 * Token-limit field for an OpenAI-compatible endpoint: the saved choice, else
 * max_completion_tokens for api.openai.com, else max_tokens.
 * @param {string | null} baseUrl
 * @param {string | null} tokenParam
 * @returns {'max_tokens'|'max_completion_tokens'}
 */
export function resolveTokenParam(baseUrl, tokenParam) {
  if (TOKEN_PARAMS.includes(tokenParam)) return tokenParam;
  try {
    if (baseUrl && new URL(baseUrl).hostname === 'api.openai.com') return 'max_completion_tokens';
  } catch {
    /* fall through */
  }
  return 'max_tokens';
}
