// Child process for crashSafety.test.js: commits one row per transaction forever and prints
// `committed N` after each commit, until the parent kills it.
import { openDb, withTransaction } from '../../db/index.js';

const db = openDb();
db.exec('CREATE TABLE IF NOT EXISTS crash_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');

let committed = 0;
const step = () => {
  withTransaction((tx) => {
    tx.prepare('INSERT INTO crash_probe (payload) VALUES (?)').run('p'.repeat(200));
  }, db);
  committed += 1;
  process.stdout.write(`committed ${committed}\n`);
  setImmediate(step);
};
step();
