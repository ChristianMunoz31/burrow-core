// Seam for the optional Burrow Pro module (docs/adr/0001-open-core-split.md 3.2-3.7). Pro lives outside the core, in
// a top-level folder that only server/proExtensionsLoader.js names. Core knows only this contract: a module
// `{ name, apiVersion, available(env), install(ctx) }` that registers everything through `ctx`, synchronously.
// Every registration passes core in public code: module routes are mounted here with the route table's pre layers
// (and requireAi when the table says so); scheduled jobs, folder hooks and character texts are checked by their core
// hosts. There is no tier gate (ADR 0002). Without a module every module route answers 501 pro_not_included.
import express from 'express';
import { requireAi } from './ai/index.js';
import { onDataReset } from './dataGeneration.js';
import { setFolderProHooks, resetFolderProHooksForTests } from './folders/jobs.js';
import { registerCharacterTexts, resetCharacterTextsForTests } from './javi/characters.js';
import { proCompiledIn } from './license/channelSeam.js';
import { sendProNotIncluded } from './pro.js';
import { importProExtension } from './proExtensionsLoader.js';
import { PRO_ROUTES, PRO_SLOTS } from './proRoutes.js';
import { registerProScheduledJob, resetProScheduledJobsForTests } from './scheduler.js';

export const PRO_API_VERSION = 1;

const SCHEDULER_JOBS = new Set(['briefing', 'folderRescan']);
const PRE_NAMES = new Set(['aiLimiter', 'requireJson']);

/** Error code for the local log only: never a message or path. */
const errCode = (err) => (typeof err?.code === 'string' ? err.code : 'error');

// ---------------------------------------------------------------------------------------------
// Slots: one outer router per slot (mounted by core at today's positions), holding the Pro router first and the
// fallback router second. The fallback is filled at module load, so an app imported by Vitest has Free behaviour.
// ---------------------------------------------------------------------------------------------

/** @type {Record<string, { outer: import('express').Router, pro: import('express').Router }>} */
const slots = {};
for (const slot of PRO_SLOTS) {
  const outer = express.Router();
  const pro = express.Router();
  const fallback = express.Router();
  for (const route of Object.values(PRO_ROUTES)) {
    if (route.slot !== slot) continue;
    fallback[route.method](route.path, sendProNotIncluded(route.feature));
  }
  outer.use(pro);
  outer.use(fallback);
  slots[slot] = { outer, pro };
}

/**
 * The router core mounts for one slot (a singleton per slot).
 * @param {'jarvis' | 'insights' | 'folders'} slot
 * @returns {import('express').Router}
 */
export function proSlotRouter(slot) {
  if (!Object.hasOwn(slots, slot)) throw new Error(`Unknown Pro slot: ${String(slot)}`);
  return slots[slot].outer;
}

// ---------------------------------------------------------------------------------------------
// Folder route helpers: registerFolderRoutes hands over its private helpers; the latest call wins (tests build
// several apps). Pro handlers and the `pre` layers read them per request through a delegating facade.
// ---------------------------------------------------------------------------------------------

/** @type {null | { handle: Function, send: Function, folderOr404: Function, aiLimiter: Function, requireJson: Function, isPlainBody: Function }} */
let folderHelpers = null;

/**
 * Called by registerFolderRoutes with its helpers.
 * @param {{ handle: Function, send: Function, folderOr404: Function, aiLimiter: Function, requireJson: Function, isPlainBody: Function }} helpers
 */
export function setFolderRouteHelpers(helpers) {
  folderHelpers = helpers;
}

const currentHelpers = () => {
  if (!folderHelpers) throw new Error('folder route helpers are not set');
  return folderHelpers;
};

const folderRouteFacade = Object.freeze({
  handle: (fn) => (req, res, next) => currentHelpers().handle(fn)(req, res, next),
  send: (res, code) => currentHelpers().send(res, code),
  folderOr404: (req, res) => currentHelpers().folderOr404(req, res),
  isPlainBody: (body) => currentHelpers().isPlainBody(body),
});

/** @param {string} name */
const preLayer = (name) => (req, res, next) => currentHelpers()[name](req, res, next);

// ---------------------------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------------------------

let active = false;
let loading = null;
/** @type {Set<string>} */
const addedRoutes = new Set();
/** @type {Array<() => void>} unregister functions of the data-reset callbacks of the current install */
let resetUnhooks = [];

/** Undo every registration: pro routers, scheduler jobs, folder hooks, character texts, data-reset callbacks. */
function rollback() {
  for (const slot of Object.values(slots)) slot.pro.stack.length = 0;
  addedRoutes.clear();
  resetProScheduledJobsForTests();
  resetFolderProHooksForTests();
  resetCharacterTextsForTests();
  for (const off of resetUnhooks) off();
  resetUnhooks = [];
}

function makeCtx(env, log) {
  const state = { open: true };
  const guard = (fn) => (...args) => {
    if (!state.open) throw new Error('pro registration closed');
    return fn(...args);
  };
  const ctx = Object.freeze({
    apiVersion: PRO_API_VERSION,
    env,
    log,
    routes: Object.freeze({
      add: guard(({ id, validate = [], handlers } = {}) => {
        if (!Object.hasOwn(PRO_ROUTES, id)) throw new Error(`Unknown Pro route id: ${String(id)}`);
        if (addedRoutes.has(id)) throw new Error(`Pro route already added: ${id}`);
        if (!Array.isArray(validate) || validate.some((fn) => typeof fn !== 'function')) throw new Error(`Invalid validators for ${id}`);
        if (!Array.isArray(handlers) || handlers.length === 0 || handlers.some((fn) => typeof fn !== 'function')) {
          throw new Error(`Invalid handlers for ${id}`);
        }
        const route = PRO_ROUTES[id];
        const pre = route.pre.map((name) => {
          if (!PRE_NAMES.has(name)) throw new Error(`Unknown pre layer: ${name}`);
          return preLayer(name);
        });
        const ai = route.ai ? [requireAi(route.ai.purpose, route.ai.enabledOnly ? { enabledOnly: true } : undefined)] : [];
        slots[route.slot].pro[route.method](route.path, ...pre, ...validate, ...ai, ...handlers);
        addedRoutes.add(id);
      }),
    }),
    folders: Object.freeze({
      routeHelpers: guard(() => folderRouteFacade),
      setJobHooks: guard(({ index = null, report = null } = {}) => setFolderProHooks({ index, report })),
    }),
    scheduler: Object.freeze({
      register: guard((name, job) => {
        if (!SCHEDULER_JOBS.has(name)) throw new Error(`Unknown scheduled job: ${String(name)}`);
        registerProScheduledJob(name, job);
      }),
    }),
    javi: Object.freeze({
      registerCharacters: guard((texts) => registerCharacterTexts(texts)),
    }),
    onDataReset: guard((fn) => {
      if (typeof fn !== 'function') throw new Error('onDataReset needs a function');
      let enabled = true;
      const off = onDataReset(() => {
        if (enabled) fn();
      });
      resetUnhooks.push(() => {
        enabled = false;
        off();
      });
    }),
  });
  return { ctx, close: () => (state.open = false) };
}

async function load({ env, log, importer }) {
  if (!proCompiledIn()) return false;
  let ext;
  try {
    ext = await importer();
  } catch (err) {
    log(`pro extensions: failed to load (${errCode(err)})`);
    return false;
  }
  if (ext === null || ext === undefined) return false;
  if (
    typeof ext !== 'object' ||
    typeof ext.name !== 'string' ||
    ext.apiVersion !== PRO_API_VERSION ||
    typeof ext.available !== 'function' ||
    typeof ext.install !== 'function'
  ) {
    log('pro extensions: incompatible module');
    return false;
  }
  try {
    if (ext.available(env) !== true) return false;
  } catch (err) {
    log(`pro extensions: availability check failed (${errCode(err)})`);
    return false;
  }
  const { ctx, close } = makeCtx(env, log);
  try {
    const result = ext.install(ctx);
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      // A thenable is an install failure; swallow its eventual rejection so it never becomes unhandled.
      Promise.resolve(result).catch(() => {});
      throw Object.assign(new Error('install returned a thenable'), { code: 'async_install' });
    }
  } catch (err) {
    close();
    log(`pro extensions: install failed (${errCode(err)})`);
    rollback();
    return false;
  }
  close();
  active = true;
  return true;
}

/**
 * Loads and installs the Pro module when there is one and it is available. Idempotent.
 * @param {{ env?: Record<string, string | undefined>, log?: (m: string) => void, importer?: () => Promise<object | null> }} [opts]
 * @returns {Promise<boolean>} whether the module is installed
 */
export async function loadProExtensions({ env = process.env, log = console.warn, importer = importProExtension } = {}) {
  if (active) return true;
  loading ??= load({ env, log, importer }).finally(() => {
    loading = null;
  });
  return loading;
}

/** True only after a successful install. The default for /api/app/info `proModule`. */
export function proModuleActive() {
  return active;
}

/** Empties the Pro routers and every registry and forgets the install. For tests only. */
export function resetProExtensionsForTests() {
  rollback();
  active = false;
  loading = null;
}
