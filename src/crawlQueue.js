import crypto from 'node:crypto';
import config from '../config.js';
import { withLock } from './db.js';
import { crawlableStores, crawlStore, PROGRESS_FILE, STALE_MS } from './crawl.js';
import { readJson, writeJson, readStatus, writeStatus, readSegment, writeSegment, segmentOf } from './store.js';

// Online (Vercel) a Refresh can't crawl everything in one function: each one is cut off after
// `maxDuration` (vercel.json). So every store gets its own function call:
//   1. startQueue() saves the stores to crawl in crawl-progress.json and starts `LANES` of them;
//   2. each one (POST /api/crawl/store, then runStore) crawls its store and saves it into its section;
//   3. pumpQueue() starts the next waiting store when a lane is free. It runs on the page's polling
//      (/api/meta, /api/status), not from the store that just finished: Vercel stops chains of
//      functions calling each other (508 INFINITE_LOOP_DETECTED) after a few hops.
// The progress row doubles as the queue; its random `token` proves a store call came from us.
// Saves take a database lock, so stores finishing together don't overwrite each other.
const LANES = config.crawlLanes ?? 2; // stores crawled at once (each opens its own Chromium)
const STORE_TIMEOUT_MS = 270_000; // give up before the function's 300 s and still save the failure
const LOST_MS = 330_000; // a store not back by then had its function cut off
const MAX_RUNS = 20;
const LOCK = 'crawl-queue';

const readProgress = () => readJson(PROGRESS_FILE, null);
const isActive = (p) => p?.active && Date.now() - Date.parse(p.savedAt) < STALE_MS;
const save = (p) => writeJson(PROGRESS_FILE, { ...p, savedAt: new Date().toISOString() });

// Moves stores from `pending` to `running` while fewer than LANES are running; returns them.
function takeNext(p) {
  const next = [];
  while (p.pending.length && p.running.length < LANES) {
    const key = p.pending.shift();
    p.running.push(key);
    p.since = { ...p.since, [key]: new Date().toISOString() };
    next.push(key);
  }
  return next;
}

// Adds `stores` to the running crawl, or starts a new one. `origin` is this site's URL, which the
// store calls are sent to.
export async function startQueue(stores, trigger, origin) {
  const { p, next, queued } = await withLock(LOCK, async () => {
    let p = await readProgress();
    const queued = isActive(p);
    if (queued) {
      const busy = new Set([...p.pending, ...p.running]);
      const add = stores.filter((k) => !busy.has(k));
      p.pending.push(...add);
      p.scope = [...new Set([...p.scope, ...add])];
      p.done = p.done.filter((k) => !add.includes(k));
    } else {
      p = {
        active: true,
        startedAt: new Date().toISOString(),
        trigger,
        scope: [...stores],
        pending: [...stores],
        running: [],
        since: {},
        done: [],
        queued: [],
        sources: {},
        token: crypto.randomBytes(24).toString('hex'),
        origin,
      };
    }
    const next = takeNext(p);
    await save(p);
    return { p, next, queued };
  });
  await Promise.all(next.map((k) => dispatch(p, k)));
  return { queued, stores: p.scope };
}

// Starts the next waiting stores if a lane is free, and gives up on stores whose function was cut
// off. Cheap to call often: `p` is the public progress the caller already has (null = no crawl).
export async function pumpQueue(p) {
  if (!p?.scope) return;
  const waiting = p.scope.some((k) => !p.done.includes(k) && !p.running.includes(k));
  const lost = p.running.some((k) => Date.now() - Date.parse(p.since?.[k]) > LOST_MS);
  if (!(waiting && p.running.length < LANES) && !lost) return;
  const { q, next } = await withLock(LOCK, async () => {
    const q = await readProgress();
    if (!isActive(q)) return { q: null, next: [] };
    const lost = q.running.filter((k) => Date.now() - Date.parse(q.since?.[k]) > LOST_MS);
    if (!lost.length && (q.running.length >= LANES || !q.pending.length)) return { q: null, next: [] };
    const status = await readStatus();
    const now = new Date().toISOString();
    for (const k of lost) {
      console.error(`[crawl] ${k}: no answer from its function, counted as failed`);
      await record(q, status, k, null, { ok: false, error: 'The crawl was cut off (took too long)', failedAt: now }, now);
    }
    const next = takeNext(q);
    closeIfDone(q, status, now);
    await writeStatus(status);
    await save(q);
    return { q, next };
  });
  if (q) await Promise.all(next.map((k) => dispatch(q, k)));
}

// Starts one store's function. It answers at once and crawls in the background (waitUntil), so
// this only waits for the hand-over. If the call can't be made, the store is recorded as failed.
async function dispatch(p, key) {
  try {
    const res = await fetch(`${p.origin}/api/crawl/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, token: p.token }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 202) throw new Error(`answered ${res.status}`);
  } catch (e) {
    console.error(`[crawl] could not start ${key}: ${e.message}`);
    await finishStore(p.token, key, null, { ok: false, error: `Could not start the crawl (${e.message})`, failedAt: new Date().toISOString() });
  }
}

// Is this a store call of the running crawl? Checked before answering 202.
export async function acceptStore(key, token) {
  const p = await readProgress();
  if (!isActive(p) || typeof token !== 'string' || token.length !== p.token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(p.token)) && p.running.includes(key);
}

// Crawls one store (inside its own function) and saves it.
export async function runStore(key, token) {
  const [status, section] = await Promise.all([readStatus(), readSegment(segmentOf(key))]);
  const previous = section.deals.filter((d) => d.source === key);
  const { deals, source } = await crawlStore(key, previous, status.sources[key], console.log, STORE_TIMEOUT_MS);
  await finishStore(token, key, source.ok ? deals : null, source);
}

// Saves one store's result and marks it done; the next store is started by pumpQueue.
async function finishStore(token, key, deals, source) {
  await withLock(LOCK, async () => {
    const p = await readProgress();
    if (p?.token !== token || !p.running.includes(key)) return; // a newer run, or already given up on
    const status = await readStatus();
    const now = new Date().toISOString();
    await record(p, status, key, deals, source, now);
    closeIfDone(p, status, now);
    await writeStatus(status);
    await save(p);
  });
}

// One store's result into the status, its section (deals = null keeps the previous ones) and the
// progress. Callers hold the lock and save `p` and `status`.
async function record(p, status, key, deals, source, now) {
  status.sources = Object.fromEntries(Object.entries(status.sources ?? {}).filter(([k]) => config.sources[k]));
  status.sources[key] = { ...status.sources[key], ...source };
  if (deals) {
    // Keep config order, whatever finishes first.
    const seg = segmentOf(key);
    const others = (await readSegment(seg)).deals;
    const merged = crawlableStores()
      .filter((k) => segmentOf(k) === seg)
      .flatMap((k) => (k === key ? deals : others.filter((d) => d.source === k)));
    await writeSegment(seg, merged, now);
    status.segments = { ...(status.segments ?? {}), [seg]: now };
  }
  status.updatedAt = now;
  p.running = p.running.filter((k) => k !== key);
  if (!p.done.includes(key)) p.done.push(key);
  p.sources[key] = status.sources[key];
}

// After the last store of the run: add the run to the history and end the crawl.
function closeIfDone(p, status, now) {
  if (p.running.length || p.pending.length) return;
  status.runs = [{
    startedAt: p.startedAt,
    finishedAt: now,
    durationMs: Date.now() - Date.parse(p.startedAt),
    trigger: p.trigger,
    stores: p.scope.length === crawlableStores().length ? null : p.scope, // null = all stores
    deals: crawlableStores().reduce((n, k) => n + (status.sources[k]?.count ?? 0), 0),
    failed: p.done.filter((k) => !status.sources[k]?.ok),
  }, ...(status.runs ?? [])].slice(0, MAX_RUNS);
  p.active = false;
}
