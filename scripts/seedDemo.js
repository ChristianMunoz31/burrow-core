// Generic, fictional demo data covering every Burrow module, so the Home page and each module
// page look populated. Deterministic (seeded PRNG, dates relative to `now`), no personal data.
//
// Every write/activity timestamp (created_at, updated_at, started_at, journal date, completions,
// transaction dates) is clamped to the seed clock (now), so the seed never writes the future. Only user-chosen
// scheduled dates (upcoming calendar events, todo due dates, countdown targets) may lie ahead.
//
// CLI: node scripts/seedDemo.js --data-dir <dir> [--app-dir <dir>] [--force] [--now <iso>]
// The data dir must be inside the OS temp dir (never the real data dir). When --app-dir is a
// different checkout, its modules are imported by a child process with a minimal env and a fake
// home under the data dir, never in this process.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSafeDataDir, assertUnderTmp, buildChildEnv, samePath, sandboxHomeFor } from './lib/sandboxSafety.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HISTORY_DAYS = 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Inserts the demo data set.
 * @param {{ insert: (table: string, row: object) => object, now?: Date }} deps
 *   `now` is injectable (tests); the default is the wall clock at the start of the run.
 * @returns {Promise<{ counts: Record<string, number> }>}
 */
export async function seedDemo({ insert, now = new Date() }) {
  const rand = mulberry32(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => round2(lo + rand() * (hi - lo));
  const counts = {};
  const add = (table, row) => {
    counts[table] = (counts[table] ?? 0) + 1;
    return insert(table, row);
  };

  const dayAt = (offset, hour = 12, minute = 0) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0);
  // Past activity: never later than now (minus spanMin when the activity has a duration).
  const latest = (spanMin = 0) => new Date(now.getTime() - spanMin * 60000);
  const clampDate = (d, spanMin = 0) => (d.getTime() > latest(spanMin).getTime() ? latest(spanMin) : d);
  const stamp = (offset, hour = 12, minute = 0, spanMin = 0) => clampDate(dayAt(offset, hour, minute), spanMin).toISOString();
  const pastDay = (offset) => ymd(clampDate(dayAt(offset)));
  // User-chosen scheduled dates (due dates, countdown targets, upcoming events): may be in the future.
  const isoDay = (offset) => ymd(dayAt(offset));
  const scheduledStamp = (offset, hour = 12, minute = 0) => dayAt(offset, hour, minute).toISOString();

  // ---------------- transactions ----------------
  const tx = (offset, merchant, amount, category, type = 'debit') =>
    add('transactions', {
      date: pastDay(offset),
      merchant,
      amount: type === 'credit' ? Math.abs(amount) : -Math.abs(amount),
      category,
      type,
      created_at: stamp(offset, 12),
    });

  const PAYDAY_OFFSET = -3;
  const paydays = [];
  for (let o = PAYDAY_OFFSET; o >= -HISTORY_DAYS; o -= 14) paydays.push(o);
  const anchorPayday = paydays[paydays.length - 1];

  const DINING = ['Corner Bistro', 'Taco Stand', 'Pizza Place', 'Noodle House', 'Sunrise Cafe'];
  const GROCERS = ['Green Basket Market', 'Corner Greens', 'Harvest Foods'];
  const SHOPS = ['Paper & Pine Books', 'Hearth Home Goods', 'Threadwork Apparel', 'Gadget Garage'];
  const SUBSCRIPTIONS = [
    { merchant: 'Streamflix', amount: 15.49, day: 5 },
    { merchant: 'Tunebox', amount: 10.99, day: 9 },
    { merchant: 'CloudLocker', amount: 2.99, day: 21 },
    { merchant: 'Fit Club', amount: 39, day: 3 },
  ];

  for (let o = -HISTORY_DAYS; o <= 0; o += 1) {
    const d = dayAt(o);
    const dom = d.getDate();
    const dow = d.getDay();
    if (paydays.includes(o)) tx(o, 'Northwind Payroll', 2150, 'Income', 'credit');
    if (dom === 1) tx(o, 'Maple Court Apartments', 1450, 'Housing');
    if (dom === 2) tx(o, 'Transfer to Savings', 300, 'Savings');
    if (dom === 12) tx(o, 'City Power & Water', between(68, 112), 'Utilities');
    if (dom === 15) tx(o, 'Fibernet Internet', 59.99, 'Utilities');
    for (const s of SUBSCRIPTIONS) if (dom === s.day) tx(o, s.merchant, s.amount, 'Subscriptions');
    if (dow === 6) tx(o, pick(GROCERS), between(58, 132), 'Groceries');
    if (dow === 3 && rand() < 0.5) tx(o, pick(GROCERS), between(14, 38), 'Groceries');
    if (rand() < 0.3) tx(o, pick(DINING), between(9, 48), 'Dining');
    if (dow >= 1 && dow <= 5 && rand() < 0.45) tx(o, 'Metro Transit', 2.75, 'Transport');
    if (rand() < 0.07) tx(o, 'Quickfill Fuel', between(34, 56), 'Transport');
    if (rand() < 0.05) tx(o, 'Willow Pharmacy', between(8, 32), 'Health');
    if (rand() < 0.06) tx(o, pick(SHOPS), between(15, 85), 'Shopping');
    if (rand() < 0.05) tx(o, 'Happy Tails Pet Supply', between(22, 58), 'Pets');
  }
  // An annual subscription: two charges one year apart, the latest about a month ago.
  tx(-400, 'Pixelvault Pro', 59, 'Subscriptions');
  tx(-35, 'Pixelvault Pro', 59, 'Subscriptions');

  // ---------------- budget plan (app_state) ----------------
  const month = isoDay(0).slice(0, 7);
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonth = `${nextMonthDate.getFullYear()}-${pad(nextMonthDate.getMonth() + 1)}`;
  const setState = (key, value) => add('app_state', { key, value, updated_at: stamp(0, 0) });
  setState('budget:defaults', {
    'cat-housing': 1450,
    'cat-utilities': 160,
    'cat-subscriptions': 70,
    'cat-groceries': 450,
    'cat-transport': 140,
    'cat-health': 50,
    'cat-dining': 220,
    'cat-shopping': 120,
    'cat-savings': 300,
    'cat-buffer': 100,
    'cat-pets': 60,
  });
  setState('budget:targets', {
    [`${month}|cat-dining`]: 250,
    [`${month}|cat-shopping`]: 150,
    [`${nextMonth}|cat-groceries`]: 480,
  });
  setState('budget:structure', {
    groups: { renamed: {}, hidden: [], order: {}, added: [] },
    categories: {
      renamed: {},
      hidden: [],
      order: {},
      moved: {},
      added: [{ id: 'cat-pets', name: 'Pets', groupId: 'grp-wants', sortOrder: 4096 }],
    },
  });
  setState('budget:payees', [
    {
      id: 'payee-northwind',
      name: 'Northwind Payroll',
      amount: 2150,
      every: 2,
      unit: 'week',
      anchorDate: isoDay(anchorPayday),
    },
  ]);
  setState('profile', { displayName: 'Demo', onboardedAt: stamp(-HISTORY_DAYS) });

  // ---------------- todos ----------------
  for (const [name, order, color] of [
    ['Backlog', 0, 'gray'],
    ['In Progress', 1, 'blue'],
    ['Done', 2, 'green'],
  ]) {
    add('todo_columns', { name, order, color, created_at: stamp(-HISTORY_DAYS, 8) });
  }
  const todos = [
    ['Renew library card', -3, 'high', 'Backlog'],
    ['Book dentist checkup', 5, 'medium', 'Backlog'],
    ['Plan weekend hike', 9, 'low', 'Backlog'],
    ['Organize photo albums', null, 'low', 'Backlog'],
    ['Draft monthly budget review', 0, 'high', 'In Progress'],
    ['Fix the leaky kitchen faucet', 2, 'medium', 'In Progress'],
    ['Sort the monthly receipts', -1, 'medium', 'In Progress'],
    ['Pay the electricity bill', -6, 'high', 'Done'],
    ['Back up the laptop', -2, 'medium', 'Done'],
    ['Renew car registration', -10, 'medium', 'Done'],
  ];
  for (const [title, due, priority, status] of todos) {
    add('todos', {
      title,
      done: status === 'Done',
      due: due === null ? null : isoDay(due),
      priority,
      status,
      context: 'both',
      created_at: stamp(-14, 9),
    });
  }

  // ---------------- habits ----------------
  const habitDefs = [
    { title: 'Morning walk', color: 'green', streak: 30 },
    { title: 'Read 20 pages', color: 'blue', streak: 12 },
    { title: 'Stretch for 10 minutes', color: 'orange', streak: 3 },
    { title: 'Meditate', color: 'purple', streak: 0 },
  ];
  for (const def of habitDefs) {
    const habit = add('habits', {
      title: def.title,
      frequency: 'daily',
      color: def.color,
      created_at: stamp(-45, 8),
    });
    // A zero streak: the newest completion is 3 days ago (today and yesterday are missed).
    const newest = def.streak > 0 ? 0 : -3;
    const run = def.streak > 0 ? def.streak : 4;
    for (let i = 0; i < run; i += 1) add('habit_completions', { habit_id: habit.id, date: pastDay(newest - i), created_at: stamp(newest - i, 20) });
    // Scattered older completions after a one-day gap (never extends the streak).
    for (let o = newest - run - 1; o >= -44; o -= 1) {
      if (rand() < 0.55) add('habit_completions', { habit_id: habit.id, date: pastDay(o), created_at: stamp(o, 20) });
    }
  }

  // ---------------- calendar ----------------
  const events = [
    ['Team standup', -6, 9, 0.25, 'Video call'],
    ['Dentist checkup', -3, 15, 1, 'Smile Dental, Main St'],
    ['Book club', -1, 19, 1.5, 'Library annex'],
    ['Team standup', 0, 9, 0.25, 'Video call'],
    ['Lunch with Sam', 1, 12, 1, 'Corner Bistro'],
    ['Yoga class', 2, 18, 1, 'Studio Lotus'],
    ['Car service', 4, 8, 2, 'Northside Auto'],
    ['Book club', 6, 19, 1.5, 'Library annex'],
    ['Farmers market', 8, 10, 2, 'Town square'],
    ['Quarterly planning', 11, 14, 1.5, 'Conference room B'],
  ];
  for (const [summary, offset, hour, hours, location] of events) {
    const start = dayAt(offset, hour);
    add('calendar_events', {
      summary,
      description: '',
      location,
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + hours * 3600 * 1000).toISOString(),
      all_day: false,
      source: 'manual',
      created_at: stamp(Math.min(offset, 0) - 7, 9),
    });
  }
  add('calendar_events', {
    summary: 'Public holiday',
    description: '',
    location: '',
    start_at: scheduledStamp(14, 0),
    end_at: scheduledStamp(15, 0),
    all_day: true,
    source: 'manual',
    created_at: stamp(-7, 9),
  });

  // ---------------- journal ----------------
  const journal = [
    [0, 'A calm start', 'Slow morning, good coffee, and a clear plan for the week.', 'good', ['morning']],
    [-1, 'Long walk', 'Walked by the river for an hour. Felt lighter afterwards.', 'great', ['outdoors']],
    [-3, 'Busy day', 'Back to back meetings. Tired but things moved forward.', 'okay', ['work']],
    [-4, 'Cooking night', 'Tried a new curry recipe. It turned out better than expected.', 'good', ['food']],
    [-6, 'Rough sleep', 'Woke up several times and dragged through the day.', 'down', ['health']],
    [-8, 'Weekend reset', 'Cleaned the apartment and caught up on reading.', 'good', ['weekend']],
    [-10, 'Missed the train', 'Everything ran late today. A bit frustrating.', 'rough', ['commute']],
    [-13, 'Coffee with a friend', 'Great conversation and a lot of laughing.', 'great', ['friends']],
    [-16, 'Quiet Sunday', 'Did very little and that was fine.', 'okay', ['weekend']],
    [-20, 'New project', 'Kicked off a small side project. Excited to see where it goes.', 'great', ['work']],
    [-24, 'Low energy', 'Skipped the gym and felt flat all afternoon.', 'down', ['health']],
    [-29, 'Moving forward', 'Made a list of goals for next month and it feels doable.', 'good', ['goals']],
  ];
  for (const [offset, title, body, mood, tags] of journal) {
    add('journal', { title, body, mood, tags, date: stamp(offset, 21), created_at: stamp(offset, 21) });
  }

  // ---------------- notes ----------------
  const notes = [
    ['Gift ideas: a novel, a warm scarf, and a plant for the office.', 'yellow', true],
    ['Garden plan: tomatoes, basil, and a small herb box by the window.', 'green', false],
    ['Recipe to try: lemon pasta with toasted breadcrumbs.', 'pink', false],
    ['Trip checklist: charger, passport, notebook, rain jacket.', 'blue', false],
    ['Book list: three novels and one history book for the summer.', 'purple', false],
    ['Questions for the landlord: parking spot, laundry hours, recycling.', 'yellow', false],
  ];
  notes.forEach(([body, color, pinned], i) => {
    add('notes', { body, color, pinned, created_at: stamp(-i * 2 - 1, 10) });
  });

  // ---------------- bookmarks ----------------
  const bookmarks = [
    ['Trail Guide', 'https://trails.example.org', 'Outdoors'],
    ['Weeknight Recipes', 'https://recipes.example.org', 'Food'],
    ['Budgeting Basics', 'https://money.example.org/basics', 'Money'],
    ['Local Library Catalog', 'https://library.example.org', 'Reading'],
    ['Morning Stretch Routine', 'https://fitness.example.org/stretch', 'Health'],
    ['Weather Radar', 'https://weather.example.org', 'Reference'],
    ['Keyboard Shortcuts Cheatsheet', 'https://docs.example.org/shortcuts', 'Reference'],
    ['Open Source Maps', 'https://maps.example.org', 'Outdoors'],
  ];
  bookmarks.forEach(([title, url, category], i) => {
    add('bookmarks', { title, url, category, created_at: stamp(-i * 3 - 1, 9) });
  });

  // ---------------- countdowns ----------------
  for (const [title, offset] of [
    ['Summer vacation', 40],
    ['Friend wedding', 18],
    ['Project launch', 75],
  ]) {
    add('countdowns', { title, target_date: isoDay(offset), context: 'both', created_at: stamp(-30, 9) });
  }

  // ---------------- focus sessions ----------------
  for (let i = 0; i < 20; i += 1) {
    const offset = -Math.floor(i * 0.7);
    const kind = i % 4 === 3 ? 'break' : 'focus';
    const duration = kind === 'break' ? 5 : pick([25, 25, 50]);
    // A session must have ended by now, so its start is clamped to now minus its duration.
    const startedAt = stamp(offset, 8 + Math.floor((i % 8) * 1.5), (i * 7) % 60, duration);
    add('focus_sessions', { kind, duration_min: duration, started_at: startedAt, created_at: startedAt });
  }

  return { counts };
}

// ---------------- CLI ----------------
// --now is a test seam (fixed clock for the demo data); the default is the real clock.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

function parseNow(value) {
  const text = value ?? '';
  const d = new Date(text);
  if (!ISO_DATE_TIME.test(text) || Number.isNaN(d.getTime())) {
    throw new Error('--now needs an ISO 8601 date-time such as 2026-06-15T09:00:00Z.');
  }
  if (d.getTime() > Date.now()) throw new Error('--now must not be in the future.');
  return d;
}

function parseArgs(argv) {
  const out = { dataDir: '', appDir: '', force: false, child: false, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') out.dataDir = argv[(i += 1)] ?? '';
    else if (argv[i] === '--app-dir') out.appDir = argv[(i += 1)] ?? '';
    else if (argv[i] === '--now') out.now = parseNow(argv[(i += 1)]);
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--child') out.child = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataDir) throw new Error('Usage: node scripts/seedDemo.js --data-dir <dir> [--app-dir <dir>] [--force] [--now <iso>]');
  // The child runs with a fake APPDATA, so the real-dir check is made once, by the parent.
  const dataDir = args.child ? path.resolve(assertUnderTmp(args.dataDir)) : assertSafeDataDir(args.dataDir);
  const appDir = path.resolve(args.appDir || REPO_ROOT);
  if (!args.child && !samePath(appDir, REPO_ROOT)) {
    const childArgs = [fileURLToPath(import.meta.url), '--data-dir', dataDir, '--app-dir', appDir, '--child'];
    if (args.force) childArgs.push('--force');
    if (args.now) childArgs.push('--now', args.now.toISOString());
    const env = buildChildEnv({
      homeDir: sandboxHomeFor(dataDir),
      extra: { BURROW_DATA_DIR: dataDir, BURROW_SCHEDULER: '0', BURROW_NO_DOTENV: '1' },
    });
    const res = spawnSync(process.execPath, childArgs, { cwd: REPO_ROOT, env, stdio: 'inherit', shell: false });
    if (res.status !== 0) throw new Error(`Seeding in the child process failed (exit ${res.status ?? 'signal'}).`);
    return;
  }
  process.env.BURROW_DATA_DIR = dataDir;
  process.env.BURROW_SCHEDULER = '0';
  process.env.BURROW_NO_DOTENV = '1';
  fs.mkdirSync(dataDir, { recursive: true });
  if (args.force) {
    for (const f of ['burrow.db', 'burrow.db-wal', 'burrow.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
  }
  const db = await import(pathToFileURL(path.join(appDir, 'server', 'db', 'index.js')).href);
  try {
    const existing = db.IMPORT_ORDER.filter((t) => db.count(t) > 0);
    if (existing.length > 0) {
      throw new Error(`Refusing to seed a database that already has data (${existing.join(', ')}). Use --force.`);
    }
    const { counts } = await seedDemo({ insert: db.insert, now: args.now ?? new Date() });
    console.log(`Seeded demo data into ${path.join(dataDir, 'burrow.db')}`);
    console.log(JSON.stringify(counts));
  } finally {
    db.closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
