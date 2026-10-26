// One-off: copy the local data/ files (deals, status, campaign cache, expiry dates) into the
// database's kv table, so the online site starts with today's data instead of empty sections.
//   DATABASE_URL=postgres://… node scripts/import-data.js
// Existing rows with the same name are replaced. Users and favorites are not touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../src/store.js';
import { initDb, kvSet } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the database to import into.');
  process.exit(1);
}
await initDb();
const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('crawl-progress') && !f.startsWith('wolt-'));
for (const f of files) {
  const value = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'));
  await kvSet(f, value);
  console.log(`imported ${f}`);
}
console.log(`Done: ${files.length} file(s).`);
process.exit(0);
