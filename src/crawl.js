import { fileURLToPath } from 'node:url';
import config from '../config.js';
import path from 'node:path';
import { readStatus, writeStatus, readSegment, writeSegment, segmentOf, summarize, migrateLegacy, DATA_DIR, readJson, writeJson, useDb } from './store.js';
import { crawlTokmanni } from './crawlers/tokmanni.js';
import { crawlKRuoka } from './crawlers/kruoka.js';
import { crawlPrisma } from './crawlers/prisma.js';
import { crawlLidl } from './crawlers/lidl.js';
import { crawlXXL } from './crawlers/xxl.js';
import { crawlIntersport } from './crawlers/intersport.js';
import { crawlKappAhl } from './crawlers/kappahl.js';
import { crawlNewYorker } from './crawlers/newyorker.js';
import { crawlStadium } from './crawlers/stadium.js';
import { crawlPower } from './crawlers/power.js';
import { crawlVerkkokauppa } from './crawlers/verkkokauppa.js';
import { crawlGigantti } from './crawlers/gigantti.js';
import { crawlHesburger } from './crawlers/hesburger.js';
import { crawlBurgerKing } from './crawlers/burgerking.js';
import { unifyCategory } from './categories.js';
import { normalizeValidUntil } from './validity.js';

const CRAWLERS = {
  tokmanni: crawlTokmanni,
  kruoka: crawlKRuoka,
  prisma: crawlPrisma,
  lidl: crawlLidl,
  xxl: crawlXXL,
  intersport: crawlIntersport,
  kappahl: crawlKappAhl,
  newyorker: crawlNewYorker,
  stadium: crawlStadium,
  power: crawlPower,
  verkkokauppa: crawlVerkkokauppa,
  gigantti: crawlGigantti,
  hesburger: crawlHesburger,
  burgerking: crawlBurgerKing,
};

let running = null;
let queued = null; // stores asked for while a crawl was running: null, 'all' or a Set of keys
// Live progress for the dashboard while a crawl runs: stores in this run, crawling right now,
// and finished ones.
export const progress = { startedAt: null, trigger: null, scope: [], running: [], done: [], queued: [], sources: {} };
const MAX_RUNS = 20;

// Online the crawl runs on GitHub Actions while the site runs on Vercel, so the progress above is
// also saved (DATA_STORE=postgres) for the site to read. A saved progress older than STALE_MS is
// ignored (e.g. a job that was cancelled before it could clear it).
const PROGRESS_FILE = path.join(DATA_DIR, 'crawl-progress.json');
const STALE_MS = 45 * 60_000;
export const saveProgress = (extra = {}) =>
  useDb() ? writeJson(PROGRESS_FILE, { ...progress, active: true, savedAt: new Date().toISOString(), ...extra }).catch((e) => console.error('[crawl] progress:', e.message)) : Promise.resolve();

// The crawl in progress, here or (online) on GitHub Actions; null when none.
export async function currentProgress() {
  if (running) return { ...progress };
  if (!useDb()) return null;
  const saved = await readJson(PROGRESS_FILE, null);
  return saved?.active && Date.now() - Date.parse(saved.savedAt) < STALE_MS ? saved : null;
}

// Stores that have a crawler (brochure-only stores don't).
export const crawlableStores = () =>
  Object.entries(config.sources).filter(([, o]) => o.enabled && o.type).map(([k]) => k);

// Crawls enabled sources in parallel (up to `config.concurrency` at once). `only` limits the run
// to some store keys (one section's Refresh button, or one store on the dashboard); every other
// store keeps its current deals. A source that fails keeps its previous results, so one broken
// site doesn't empty the page. `trigger` ("schedule", "manual", "startup", "cli") is recorded in
// the run history. A request that arrives while a crawl runs is queued and runs right after.
export function crawlAll(log = console.log, trigger = 'cli', only = null) {
  if (running) {
    queued = queued === 'all' || !only ? 'all' : new Set([...(queued ?? []), ...only]);
    progress.queued = queued === 'all' ? crawlableStores() : [...queued];
    return running.then(() => {
      if (!queued) return readStatus();
      const next = queued === 'all' ? null : [...queued];
      queued = null;
      return crawlAll(log, trigger, next);
    });
  }
  running = (async () => {
    const runStarted = Date.now();
    const keys = crawlableStores().filter((k) => !only || only.includes(k));
    Object.assign(progress, {
      startedAt: new Date(runStarted).toISOString(),
      trigger,
      scope: keys,
      running: [],
      done: [],
      queued: [],
      sources: {},
    });
    await saveProgress();
    await migrateLegacy();
    const prev = await readStatus();
    // Drop status for stores no longer in the config (e.g. the old combined "kruoka" source).
    const sources = Object.fromEntries(Object.entries(prev.sources).filter(([k]) => config.sources[k]));
    const jobs = keys.map((k) => [k, config.sources[k]]);
    const results = {};
    // Only the sections this run touches are read and rewritten.
    const segments = [...new Set(keys.map(segmentOf))];
    const prevDeals = Object.fromEntries(await Promise.all(segments.map(async (s) => [s, (await readSegment(s)).deals])));
    const previous = (key) => prevDeals[segmentOf(key)].filter((d) => d.source === key);

    async function crawlOne([key, opts]) {
      const started = Date.now();
      progress.running.push(key);
      saveProgress();
      log(`[crawl] ${key}…`);
      try {
        results[key] = (await CRAWLERS[opts.type](opts, log)).map((d) => enrich(d, key, opts.segment));
        sources[key] = {
          ok: true,
          ...summarize(results[key]),
          crawledAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          error: null,
        };
        log(`[crawl] ${key}: ${results[key].length} deals in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (err) {
        results[key] = previous(key);
        sources[key] = {
          ...sources[key],
          ok: false,
          error: String(err.message ?? err),
          failedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
        };
        log(`[crawl] ${key} FAILED: ${err.message} (kept ${results[key].length} previous deals)`);
      }
      progress.sources[key] = sources[key]; // shown on the dashboard before the run is saved
      progress.running = progress.running.filter((k) => k !== key);
      progress.done.push(key);
      await saveProgress();
    }

    // Simple worker pool: each worker takes the next store until none are left.
    const queue = [...jobs];
    const workers = Math.max(1, Math.min(config.concurrency ?? jobs.length, jobs.length));
    await Promise.all(Array.from({ length: workers }, async () => {
      while (queue.length) await crawlOne(queue.shift());
    }));

    // Rewrite each touched section file. Stores not in this run keep their previous deals; keep
    // config order regardless of which store finished first.
    const finishedAt = new Date().toISOString();
    const sectionTimes = { ...(prev.segments ?? {}) };
    let total = 0;
    for (const seg of segments) {
      const deals = crawlableStores()
        .filter((k) => segmentOf(k) === seg)
        .flatMap((k) => results[k] ?? previous(k));
      await writeSegment(seg, deals, finishedAt);
      sectionTimes[seg] = finishedAt;
    }
    for (const k of crawlableStores()) total += sources[k]?.count ?? 0;
    const run = {
      startedAt: new Date(runStarted).toISOString(),
      finishedAt,
      durationMs: Date.now() - runStarted,
      trigger,
      stores: only ? keys : null, // null = all stores
      deals: total,
      failed: progress.done.filter((k) => !sources[k]?.ok),
    };
    const status = { updatedAt: finishedAt, sources, runs: [run, ...(prev.runs ?? [])].slice(0, MAX_RUNS), segments: sectionTimes };
    await writeStatus(status);
    return status;
  })().finally(async () => {
    running = null;
    progress.running = [];
    await saveProgress({ active: false });
  });
  return running;
}

export const isCrawling = () => running !== null;

// Tags each deal with its config key, so two stores using the same crawler (K-Supermarket and
// K-Citymarket) stay separate.
function enrich(d, source, segment = 'groceries') {
  const discountPct =
    d.regularPrice && d.price != null ? Math.round((1 - d.price / d.regularPrice) * 100) : null;
  // Electronics rules read category and name together; the others fall back to the product
  // name when the store's own category doesn't match a rule.
  let group =
    segment === 'electronics' ? unifyCategory(`${d.category ?? ''} ${d.name}`, segment) : unifyCategory(d.category, segment);
  if (group.startsWith('Other') && segment !== 'electronics') group = unifyCategory(d.name, segment);
  return {
    ...d,
    id: `${source}:${d.id.slice(d.id.indexOf(':') + 1)}`,
    source,
    segment,
    // Use the store/analyst figure when there's no old price to compute it from ("-40 %").
    discountPct: discountPct > 0 ? discountPct : d.discountPct > 0 ? d.discountPct : null,
    group,
    validUntil: normalizeValidUntil(d.validUntil), // a bare day = the end of that day in Finland
  };
}

// `npm run crawl` — one-off crawl from the command line (also what GitHub Actions runs online).
//   npm run crawl                                   every store
//   npm run crawl -- --segment food,clothing        only those sections' stores
//   npm run crawl -- --trigger schedule             recorded in the run history (default "cli")
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const segs = arg('segment')?.split(',').map((s) => s.trim()).filter(Boolean);
  const only = segs?.length ? crawlableStores().filter((k) => segs.includes(segmentOf(k))) : null;
  if (segs?.length && !only.length) throw new Error(`No stores in section(s): ${segs.join(', ')}`);
  const status = await crawlAll(console.log, arg('trigger') ?? 'cli', only);
  const { deals, failed } = status.runs[0];
  const where = useDb() ? 'to the database' : `to ${DATA_DIR}`;
  console.log(`Saved ${deals} deals ${where}`);
  // A failed store keeps its previous deals, but exits non-zero so the GitHub Actions run shows red
  // (and GitHub emails about scheduled runs that fail). Exiting also closes the database pool.
  if (failed.length) console.error(`Failed: ${failed.join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}
