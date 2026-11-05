// Cloud AI data categories and the enforcement that keeps withheld ones off the wire.
//
// Local Ollama (and an aiLan Ollama) is trusted: every category works. A cloud provider only
// ever receives the categories the user ticked. The single choke point is
// enforceCloudScope(), called from createAiClient events() for every cloud call; page,
// tool, briefing and insight code filters earlier so the model also learns what it cannot see.
// "null" in a mapping means the data has no category and is always allowed; a name missing from
// a mapping is unknown and therefore not allowed under cloud.

export const CLOUD_CATEGORY_IDS = Object.freeze([
  'budget',
  'todos',
  'calendar',
  'habits',
  'health',
  'notes',
  'journal',
  'bookmarks',
  'countdowns',
  'focus',
  'folders',
]);

export const CLOUD_CATEGORY_DEFAULTS = Object.freeze({
  budget: true,
  todos: true,
  calendar: true,
  habits: true,
  health: false,
  notes: false,
  journal: false,
  bookmarks: true,
  countdowns: true,
  focus: true,
  folders: false,
});

/** Internal scope for Javi's saved memory: never sent to a cloud provider, never in the UI. */
export const MEMORY_SCOPE = 'memory';

/** Noun used in user-facing and model-facing copy, and whether it reads as plural. */
export const CATEGORY_NOUNS = Object.freeze({
  budget: Object.freeze({ noun: 'budget data', plural: false }),
  todos: Object.freeze({ noun: 'todos', plural: true }),
  calendar: Object.freeze({ noun: 'calendar', plural: false }),
  habits: Object.freeze({ noun: 'habits', plural: true }),
  health: Object.freeze({ noun: 'health data', plural: false }),
  notes: Object.freeze({ noun: 'notes', plural: true }),
  journal: Object.freeze({ noun: 'journal', plural: false }),
  bookmarks: Object.freeze({ noun: 'bookmarks', plural: true }),
  countdowns: Object.freeze({ noun: 'countdowns', plural: true }),
  focus: Object.freeze({ noun: 'focus sessions', plural: true }),
  folders: Object.freeze({ noun: 'folder files', plural: true }),
});

const freeze = (o) => Object.freeze({ ...o });

export const PAGE_CATEGORIES = freeze({
  home: 'mixed',
  budget: 'budget',
  'budget-planner': 'budget',
  subscriptions: 'budget',
  todos: 'todos',
  habits: 'habits',
  focus: 'focus',
  countdowns: 'countdowns',
  calendar: 'calendar',
  journal: 'journal',
  notes: 'notes',
  bookmarks: 'bookmarks',
  health: 'health',
  settings: null,
  'data-browser': 'mixed',
});

export const TOOL_CATEGORIES = freeze({
  list_todos: 'todos',
  add_todo: 'todos',
  complete_todo: 'todos',
  get_calendar: 'calendar',
  get_budget_summary: 'budget',
  get_weather: null,
  get_health: 'health',
  list_notes: 'notes',
  add_note: 'notes',
  list_journal: 'journal',
  add_journal_entry: 'journal',
  list_countdowns: 'countdowns',
  add_countdown: 'countdowns',
  list_habits_today: 'habits',
  get_habit_history: 'habits',
  log_habit_completion: 'habits',
  search_data: 'mixed',
});

/** search_data `kinds` argument values. */
export const SEARCH_KIND_CATEGORIES = freeze({
  todos: 'todos',
  notes: 'notes',
  journal: 'journal',
  bookmarks: 'bookmarks',
  countdowns: 'countdowns',
  transactions: 'budget',
});

/** `kind` of each search_data result item. */
export const SEARCH_ITEM_KIND_CATEGORIES = freeze({
  todo: 'todos',
  note: 'notes',
  journal: 'journal',
  bookmark: 'bookmarks',
  countdown: 'countdowns',
  transaction: 'budget',
});

export const HOME_ALERT_KIND_CATEGORIES = freeze({
  todo: 'todos',
  habit: 'habits',
  health: 'health',
  countdown: 'countdowns',
  budget: 'budget',
});

export const BRIEFING_KEY_CATEGORIES = freeze({
  today: null,
  events: 'calendar',
  openTodos: 'todos',
  overdueTodos: 'todos',
  overdueCount: 'todos',
  dueTodayTodos: 'todos',
  dueTodayCount: 'todos',
  habitsRemaining: 'habits',
  habitsRemainingCount: 'habits',
  soonCountdowns: 'countdowns',
  budget: 'budget',
  weather: null,
  health: 'health',
});

export const DATA_BROWSER_TABLE_CATEGORIES = freeze({
  transactions: 'budget',
  todos: 'todos',
  todo_columns: 'todos',
  habits: 'habits',
  habit_completions: 'habits',
  notes: 'notes',
  journal: 'journal',
  bookmarks: 'bookmarks',
  countdowns: 'countdowns',
  calendar_events: 'calendar',
  focus_sessions: 'focus',
  jarvis_conversations: null,
  jarvis_messages: null,
  jarvis_memory: null,
  app_state: null,
});

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const lookup = (table, key) => (typeof key === 'string' && has(table, key) ? table[key] : undefined);
const isCategoryId = (v) => typeof v === 'string' && CLOUD_CATEGORY_IDS.includes(v);
const inOrder = (ids) => CLOUD_CATEGORY_IDS.filter((id) => ids.has(id));

/** Fixed copy when cloud AI was turned off (or changed) while a call waited, so nothing was sent. */
export const MSG_CLOUD_DISABLED = 'Cloud AI was turned off, so nothing was sent. Try again to use the AI on this computer.';

/** The user chose not to share these with cloud AI, or enforcement dropped them; or cloud was turned off before sending ('cloud_disabled'). */
export class CloudScopeError extends Error {
  /**
   * @param {'cloud_scope_missing'|'cloud_scope_denied'|'cloud_disabled'} code
   * @param {string[]} [categories] Category ids that were refused (names only).
   */
  constructor(code, categories = []) {
    super(code);
    this.name = 'CloudScopeError';
    this.code = code;
    this.categories = inOrder(new Set(categories.filter(isCategoryId)));
  }
}

/**
 * Keep only known category ids with boolean values.
 * @param {unknown} raw
 * @returns {Partial<Record<string, boolean>>}
 */
export function sanitizeCloudCategories(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of CLOUD_CATEGORY_IDS) if (typeof raw[id] === 'boolean') out[id] = raw[id];
  return out;
}

/**
 * Every category with its effective boolean (missing keys use the defaults).
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
export function resolveCloudCategories(raw) {
  const given = sanitizeCloudCategories(raw);
  return Object.fromEntries(CLOUD_CATEGORY_IDS.map((id) => [id, id in given ? given[id] : CLOUD_CATEGORY_DEFAULTS[id]]));
}

/**
 * Deterministic copy for withheld categories, for example
 * "Your journal isn't shared with cloud AI. You can change that in Settings > AI."
 * @param {string[]} ids
 * @returns {string}
 */
export function withheldMessage(ids) {
  const known = inOrder(new Set((Array.isArray(ids) ? ids : []).filter(isCategoryId)));
  const tail = 'You can change that in Settings > AI.';
  if (known.length === 0) return `That isn't shared with cloud AI. ${tail}`;
  const nouns = known.map((id) => CATEGORY_NOUNS[id].noun);
  const list = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
  const single = known.length === 1 && !CATEGORY_NOUNS[known[0]].plural;
  return `Your ${list} ${single ? "isn't" : "aren't"} shared with cloud AI. ${tail}`;
}

/**
 * What a withheld tool returns instead of data.
 * @param {string | null | undefined} category
 * @returns {{ not_shared: true, category: string | null, message: string }}
 */
export function withheldToolResult(category) {
  if (!isCategoryId(category)) {
    return { not_shared: true, category: null, message: 'That data is not shared with cloud AI. Do not guess it.' };
  }
  const { noun, plural } = CATEGORY_NOUNS[category];
  return { not_shared: true, category, message: `The user's ${noun} ${plural ? 'are' : 'is'} not shared with cloud AI. Do not guess it.` };
}

/**
 * @typedef {object} AiPolicy
 * @property {boolean} isCloud
 * @property {ReadonlySet<string>} allowed Categories that may leave this machine (every category when local).
 * @property {(category: string | null | undefined) => boolean} allows
 * @property {(page: string) => { allowed: boolean, mode: 'single'|'mixed'|'public', categories: string[], withheld: string[] }} pageDecision
 * @property {(name: string, args?: object) => { allowed: boolean, args: object, categories: string[], withheld: string[] }} toolDecision
 */

/**
 * @param {{ isCloud: boolean, categories?: unknown }} opts `categories` is the saved (partial or
 *   resolved) category map; ignored when local.
 * @returns {AiPolicy}
 */
export function createAiPolicy({ isCloud, categories } = { isCloud: false }) {
  const cloud = isCloud === true;
  const resolved = resolveCloudCategories(categories);
  const allowed = Object.freeze(new Set(CLOUD_CATEGORY_IDS.filter((id) => !cloud || resolved[id])));

  const allows = (category) => {
    if (!cloud) return true;
    if (category === null || category === undefined) return true;
    if (category === MEMORY_SCOPE) return false;
    return allowed.has(category);
  };

  const pageDecision = (page) => {
    const mapped = lookup(PAGE_CATEGORIES, page);
    if (mapped === null) return { allowed: true, mode: 'public', categories: [], withheld: [] };
    if (mapped === 'mixed') return { allowed: true, mode: 'mixed', categories: [], withheld: [] };
    if (mapped === undefined) {
      return cloud ? { allowed: false, mode: 'single', categories: [], withheld: [] } : { allowed: true, mode: 'single', categories: [], withheld: [] };
    }
    const ok = allows(mapped);
    return { allowed: ok, mode: 'single', categories: [mapped], withheld: ok ? [] : [mapped] };
  };

  const toolDecision = (name, args = {}) => {
    const mapped = lookup(TOOL_CATEGORIES, name);
    const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (!cloud) return { allowed: true, args: base, categories: [], withheld: [] };
    if (mapped === undefined) return { allowed: false, args: base, categories: [], withheld: [] };
    if (mapped === null) return { allowed: true, args: base, categories: [], withheld: [] };
    if (mapped !== 'mixed') {
      const ok = allows(mapped);
      return { allowed: ok, args: base, categories: ok ? [mapped] : [], withheld: ok ? [] : [mapped] };
    }
    // search_data: narrow the kinds to the allowed ones.
    const requested = Array.isArray(base.kinds) && base.kinds.length ? base.kinds : Object.keys(SEARCH_KIND_CATEGORIES);
    const keep = [];
    const shared = new Set();
    const dropped = new Set();
    for (const kind of requested) {
      const cat = lookup(SEARCH_KIND_CATEGORIES, kind);
      if (cat === undefined) continue;
      if (allows(cat)) {
        if (!keep.includes(kind)) keep.push(kind);
        shared.add(cat);
      } else dropped.add(cat);
    }
    if (keep.length === 0) return { allowed: false, args: base, categories: [], withheld: inOrder(dropped) };
    return { allowed: true, args: { ...base, kinds: keep }, categories: inOrder(shared), withheld: inOrder(dropped) };
  };

  return Object.freeze({ isCloud: cloud, allowed, allows, pageDecision, toolDecision });
}

const HOME_NOTE = '{"page":"home","note":"Page details are not shared with cloud AI."}';

function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const lastUserOnly = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'user') return [list[i]];
  return [];
};

// Prior assistant messages in the client-supplied thread cannot be trusted under cloud: the
// reply may have been written by a local model from data this policy withholds. Only the user's
// own messages are kept. The prompt needs alternating roles, so they are joined into one message.
const userMessagesOnly = (messages) => {
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user' && typeof m.content === 'string');
  if (users.length === 0) return [];
  return [{ role: 'user', content: users.map((m) => m.content).join('\n\n') }];
};

// The top-level keys the page builders emit (src/utils/javiBuilders/home.js and dataBrowser.js).
// Anything else in a cloud request is dropped, so a field a builder gains later is never sent by
// default.
const HOME_KEYS = Object.freeze(['mode', 'widgets', 'briefing', 'briefingAt', 'alerts']);
const DATA_BROWSER_KEYS = Object.freeze(['tables', 'active', 'searching']);
const HOME_MODES = Object.freeze(['all', 'work', 'home']);
const MAX_WIDGETS = 20;
const MAX_WIDGET_LENGTH = 40;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(obj, k)).map((k) => [k, obj[k]]));

const notAllowedIds = (policy) => CLOUD_CATEGORY_IDS.filter((id) => !policy.allowed.has(id));

function filterHomeContext(context, policy) {
  const parsed = parseObject(context);
  if (!parsed) return { context: HOME_NOTE, categories: [], withheld: notAllowedIds(policy), trimmed: true };
  const briefingCats = new Set(Object.values(BRIEFING_KEY_CATEGORIES).filter((c) => typeof c === 'string'));
  const withheld = new Set();
  const shared = new Set();
  const out = pick(parsed, HOME_KEYS);
  if (!HOME_MODES.includes(out.mode)) delete out.mode;
  if (!Array.isArray(out.widgets) || out.widgets.length > MAX_WIDGETS || out.widgets.some((w) => typeof w !== 'string' || w.length > MAX_WIDGET_LENGTH)) delete out.widgets;
  const briefingAllowed = [...briefingCats].every((c) => policy.allows(c));
  const hadBriefing = (typeof parsed.briefing === 'string' && parsed.briefing !== '') || (typeof parsed.briefingAt === 'string' && parsed.briefingAt !== '');
  if (!briefingAllowed) {
    delete out.briefing;
    delete out.briefingAt;
    if (hadBriefing) for (const c of briefingCats) if (!policy.allows(c)) withheld.add(c);
  } else if (hadBriefing) {
    for (const c of briefingCats) shared.add(c);
  }
  if (Array.isArray(out.alerts)) {
    out.alerts = out.alerts.filter((a) => {
      const cat = lookup(HOME_ALERT_KIND_CATEGORIES, a?.kind);
      if (cat === undefined) return false;
      if (policy.allows(cat)) {
        shared.add(cat);
        return true;
      }
      withheld.add(cat);
      return false;
    }).map((a) => pick(a, ['kind', 'severity', 'text']));
  }
  const withheldList = inOrder(withheld);
  return { context: JSON.stringify(out), categories: inOrder(shared), withheld: withheldList, trimmed: withheldList.length > 0 };
}

function filterDataBrowserContext(context, policy) {
  const parsed = parseObject(context);
  if (!parsed) return { context: '{"page":"data-browser","note":"Page details are not shared with cloud AI."}', categories: [], withheld: notAllowedIds(policy), trimmed: true };
  const withheld = new Set();
  const shared = new Set();
  const tableAllowed = (id) => {
    const cat = lookup(DATA_BROWSER_TABLE_CATEGORIES, id);
    if (cat === undefined) return false;
    if (cat !== null && !policy.allows(cat)) {
      withheld.add(cat);
      return false;
    }
    if (cat !== null) shared.add(cat);
    return true;
  };
  const out = pick(parsed, DATA_BROWSER_KEYS);
  if (Array.isArray(out.tables)) {
    out.tables = out.tables.filter((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.id === 'string' && tableAllowed(t.id)).map((t) => pick(t, ['id', 'label', 'group', 'count', 'status']));
  }
  if (out.active && typeof out.active === 'object' && !Array.isArray(out.active)) {
    if (typeof out.active.id !== 'string' || !tableAllowed(out.active.id)) delete out.active;
    else out.active = pick(out.active, ['id', 'view', 'page', 'pageSize', 'total', 'columns']);
  } else delete out.active;
  if (!Array.isArray(out.tables)) delete out.tables;
  const withheldList = inOrder(withheld);
  return { context: JSON.stringify(out), categories: inOrder(shared), withheld: withheldList, trimmed: withheldList.length > 0 };
}

/**
 * Filter a Javi page advice request for the active policy. Local: unchanged.
 * @param {{ page: string, context: string, messages: Array<{ role: string, content: string }> }} input
 * @param {AiPolicy} policy
 * @returns {{ allowed: boolean, context: string, messages: Array<{ role: string, content: string }>, categories: string[], withheld: string[] }}
 */
export function applyPagePolicy({ page, context, messages }, policy) {
  if (!policy.isCloud) return { allowed: true, context, messages, categories: [], withheld: [] };
  const decision = policy.pageDecision(page);
  if (!decision.allowed) return { allowed: false, context: '', messages: [], categories: [], withheld: decision.withheld };
  if (decision.mode !== 'mixed') {
    return { allowed: true, context, messages: userMessagesOnly(messages), categories: decision.categories, withheld: [] };
  }
  const filtered = page === 'home' ? filterHomeContext(context, policy) : filterDataBrowserContext(context, policy);
  return {
    allowed: true,
    context: filtered.context,
    // A mixed page spans categories and earlier replies may quote any of them: send only the question.
    messages: lastUserOnly(messages),
    categories: filtered.categories,
    withheld: filtered.withheld,
  };
}

// An empty value (no rows, a zero count, nothing connected) holds nothing to withhold, so it
// is dropped quietly instead of producing a "not shared" notice.
const hasData = (value) => {
  if (value === null || value === undefined || value === '' || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

/**
 * Drop the briefing snapshot keys a cloud policy withholds. Unknown keys are dropped under
 * cloud. Local: unchanged.
 * @param {Record<string, unknown>} snapshot
 * @param {AiPolicy} policy
 * @returns {{ snapshot: Record<string, unknown>, shared: string[], withheld: string[] }}
 */
export function filterBriefingSnapshot(snapshot, policy) {
  if (!policy.isCloud) return { snapshot, shared: [], withheld: [] };
  const out = {};
  const shared = new Set();
  const withheld = new Set();
  for (const [key, value] of Object.entries(snapshot || {})) {
    const cat = lookup(BRIEFING_KEY_CATEGORIES, key);
    if (cat === undefined) continue;
    if (cat === null) out[key] = value;
    else if (policy.allows(cat)) {
      out[key] = value;
      shared.add(cat);
    } else if (hasData(value)) withheld.add(cat);
  }
  return { snapshot: out, shared: inOrder(shared), withheld: inOrder(withheld) };
}

const PLACEHOLDER_ANY = JSON.stringify(withheldToolResult(null));

function toolCallsOf(message) {
  return Array.isArray(message?.tool_calls) ? message.tool_calls : [];
}

const callName = (call) => (typeof call?.function?.name === 'string' ? call.function.name : '');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The category a tool maps to, or undefined when unknown. */
const toolCategory = (name) => lookup(TOOL_CATEGORIES, name);

// Does one persisted tool call touch a category the policy refuses (or an unknown tool)? For
// search_data an empty or missing `kinds` means everything was searched, so it is withheld when
// any search kind is refused; unparseable arguments are treated as withheld.
function callWithheld(call, policy) {
  const cat = toolCategory(callName(call));
  if (cat === undefined) return true;
  if (cat === null) return false;
  if (cat !== 'mixed') return !policy.allows(cat);
  const raw = call?.function?.arguments;
  let args = raw;
  if (typeof raw === 'string') args = raw.trim() === '' ? {} : parseJson(raw);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return true;
  const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds : Object.keys(SEARCH_KIND_CATEGORIES);
  return kinds.some((kind) => {
    const kcat = lookup(SEARCH_KIND_CATEGORIES, kind);
    return kcat === undefined || !policy.allows(kcat);
  });
}

// The persisted tool_calls of an assistant row as a list, or undefined when it cannot be trusted
// (fail closed): jsonb decoding can yield null (bad JSON), a string (double encoding) or an object.
// null/undefined means "no calls"; a string gets one JSON.parse; anything left that is not an
// array, or not null, is untrusted.
function persistedCalls(raw) {
  let value = raw;
  if (typeof value === 'string') value = parseJson(value);
  if (value === null) return [];
  if (value === undefined) return typeof raw === 'string' ? undefined : [];
  return Array.isArray(value) ? value : undefined;
}

// Does one turn (user rows plus the rows after them) taint cloud history? True when any assistant
// row has untrusted or withheld tool calls, or a tool row answers a call this turn never declared
// (the interleaving or cut-off case: its origin cannot be proven clean).
function turnTainted(rows, policy) {
  const declared = new Set();
  let tainted = false;
  for (const row of rows) {
    if (row?.role !== 'assistant') continue;
    const calls = persistedCalls(row.toolCalls);
    if (calls === undefined) {
      tainted = true;
      continue;
    }
    for (const c of calls) {
      if (typeof c?.id === 'string') declared.add(c.id);
      if (callWithheld(c, policy)) tainted = true;
    }
  }
  if (tainted) return true;
  return rows.some((r) => r?.role === 'tool' && !(typeof r.toolCallId === 'string' && declared.has(r.toolCallId)));
}

/**
 * Cloud history for Jarvis: the earlier USER prompts only, minus every turn that used a withheld
 * tool and every later turn. The prompt of a withheld turn ("add to my journal: ...") is itself
 * withheld data, so detection runs on the full persisted rows, before assistant and tool rows
 * are dropped. Rows before the first user row (a cut-off turn) are dropped. A user row directly
 * followed by another user row (concurrent runs interleaving) is unresolved: it shares the fate
 * of the turn that follows. Untrusted tool_calls values and tool rows without a declaring
 * assistant call in the same turn taint the turn.
 * @param {Array<object>} rows Persisted rows (`role`, `content`, `toolCalls`, `toolCallId`).
 * @param {AiPolicy} policy
 * @returns {Array<object>} The user rows to send.
 */
export function cloudHistoryUserRows(rows, policy) {
  const list = Array.isArray(rows) ? rows : [];
  const firstUser = list.findIndex((r) => r?.role === 'user');
  if (firstUser === -1) return [];
  const turns = [];
  let turn = null;
  for (const row of list.slice(firstUser)) {
    if (row?.role === 'user') {
      if (turn && turn.rest.length === 0) turn.users.push(row);
      else {
        turn = { users: [row], rest: [] };
        turns.push(turn);
      }
    } else turn.rest.push(row);
  }
  const out = [];
  let tainted = false;
  for (const t of turns) {
    if (!tainted && turnTainted(t.rest, policy)) tainted = true;
    if (tainted) break;
    out.push(...t.users);
  }
  return out;
}

/**
 * The enforcement choke point for cloud calls (local: input returned unchanged).
 * Throws CloudScopeError before anything is sent when the scope is missing or names a
 * withheld category; otherwise returns messages with withheld tool data removed.
 * @param {{ messages: object[], tools?: object[], scope?: { categories?: string[], withheld?: string[] }, policy: AiPolicy }} input
 * @returns {{ messages: object[], tools: object[] | undefined, shared: string[], withheld: string[] }}
 */
export function enforceCloudScope({ messages, tools, scope, policy }) {
  if (!policy.isCloud) return { messages, tools, shared: [], withheld: [] };
  if (!scope || typeof scope !== 'object' || !Array.isArray(scope.categories) || scope.categories.some((c) => typeof c !== 'string')) {
    throw new CloudScopeError('cloud_scope_missing');
  }
  const denied = scope.categories.filter((c) => !isCategoryId(c) || !policy.allows(c));
  if (denied.length) throw new CloudScopeError('cloud_scope_denied', denied);

  const list = Array.isArray(messages) ? messages : [];
  const shared = new Set(scope.categories);
  const withheld = new Set((Array.isArray(scope.withheld) ? scope.withheld : []).filter(isCategoryId));

  const names = new Map();
  for (const m of list) for (const call of toolCallsOf(m)) if (typeof call?.id === 'string') names.set(call.id, callName(call));

  const lastUser = list.map((m) => m?.role).lastIndexOf('user');
  // Earlier turns: a turn that used a withheld tool is dropped whole, and so is every later
  // earlier turn (it may have been answered from the withheld data).
  const keep = new Array(list.length).fill(true);
  let tainted = false;
  let turnStart = -1;
  const flushTurn = (end) => {
    if (turnStart === -1) return;
    if (!tainted) {
      for (let i = turnStart; i < end; i += 1) {
        for (const call of toolCallsOf(list[i])) {
          const cat = toolCategory(callName(call));
          if (cat === undefined || (typeof cat === 'string' && cat !== 'mixed' && !policy.allows(cat))) {
            tainted = true;
            if (typeof cat === 'string') withheld.add(cat);
          }
        }
      }
    }
    if (tainted) for (let i = turnStart; i < end; i += 1) keep[i] = false;
    turnStart = -1;
  };
  for (let i = 0; i < Math.max(lastUser, 0); i += 1) {
    if (list[i]?.role === 'system') continue;
    if (list[i]?.role === 'user') {
      flushTurn(i);
      turnStart = i;
    } else if (turnStart === -1) turnStart = i;
  }
  flushTurn(Math.max(lastUser, 0));

  const out = [];
  list.forEach((m, i) => {
    if (!keep[i]) return;
    if (m?.role === 'tool') {
      const name = names.get(m.tool_call_id);
      const cat = name === undefined ? undefined : toolCategory(name);
      if (cat === undefined) {
        out.push({ ...m, content: PLACEHOLDER_ANY });
        return;
      }
      if (cat === null) {
        out.push(m);
        return;
      }
      if (cat === 'mixed') {
        const filtered = filterSearchResult(m.content, policy, shared, withheld);
        out.push({ ...m, content: filtered });
        return;
      }
      if (policy.allows(cat)) {
        shared.add(cat);
        out.push(m);
      } else {
        withheld.add(cat);
        out.push({ ...m, content: JSON.stringify(withheldToolResult(cat)) });
      }
      return;
    }
    if (m?.role === 'assistant' && toolCallsOf(m).length) {
      const calls = toolCallsOf(m).map((call) => {
        const cat = toolCategory(callName(call));
        if (cat === null) return call;
        if (cat === 'mixed') return call; // arguments are the model's own search words
        if (typeof cat === 'string' && policy.allows(cat)) return call;
        return { ...call, function: { ...call.function, arguments: '{}' } };
      });
      out.push({ ...m, tool_calls: calls });
      return;
    }
    out.push(m);
  });
  return { messages: out, tools, shared: inOrder(shared), withheld: inOrder(withheld) };
}

function filterSearchResult(content, policy, shared, withheld) {
  const parsed = parseJson(typeof content === 'string' ? content : '');
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return PLACEHOLDER_ANY;
  const results = [];
  for (const item of parsed.results) {
    const cat = lookup(SEARCH_ITEM_KIND_CATEGORIES, item?.kind);
    if (cat === undefined) continue;
    if (policy.allows(cat)) {
      shared.add(cat);
      results.push(item);
    } else withheld.add(cat);
  }
  return JSON.stringify({ ...parsed, results });
}

/**
 * Audit meta for a model call: names only, never content. Local and LAN clients record the
 * kind alone; cloud clients also record the host and the shared and withheld category names.
 * @param {{ ai?: { kind?: string, host?: string | null }, dataReport?: () => { shared: string[], withheld: string[] } } | null | undefined} client
 * @returns {{ ai_kind: string, ai_host?: string, shared?: string[], withheld?: string[] }}
 */
export function aiAuditMeta(client) {
  const kind = client?.ai?.kind;
  if (kind !== 'cloud') return { ai_kind: kind === 'lan' ? 'lan' : 'local' };
  const report = typeof client.dataReport === 'function' ? client.dataReport() : { shared: [], withheld: [] };
  return {
    ai_kind: 'cloud',
    ai_host: typeof client.ai.host === 'string' ? client.ai.host : '',
    shared: report.shared,
    withheld: report.withheld,
  };
}
