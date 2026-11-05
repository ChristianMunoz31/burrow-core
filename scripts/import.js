// CLI importer: restores one or more Burrow export ZIPs (current or legacy v1 format) into the
// local database at BURROW_DATA_DIR (or the per-OS default).
//   node scripts/import.js [--dry-run] [--json] <zip> [<zip>...]
// Exit codes: 0 success, 1 failure, 2 usage error. Never starts the server or the scheduler.
import '../loadEnv.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const files = args.filter((a) => !a.startsWith('--'));
const known = new Set(['--dry-run', '--json']);

if (files.length === 0 || [...flags].some((f) => !known.has(f))) {
  console.error('Usage: node scripts/import.js [--dry-run] [--json] <export.zip> [<export.zip>...]');
  process.exit(2);
}

const dryRun = flags.has('--dry-run');
const asJson = flags.has('--json');

const { closeDb, getDb } = await import('../server/db/index.js');
const { importZipBuffer } = await import('../server/import/importExport.js');

let failed = false;
const results = [];
try {
  const db = getDb();
  for (const file of files) {
    try {
      const bytes = new Uint8Array(readFileSync(file));
      const result = importZipBuffer(bytes, { db, dryRun });
      results.push({ file, ...result });
      if (!asJson) {
        console.log(`${file} (${result.format} v${result.formatVersion})${dryRun ? ' [dry run, nothing written]' : ''}`);
        for (const t of result.tables) {
          console.log(`  ${t.id}: ${t.received} received, ${t.inserted} inserted, ${t.updated} updated, ${t.skipped} skipped`);
        }
        for (const i of result.ignoredTables) console.log(`  ${i.id}: ignored (${i.reason})`);
        const { received, inserted, updated, skipped } = result.totals;
        console.log(`  total: ${received} received, ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
      }
    } catch (e) {
      failed = true;
      const code = e?.code ?? 'unknown';
      results.push({ file, error: code });
      if (!asJson) console.error(`${file}: import failed (${code})`);
    }
  }
} catch (e) {
  failed = true;
  console.error(`Database unavailable: ${e?.code ?? 'unknown'}`);
} finally {
  closeDb();
}
if (asJson) console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
