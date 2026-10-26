import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { crawlAll, crawlableStores, currentProgress, saveProgress } from './crawl.js';
import { readStatus, segmentFile, segmentOf, SEGMENTS, migrateLegacy, readRaw } from './store.js';
import { rateLimit } from './rateLimit.js';
import { authRouter, requireOwner, requireUser } from './auth.js';
import { favoritesRouter } from './favorites.js';
import { initDb, ensureDb, dbEnabled, hit, query } from './db.js';
import { dispatchCrawl } from './github.js';
import { scanEnabled, scanLabel, listEntries, entryFrom, addEntry, changeEntry, removeEntry } from './expiry.js';
import { woltOffers, cachedOffers } from './wolt.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const startedAt = new Date().toISOString();
const COOLDOWN_MS = (config.refreshCooldownMinutes ?? 10) * 60_000;

// Locally this file is the server (listen, cron, startup crawl). On Vercel, api/index.js imports
// `app` and Vercel runs it as a function: no listen, and crawls run on GitHub Actions instead.
const ON_VERCEL = Boolean(process.env.VERCEL);

export const app = express();
app.disable('x-powered-by');
// Behind Vercel's proxy, req.ip must come from X-Forwarded-For so rate limits see the visitor.
// Behind another reverse proxy, set this too.
if (ON_VERCEL) app.set('trust proxy', true);
// A function instance may start cold: make sure the tables exist before the first query.
app.use((_req, _res, next) => (dbEnabled() ? ensureDb().catch((e) => console.error('[db]', e.message)).then(() => next()) : next()));

// Per-IP limits against bots: strict for refreshes, generous for data, loose for files. The costly
// ones (refreshes, Wolt, photo checks) are counted in the database, shared by all instances.
const limits = config.rateLimits ?? {};
const crawlLimit = rateLimit({ name: 'crawl', shared: true, ...limits.crawl, message: 'Too many refresh requests from this address. Please wait a few minutes.' });
const scanLimit = rateLimit({ name: 'scan', shared: true, ...limits.scan, message: 'Too many photo checks from this address. Please wait a few minutes.' });
const woltLimit = rateLimit({ name: 'wolt', shared: true, ...limits.wolt, message: 'Too many Wolt lookups for new locations from this address. Please wait a few minutes.' });
// For uptime checks: is the database reachable, and when did the last crawl finish? Before the
// rate limits, so a monitor polling it never gets 429.
app.get('/api/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let db = null; // null = no database configured
  if (dbEnabled()) db = await query('select 1').then(() => true, () => false);
  const lastCrawl = db === false ? null : (await readStatus()).updatedAt;
  res.status(db === false ? 503 : 200).json({ ok: db !== false, db, lastCrawl });
});
app.use('/api', rateLimit({ name: 'api', ...limits.api }));
app.use(rateLimit({ name: 'pages', ...limits.pages }));

// no-cache = the browser re-checks (cheaply, via ETag) so an updated file is never stale, and an
// unchanged one costs only an empty "304 Not Modified" reply.
const revalidate = (res) => res.setHeader('Cache-Control', 'no-cache');
app.use(express.static(PUBLIC, { setHeaders: revalidate }));
// Firebase settings for Google sign-in in the browser: GET /api/auth-config.
app.use(authRouter);
app.use(favoritesRouter);

const storeList = () =>
  Object.entries(config.sources)
    .filter(([, s]) => s.enabled)
    .map(([key, s]) => ({
      key,
      name: s.name,
      label: s.label,
      color: s.color,
      logo: s.logo,
      brochureUrl: s.brochureUrl,
      segment: segmentOf(key),
      hasDeals: Boolean(s.type),
    }));

// `crawling` is false, or the stores in the current run (plus any queued ones). The run may be in
// this process or, online, on GitHub Actions (src/crawl.js currentProgress).
const crawlingInfo = (p) => (p ? { scope: [...new Set([...(p.scope ?? []), ...(p.queued ?? [])])], running: p.running ?? [], done: p.done ?? [] } : false);

// When each store may be refreshed again by hand (null = now).
function cooldowns(sources) {
  const out = {};
  for (const k of crawlableStores()) {
    const last = sources[k]?.ok ? Date.parse(sources[k].crawledAt) : NaN;
    out[k] = Date.now() - last < COOLDOWN_MS ? new Date(last + COOLDOWN_MS).toISOString() : null;
  }
  return out;
}

// Small, frequently polled: stores, their status, per-section update times and refresh state.
app.get('/api/meta', async (_req, res) => {
  const [status, p] = await Promise.all([readStatus(), currentProgress()]);
  res.json({
    stores: storeList(),
    sources: status.sources,
    segments: status.segments ?? {},
    updatedAt: status.updatedAt,
    crawling: crawlingInfo(p),
    cooldownUntil: cooldowns(status.sources),
    cooldownMinutes: COOLDOWN_MS / 60_000,
    schedule: config.schedule,
  });
});

// One section's deals, loaded only when that section is opened. Sent as the stored file with an
// ETag, so a browser that already has this version gets a 304 instead of the data again.
app.get('/api/deals', async (req, res) => {
  const segment = String(req.query.segment ?? '');
  if (!SEGMENTS.includes(segment)) return res.status(400).json({ error: `segment must be one of: ${SEGMENTS.join(', ')}` });
  revalidate(res);
  const raw = await readRaw(segmentFile(segment)); // file locally, kv row online
  if (!raw) return res.json({ updatedAt: null, deals: [] }); // section never crawled yet
  const etag = `W/"${segment}-${raw.mtime.getTime()}"`;
  res.setHeader('ETag', etag);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.type('json').send(raw.body);
});

// Everything the dashboard shows; read from status.json only, no deal files.
app.get('/api/status', async (_req, res) => {
  const [{ updatedAt, sources, runs = [] }, p] = await Promise.all([readStatus(), currentProgress()]);
  const until = cooldowns(sources);
  res.json({
    server: { startedAt, now: new Date().toISOString(), node: process.version },
    schedule: nextSchedule(),
    crawling: p ?? null,
    updatedAt,
    totalDeals: crawlableStores().reduce((n, k) => n + (sources[k]?.count ?? 0), 0),
    stores: storeList().map((s) => ({
      ...s,
      // While a crawl runs, stores that already finished show this run's result.
      status: p?.sources?.[s.key] || sources[s.key] || null,
      deals: sources[s.key]?.count ?? 0,
      avgDiscount: sources[s.key]?.avgDiscount ?? null,
      cooldownUntil: until[s.key] ?? null,
    })),
    runs,
  });
});

// POST /api/crawl                     → every store
// POST /api/crawl?segment=clothing    → one sidebar section's stores
// Repeated clicks are harmless: stores already running or queued aren't added twice, and a store
// refreshed successfully in the last `refreshCooldownMinutes` is skipped. If nothing is left to
// do, the reply is 429 with the time the earliest store becomes available.
// Owner only (role in the users table, see OWNER_EMAIL); the weekly schedule doesn't go through here.
app.post('/api/crawl', requireOwner, crawlLimit, async (req, res) => {
  // Only `segment` is accepted; anything else (e.g. the old `?store=`) is an error, not "refresh all".
  const extra = Object.keys(req.query).filter((k) => k !== 'segment');
  if (extra.length) return res.status(400).json({ error: `Unsupported parameter: ${extra.join(', ')}` });
  const { segment } = req.query;
  const wanted = segment ? crawlableStores().filter((k) => segmentOf(k) === segment) : crawlableStores();
  if (!wanted.length) return res.status(400).json({ error: 'Unknown section' });

  const p = await currentProgress();
  const busy = new Set([...(p ? (p.scope ?? []).filter((k) => !(p.done ?? []).includes(k)) : []), ...(p?.queued ?? [])]);
  const until = cooldowns((await readStatus()).sources);
  const skipped = wanted
    .filter((k) => busy.has(k) || until[k])
    .map((k) => ({ key: k, reason: busy.has(k) ? 'already refreshing' : 'cooldown', availableAt: until[k] }));
  const start = wanted.filter((k) => !busy.has(k) && !until[k]);
  if (!start.length) {
    const next = skipped.map((s) => s.availableAt).filter(Boolean).sort()[0] ?? null;
    return res.status(429).json({ error: 'Already refreshing or refreshed recently', availableAt: next, skipped });
  }
  const queued = Boolean(p);
  if (ON_VERCEL) {
    // Online the crawl runs on GitHub Actions (.github/workflows/crawl.yml); it starts in ~30 s.
    const segs = [...new Set(start.map(segmentOf))];
    try {
      await dispatchCrawl(segment ? segs : null);
    } catch (e) {
      console.error('[crawl] could not start the GitHub job:', e.message);
      return res.status(502).json({ error: "Couldn't start the refresh right now. Please try again in a moment." });
    }
    // Show the section as busy until the job reports its own progress. A whole section is queued,
    // since the job refreshes sections, not single stores.
    const scope = crawlableStores().filter((k) => segs.includes(segmentOf(k)));
    await saveProgress({ startedAt: null, trigger: 'manual', scope: [], running: [], done: [], queued: scope, sources: {} });
    return res.status(202).json({ crawling: true, queued, stores: scope, skipped });
  }
  crawlAll(console.log, 'manual', start).catch((e) => console.error('[crawl]', e));
  res.status(202).json({ crawling: true, queued, stores: start, skipped });
});

// Wolt offers near a location (Food Promotions). A cached area answers at once; a new one opens
// wolt.com in a headless browser (~20 s), so only those lookups count against the `wolt` limit.
// Without coordinates (location not shared) the default location from config.js is used.
app.get('/api/wolt', async (req, res) => {
  const def = config.wolt?.defaultLocation ?? { lat: 65.0121, lon: 25.4651 };
  const hasCoords = req.query.lat != null && req.query.lon != null;
  const lat = hasCoords ? Number(req.query.lat) : def.lat;
  const lon = hasCoords ? Number(req.query.lon) : def.lon;
  // Wolt links and prices here are for Finland; elsewhere the visitor gets the default location.
  if (!(lat >= 59.5 && lat <= 70.2 && lon >= 19 && lon <= 31.7))
    return res.status(400).json({ error: 'Location must be in Finland', outside: true });
  const send = async () => {
    try {
      res.json({ ...(await woltOffers(lat, lon)), isDefault: !hasCoords });
    } catch (e) {
      console.error('[wolt]', e.message); // details stay in the log; the visitor gets plain words
      const error = /timeout/i.test(e.message)
        ? "Wolt didn't answer in time. Please try again in a moment."
        : /layout|did not accept|no venues/i.test(e.message)
          ? "Wolt's website has changed, so we can't read its offers right now. We'll fix it soon."
          : "We couldn't load Wolt offers right now. Please try again in a moment.";
      res.status(502).json({ error });
    }
  };
  if (await cachedOffers(lat, lon)) return send();
  woltLimit(req, res, send);
});

// Follow your discount: read the expiry date from a product photo, and keep each signed-in user's
// dates (src/expiry.js). Photos arrive as small JPEG data URLs (shrunk in the browser) and are
// never stored.
const json = express.json({ limit: '400kb' });
const scansToday = new Map(); // uid -> { day, count } without a database; resets at midnight UTC

// This user's photo checks today, counting this one. In the database when there is one, so the cap
// holds across server instances.
async function countScan(uid) {
  const day = new Date().toISOString().slice(0, 10);
  if (dbEnabled()) return (await hit(`scanday:${uid}:${day}`, 86_400_000)).count;
  const used = scansToday.get(uid);
  const count = (used?.day === day ? used.count : 0) + 1;
  scansToday.set(uid, { day, count });
  return count;
}

app.post('/api/expiry/scan', requireUser, scanLimit, json, async (req, res) => {
  const image = req.body?.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image))
    return res.status(400).json({ error: 'Send the photo as a JPEG, PNG or WebP data URL.' });
  if (!scanEnabled()) return res.status(503).json({ error: 'Photo checks are not configured on this server yet.' });
  try {
    if ((await countScan(req.user.uid)) > config.expiryScansPerDay)
      return res.status(429).json({ error: `You have used today's ${config.expiryScansPerDay} photo checks. Try again tomorrow.` });
    res.json(await scanLabel(image));
  } catch (e) {
    console.error('[expiry]', e.message);
    res.status(502).json({ error: "We couldn't check this photo right now. Please try again in a moment." });
  }
});

app.get('/api/expiry', requireUser, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ entries: await listEntries(req.user.uid) });
});

app.post('/api/expiry', requireUser, json, async (req, res) => {
  const entry = entryFrom(req.body);
  if (!entry) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) and kind are required.' });
  res.status(201).json(await addEntry(req.user.uid, entry));
});

app.patch('/api/expiry/:id', requireUser, json, async (req, res) => {
  const old = (await listEntries(req.user.uid)).find((e) => e.id === req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const entry = entryFrom({ ...old, ...req.body });
  if (!entry) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) and kind are required.' });
  res.json(await changeEntry(req.user.uid, req.params.id, entry));
});

app.delete('/api/expiry/:id', requireUser, async (req, res) => {
  res.status((await removeEntry(req.user.uid, req.params.id)) ? 204 : 404).end();
});

// Sidebar sections are real URLs; they all load the same page, which shows the matching section.
app.get(['/dashboard', '/favorites', '/promotions', '/clothing', '/electronics', '/food', '/follow'], (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Scheduled refreshes: sections in `sectionSchedules` (e.g. Food, daily) run on their own cron; the
// main schedule (weekly) refreshes every other store. The first start still crawls everything, and
// the cooldown only limits clicks.
const ownSchedule = config.sectionSchedules ?? {};
const SECTION_NAMES = { groceries: 'Market Promotions', clothing: 'Cloth Promotions', electronics: 'Electronics Promotions', food: 'Food Promotions' };
const schedules = [
  { label: Object.keys(ownSchedule).length ? 'Other sections' : null, cron: config.schedule, stores: () => crawlableStores().filter((k) => !ownSchedule[segmentOf(k)]) },
  ...Object.entries(ownSchedule).map(([seg, expr]) => ({ label: SECTION_NAMES[seg] ?? seg, cron: expr, stores: () => crawlableStores().filter((k) => segmentOf(k) === seg) })),
].map((s) => ({
  ...s,
  // On Vercel the schedules only report their next run (GitHub Actions does the crawling).
  task: cron.schedule(s.cron, ON_VERCEL ? () => {} : () => crawlAll(console.log, 'schedule', s.stores()).catch((e) => console.error('[cron]', e)), { timezone: config.timezone }),
}));

// The next scheduled refresh of any section, for the dashboard.
function nextSchedule() {
  const next = schedules
    .map((s) => ({ ...s, at: s.task.getNextRun() }))
    .filter((s) => s.at && s.stores().length)
    .sort((a, b) => a.at - b.at)[0];
  return {
    cron: next?.cron ?? config.schedule,
    label: next?.label ?? null,
    timezone: config.timezone,
    nextRun: next?.at.toISOString() ?? null,
    all: schedules.map((s) => ({ label: s.label, cron: s.cron, nextRun: s.task.getNextRun()?.toISOString() ?? null })),
  };
}

// Below: only when running as a normal server (locally, or any host with a lasting process).
if (!ON_VERCEL) await startServer();

async function startServer() {
  // Accounts need the database; without DATABASE_URL (or if it can't be reached) the site still runs,
  // with favorites kept in each browser.
  try {
    if (await initDb()) console.log('Database ready (users, favorites)');
    else console.warn('DATABASE_URL is not set: accounts are off, favorites stay in each browser. See docker-compose.yml.');
  } catch (e) {
    console.error(`Database unavailable (${e.message}): saved favorites won't work until it is reachable.`);
  }

  app.listen(config.port, async () => {
    console.log(`iPromotion running at http://localhost:${config.port} (crawl schedules: ${schedules.map((x) => `${x.label ?? "all"} "${x.cron}"`).join(", ")})`);
    if (await migrateLegacy()) console.log('Moved data/deals.json into per-section files (old file kept as deals.json.bak)');
    // First run: no data yet, so crawl right away.
    const { updatedAt } = await readStatus();
    if (!updatedAt) crawlAll(console.log, 'startup').catch((e) => console.error('[crawl]', e));
  }).on('error', (err) => {
    // e.g. EADDRINUSE: another iPromotion server is already running on this port.
    console.error(`Could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  });
}
