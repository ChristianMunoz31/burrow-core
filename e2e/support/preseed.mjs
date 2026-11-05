// Test-only: writes state into a sandbox data dir before the e2e server starts, for states the UI cannot reach
// in a fresh install. Run by burrowServer.js (option `preseed`) with the scrubbed child env, after the demo seed.
//   trialEnded:    the data folder's one trial started 60 days ago, so it is over and the app is Free.
//   briefingToday: a synthetic briefing written a minute ago, plus a Javi inbox baseline from yesterday, so the
//                  server would list the briefing as new for Pro (an upgrade baseline never surfaces older ones).
// Writes go straight to the database, never through the state route (`javi.inbox` is route owned).
import { assertUnderTmp } from '../../scripts/lib/sandboxSafety.js';

const DAY_MS = 86_400_000;
const dataDir = assertUnderTmp(process.env.BURROW_DATA_DIR);
const opts = JSON.parse(process.argv[2] ?? '{}');

const db = await import('../../server/db/index.js');
const { upsert } = await import('../../server/db/query.js');
const { createTrialStore } = await import('../../server/license/trialStore.js');

try {
  const now = Date.now();
  if (opts.trialEnded) {
    const startedAt = Math.floor((now - 60 * DAY_MS) / 1000) * 1000;
    if (!createTrialStore({ dataDir }).start(startedAt)) throw new Error('Could not write the ended trial record.');
  }
  if (opts.briefingToday) {
    const at = new Date(now - 60_000).toISOString();
    const briefing = { generatedAt: at, digest: 'A synthetic test briefing for the e2e run.', alerts: [], ai: null, withheld: [] };
    const inbox = { v: 1, createdAt: new Date(now - DAY_MS).toISOString(), pages: {}, briefingSeenAt: null, foldersSeenAt: null };
    for (const [key, value] of [['jarvis.briefing.latest', briefing], ['javi.inbox', inbox]]) {
      upsert('app_state', { key, value, updated_at: at }, { conflict: ['key'] });
    }
  }
} finally {
  db.closeDb();
}
