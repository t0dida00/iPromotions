// Deletes the crawl data (every section's deals, the store status and refresh history, and the
// crawl progress) from the database the site reads, so the next refresh starts from scratch.
// Accounts, favorites, expiry dates, credits and caches are not touched. A copy of the deleted rows
// is saved first in data/backup-crawl-<time>.json (restore it with scripts/import-data.js-style
// writes if needed).
//
//   npm run clear:sync -- --yes        the online database (.env.sync)
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../src/db.js';
import { DATA_DIR, useDb } from '../src/store.js';

if (!useDb() || !process.env.DATABASE_URL) {
  console.error('Needs DATA_STORE=postgres and DATABASE_URL (see .env.sync in .env.example).');
  process.exit(1);
}

const where = `key like 'deals-%.json' or key in ('status.json', 'crawl-progress.json')`;
const { rows } = await query(`select key, value, updated_at from kv where ${where} order by key`);
if (!rows.length) {
  console.log('No crawl data in the database.');
  process.exit(0);
}
for (const r of rows) console.log(`  ${r.key}  (${JSON.stringify(r.value).length.toLocaleString('en-GB')} bytes, ${r.updated_at.toISOString()})`);

if (!process.argv.includes('--yes')) {
  console.log(`\n${rows.length} rows would be deleted from ${new URL(process.env.DATABASE_URL).hostname}. Run again with --yes to delete them.`);
  process.exit(0);
}

await fs.mkdir(DATA_DIR, { recursive: true });
const backup = path.join(DATA_DIR, `backup-crawl-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(backup, JSON.stringify(rows));
console.log(`\nBackup: ${backup}`);

const { rowCount } = await query(`delete from kv where ${where}`);
console.log(`Deleted ${rowCount} rows from ${new URL(process.env.DATABASE_URL).hostname}.`);
process.exit(0);
