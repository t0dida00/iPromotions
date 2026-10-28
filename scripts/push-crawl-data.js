// Copies this computer's crawl data (data/deals-<section>.json, status.json and the banner analysis
// cache) to the database the online site reads, replacing what is there. For a crawl made with
// plain `npm start` / `npm run crawl` (local files); `npm run start:sync` writes online directly.
// Accounts, favorites, expiry dates and chat caches are not touched.
//
//   npm run push:sync            shows what would be copied
//   npm run push:sync -- --yes   copies it
import fs from 'node:fs/promises';
import path from 'node:path';
import { kvSet } from '../src/db.js';
import { DATA_DIR, SEGMENTS, useDb } from '../src/store.js';

if (!useDb() || !process.env.DATABASE_URL) {
  console.error('Needs DATA_STORE=postgres and DATABASE_URL (see .env.sync in .env.example).');
  process.exit(1);
}

const names = [...SEGMENTS.map((s) => `deals-${s}.json`), 'status.json', 'analyst-cache.json'];
const files = [];
for (const name of names) {
  const text = await fs.readFile(path.join(DATA_DIR, name), 'utf8').catch(() => null);
  if (text == null) continue;
  const value = JSON.parse(text);
  files.push({ name, value });
  const what = value.deals ? `${value.deals.length} deals, updated ${value.updatedAt}` : value.runs ? `status, ${value.runs.length} runs, updated ${value.updatedAt}` : `${text.length.toLocaleString('en-GB')} bytes`;
  console.log(`  ${name}  (${what})`);
}
if (!files.some((f) => f.name.startsWith('deals-'))) {
  console.error('No deals in data/: crawl first (npm start or npm run crawl).');
  process.exit(1);
}

const host = new URL(process.env.DATABASE_URL).hostname;
if (!process.argv.includes('--yes')) {
  console.log(`\n${files.length} files would replace the ones in ${host}. Run again with --yes to copy them.`);
  process.exit(0);
}
for (const { name, value } of files) await kvSet(name, value);
console.log(`\nCopied ${files.length} files to ${host}.`);
process.exit(0);
