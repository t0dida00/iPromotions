import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { crawlAll, crawlableStores, currentProgress } from './crawl.js';
import { readStatus, segmentFile, segmentOf, SEGMENTS, migrateLegacy, readRaw, readVersion } from './store.js';
import { rateLimit } from './rateLimit.js';
import { authRouter, requireOwner, requireUser, isOwner } from './auth.js';
import { favoritesRouter } from './favorites.js';
import { sharedRouter } from './shared.js';
import { initDb, ensureDb, dbEnabled, hit, query } from './db.js';
import { scanEnabled, scanLabel, listEntries, entryFrom, addEntry, changeEntry, removeEntry } from './expiry.js';
import { woltOffers, cachedOffers } from './wolt.js';
import { getCredits, reserve, settle } from './credits.js';
import { guard } from './chatGuard.js';
import { plan, answer, cachedAnswer, offTopicReply, chatEnabled } from './chat.js';
import { storeOverview } from './dealIndex.js';
import { getHistory, appendExchange, clearHistory, resetContext, recentQuestions, isClearCommand, isNewSearchCommand } from './chatHistory.js';
import { billingRouter, stripeWebhook, paymentsEnabled } from './billing.js';
import { isLive } from './validity.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const startedAt = new Date().toISOString();
const COOLDOWN_MS = (config.refreshCooldownMinutes ?? 10) * 60_000;

// Locally this file is the server (listen, cron, startup crawl). On Vercel, api/index.js imports
// `app` and Vercel runs it as a function: no listen and no crawling. Refreshes run only on the
// owner's computer (`npm run start:sync`), which writes the deals to the same database.
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
const checkoutLimit = rateLimit({ name: 'checkout', shared: true, ...limits.checkout, message: 'Too many payment attempts from this address. Please wait a few minutes.' });
const chatLimit = rateLimit({ name: 'chat', shared: true, ...limits.chat, message: 'Too many questions from this address. Please wait a few minutes.' });
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
// Stripe → us (src/billing.js): raw body for the signature check, and no rate limit (Stripe retries).
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
app.use('/api', rateLimit({ name: 'api', ...limits.api }));
app.use(rateLimit({ name: 'pages', ...limits.pages }));

// no-cache = the browser re-checks (cheaply, via ETag) so an updated file is never stale, and an
// unchanged one costs only an empty "304 Not Modified" reply.
const revalidate = (res) => res.setHeader('Cache-Control', 'no-cache');
app.use(express.static(PUBLIC, { setHeaders: revalidate }));
// Firebase settings for Google sign-in in the browser: GET /api/auth-config.
app.use(authRouter);
app.use(favoritesRouter);
app.use(sharedRouter);
app.use('/api/billing/checkout', checkoutLimit);
app.use(billingRouter);

// One read shared by every request arriving within `ms` (and while it's in flight), so a burst of
// visitors costs one file or database read instead of one each. Errors aren't kept.
function shared(fn, ms) {
  let at = 0;
  let p = null;
  return () => {
    if (p && Date.now() - at < ms) return p;
    at = Date.now();
    return (p = fn().catch((e) => ((p = null), Promise.reject(e))));
  };
}
// Status and crawl progress for the pages that every tab polls (not for starting a crawl, which
// reads them fresh).
const sharedStatus = shared(readStatus, 2000);
const sharedProgress = shared(currentProgress, 2000);

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
// this process or, online, on the owner's computer (src/crawl.js currentProgress).
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

// Crawler errors (store URLs, stack-like messages) are for the owner only: everyone else just
// learns that a store failed (`ok: false`) and is told to contact the admin.
const publicStatus = (s) => (s && 'error' in s ? { ...s, error: undefined } : s);
const statusFor = (sources, owner) => (owner ? sources : Object.fromEntries(Object.entries(sources ?? {}).map(([k, s]) => [k, publicStatus(s)])));

// Small, frequently polled: stores, their status, per-section update times and refresh state.
app.get('/api/meta', async (req, res) => {
  const [status, p, owner] = await Promise.all([sharedStatus(), sharedProgress(), isOwner(req)]);
  // Every open tab polls this (every minute, every 3 s during a refresh). Visitors without a sign-in
  // all get the same answer, so the CDN may reuse it for 5 s; the owner's (with crawler errors) is
  // never cached.
  if (!owner) res.setHeader('Vercel-CDN-Cache-Control', 'max-age=5, stale-while-revalidate=30');
  res.json({
    stores: storeList(),
    sources: statusFor(status.sources, owner),
    segments: status.segments ?? {},
    updatedAt: status.updatedAt,
    crawling: crawlingInfo(p),
    cooldownUntil: cooldowns(status.sources),
    cooldownMinutes: COOLDOWN_MS / 60_000,
    schedule: config.schedule,
    refresh: !ON_VERCEL, // false: the page hides its Refresh buttons
  });
});

// One section's deals, loaded only when that section is opened. Expired deals are left out and
// fields the page doesn't use are dropped; the result is built once per stored version and hour
// (deals end by the hour at most), gzipped, and has an ETag from its content, so a re-crawl that
// changed nothing still answers 304. Sections are megabytes: gzip keeps them far under Vercel's
// 4.5 MB response limit.
// Under load only a cheap version check runs (file time / the row's updated_at, shared by every
// request within 5 s); the section itself is read and built once per change, however many
// visitors ask at the same moment.
const dealsCache = new Map(); // segment → { key, etag, json, gz }
const dealsBuilding = new Map(); // segment → { key, promise } while a new version is being built
const dealsVersion = Object.fromEntries(SEGMENTS.map((s) => [s, shared(() => readVersion(segmentFile(s)), 5000)]));
const gzip = promisify(zlib.gzip);
const hourKey = (mtime) => `${new Date(mtime).getTime()}:${Math.floor(Date.now() / 3_600_000)}`;

async function dealsPayload(segment) {
  const version = await dealsVersion[segment]();
  if (!version) return null; // section never crawled yet
  const key = hourKey(version);
  const hit = dealsCache.get(segment);
  if (hit?.key === key) return hit;
  const building = dealsBuilding.get(segment);
  if (building?.key === key) return building.promise;
  const promise = (async () => {
    const raw = await readRaw(segmentFile(segment)); // file locally, kv row online
    if (!raw) return null;
    const data = JSON.parse(raw.body);
    const now = Date.now();
    const deals = (data.deals ?? []).filter((d) => isLive(d, now)).map(({ segment: _s, analyzed: _a, ...d }) => d);
    const json = JSON.stringify({ updatedAt: data.updatedAt ?? null, deals });
    const etag = `W/"${segment}-${crypto.createHash('sha1').update(json).digest('base64url').slice(0, 16)}"`;
    const entry = { key: hourKey(raw.mtime), etag, json, gz: await gzip(json) }; // off the main thread
    dealsCache.set(segment, entry);
    return entry;
  })().finally(() => dealsBuilding.delete(segment));
  dealsBuilding.set(segment, { key, promise });
  return promise;
}

app.get('/api/deals', async (req, res) => {
  const segment = String(req.query.segment ?? '');
  if (!SEGMENTS.includes(segment)) return res.status(400).json({ error: `segment must be one of: ${SEGMENTS.join(', ')}` });
  revalidate(res);
  const p = await dealsPayload(segment);
  if (!p) return res.json({ updatedAt: null, deals: [] });
  // Vercel's CDN keeps the section for a minute (and serves it stale for 10 more while it fetches a
  // new copy), so a crowd opening the page at once is answered at the edge, not by our functions.
  // Browsers still revalidate every time (Cache-Control: no-cache) and get 304s.
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=60, stale-while-revalidate=600');
  res.setHeader('ETag', p.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.get('if-none-match') === p.etag) return res.status(304).end();
  res.type('json');
  if (!/\bgzip\b/.test(req.get('accept-encoding') ?? '')) return res.send(p.json);
  res.setHeader('Content-Encoding', 'gzip');
  res.send(p.gz);
});

// Every store's best deals for the dashboard's 3D town (public/store3d.js): up to 6 per store,
// spread over groups, from the assistant's in-memory index, so the page doesn't download sections.
// Built once per limit and shared for 30 s; the CDN keeps it a minute.
const topStores = Object.fromEntries([1, 2, 3, 4, 5, 6].map((limit) => [limit, shared(async () => {
  const stores = {};
  for (const key of crawlableStores()) {
    const { store, total, avgDiscount, items } = await storeOverview(key, limit);
    stores[key] = { store, total, avgDiscount, items };
  }
  return stores;
}, 30_000)]));
app.get('/api/stores/top', async (req, res) => {
  const limit = Math.min(6, Math.max(1, Number(req.query.limit) || 3));
  const stores = await topStores[limit]();
  revalidate(res);
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=60, stale-while-revalidate=600');
  res.json({ stores });
});

// Everything the dashboard shows; read from status.json only, no deal files.
app.get('/api/status', async (req, res) => {
  const [{ updatedAt, sources, runs = [] }, p, owner] = await Promise.all([sharedStatus(), sharedProgress(), isOwner(req)]);
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
      status: (owner ? (x) => x : publicStatus)(p?.sources?.[s.key] || sources[s.key] || null),
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
// Not online: Vercel's servers are blocked by several stores, so the owner refreshes from their own
// computer (`npm run start:sync`) and the deals reach the site through the shared database.
app.post('/api/crawl', requireOwner, crawlLimit, async (req, res) => {
  if (ON_VERCEL) return res.status(404).json({ error: 'Refreshes run on the owner\'s computer, not online.' });
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
  crawlAll(console.log, 'manual', start).catch((e) => console.error('[crawl]', e));
  res.status(202).json({ crawling: true, queued, stores: start, skipped });
});

// Wolt offers near a location (Food Promotions). A cached area answers at once; a new one opens
// wolt.com in a headless browser (~20 s), so only those lookups count against the `wolt` limit.
// Without coordinates the default location from config.js (Oulu) is used.
app.get('/api/wolt', async (req, res) => {
  const def = config.wolt?.defaultLocation ?? { lat: 65.0121, lon: 25.4651, city: 'Oulu' };
  const hasCoords = req.query.lat != null && req.query.lon != null;
  const lat = hasCoords ? Number(req.query.lat) : def.lat;
  const lon = hasCoords ? Number(req.query.lon) : def.lon;
  // Wolt links and prices here are for Finland; elsewhere the visitor gets the default location.
  if (!(lat >= 59.5 && lat <= 70.2 && lon >= 19 && lon <= 31.7))
    return res.status(400).json({ error: 'Location must be in Finland', outside: true });
  const send = async () => {
    try {
      res.json({ ...(await woltOffers(lat, lon)), isDefault: !hasCoords, city: hasCoords ? null : def.city ?? null });
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
  await woltLimit(req, res, send);
});

// Follow your discount: read the expiry date from a product photo, and keep each signed-in user's
// dates (src/expiry.js). Photos arrive as small JPEG data URLs (shrunk in the browser) and are
// never stored.
const json = express.json({ limit: '400kb' });
const usedToday = new Map(); // "kind:uid" -> { day, count } without a database; resets at midnight UTC

// This user's photo checks (kind 'scan') or assistant questions ('chat') today, counting this one.
// In the database when there is one, so the cap holds across server instances.
async function countToday(kind, uid) {
  const day = new Date().toISOString().slice(0, 10);
  if (dbEnabled()) return (await hit(`${kind}day:${uid}:${day}`, 86_400_000)).count;
  const used = usedToday.get(`${kind}:${uid}`);
  const count = (used?.day === day ? used.count : 0) + 1;
  usedToday.set(`${kind}:${uid}`, { day, count });
  return count;
}

// Each check that finds a date costs 1 (src/credits.js): one is reserved before the model runs and
// given back if no date was found. With no checks left the answer is 402 with a link to /pricing.
// Without a database (local) checks aren't metered; the daily cap still applies.
app.post('/api/expiry/scan', requireUser, scanLimit, json, async (req, res) => {
  const image = req.body?.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image))
    return res.status(400).json({ error: 'Send the photo as a JPEG, PNG or WebP data URL.' });
  if (!scanEnabled()) return res.status(503).json({ error: 'Photo checks are not configured on this server yet.' });
  if (dbEnabled() && req.user.id == null) return res.status(503).json({ error: "We couldn't reach your account right now. Please try again in a moment." });
  let reservation = null;
  try {
    if (dbEnabled()) {
      reservation = await reserve(req.user);
      if (!reservation.ok)
        return res.status(402).json({ error: "You're out of checks. Get more on the pricing page, or wait for your free weekly check.", credits: reservation.credits, pricing: '/pricing' });
    }
    const cap = reservation?.unlimited ? config.credits.unlimitedPerDay : config.expiryScansPerDay;
    if ((await countToday('scan', req.user.uid)) > cap) {
      if (reservation) await settle(req.user, reservation, false);
      return res.status(429).json({ error: `You have used today's ${cap} photo checks. Try again tomorrow.` });
    }
    const result = await scanLabel(image);
    const credits = reservation ? await settle(req.user, reservation, result.found) : null;
    res.json({ ...result, credits });
  } catch (e) {
    console.error('[expiry]', e.message);
    if (reservation) await settle(req.user, reservation, false).catch((err) => console.error('[credits] refund failed:', err.message));
    res.status(502).json({ error: "We couldn't check this photo right now. Please try again in a moment." });
  }
});

// Deals assistant (floating chat; src/chat.js). "/clear" (or "clear the chat"…) deletes the
// conversation, "/new" forgets the remembered search. Every other question first passes the
// security check (src/chatGuard.js): a rejected one gets 400 and never reaches the model, costs
// nothing and isn't saved. The model then reads the question against the conversation's memory (the
// last search, kept server-side in the history file) and mergeIntent() combines them, so "kana" then
// "in Tokmanni" searches kana in Tokmanni. A search answered before on the same data comes from the
// cache, free. Otherwise an answered question costs 1 check, reserved after planning and given back
// when it found no deals or something failed; off-topic questions are free. Without a database
// (local) checks aren't metered; the daily cap still applies. Questions are saved in the user's
// conversation (src/chatHistory.js, deleted 24 hours after it started).
const chatJson = express.json({ limit: '4kb' });
app.get('/api/chat/history', requireUser, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getHistory(req.user.uid));
});
app.delete('/api/chat/history', requireUser, async (req, res) => {
  await clearHistory(req.user.uid);
  res.status(204).end();
});
app.post('/api/chat', requireUser, chatLimit, chatJson, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const uid = req.user.uid;
  if (isClearCommand(req.body?.message)) {
    await clearHistory(uid);
    return res.json({ cleared: true });
  }
  if (isNewSearchCommand(req.body?.message)) {
    await resetContext(uid);
    return res.json({ reset: true });
  }
  const checked = guard(req.body?.message);
  if (!checked.ok) return res.status(400).json({ error: checked.error, refused: true });
  if (!chatEnabled()) return res.status(503).json({ error: 'The assistant is not configured on this server yet.' });
  if (dbEnabled() && req.user.id == null) return res.status(503).json({ error: "We couldn't reach your account right now. Please try again in a moment." });
  const cap = config.chat?.perDay ?? 100;
  if ((await countToday('chat', uid)) > cap) return res.status(429).json({ error: `You have asked today's ${cap} questions. Try again tomorrow.` });

  // The conversation's memory (the last search) lives on the server, in the user's history file;
  // nothing the browser sends can change it.
  const history = await getHistory(uid);
  const save = (reply) => appendExchange(uid, checked.text, reply).catch((e) => console.error('[chat] history:', e.message));
  let reservation = null;
  try {
    const planned = await plan(checked.text, history.context, recentQuestions(history));
    if (!planned.onTopic) {
      const reply = offTopicReply(planned.intent.language); // free; the remembered search stays as it was
      await save(reply);
      return res.json({ ...reply, credits: null });
    }
    const cached = await cachedAnswer(planned.intent).catch((e) => (console.error('[chat] cache:', e.message), { key: null, reply: null }));
    if (cached.reply) {
      await save(cached.reply);
      return res.json({ ...cached.reply, cached: true, credits: null });
    }
    if (dbEnabled()) {
      reservation = await reserve(req.user);
      if (!reservation.ok)
        return res.status(402).json({ error: "You're out of checks. Get more on the pricing page, or wait for your free weekly check.", credits: reservation.credits, pricing: '/pricing' });
    }
    const result = await answer(checked.text, planned.intent, planned.vocab, cached.key);
    const credits = reservation ? await settle(req.user, reservation, result.found, 'chat') : null;
    await save(result);
    res.json({ ...result, credits });
  } catch (e) {
    console.error('[chat]', e.message);
    if (reservation) await settle(req.user, reservation, false, 'chat').catch((err) => console.error('[credits] refund failed:', err.message));
    res.status(502).json({ error: "The assistant couldn't answer right now. Please try again in a moment. No check was used." });
  }
});

// The plans on sale and whether payments are switched on (/pricing; public).
app.get('/api/plans', (_req, res) => {
  const { plans, freeChecks, weeklyChecks, unlimitedPerDay } = config.credits;
  res.json({ plans: Object.entries(plans).map(([key, p]) => ({ key, ...p })), freeChecks, weeklyChecks, unlimitedPerDay, payments: paymentsEnabled() });
});

// The signed-in user's checks: { credits: { balance, unlimitedUntil, nextFreeAt, owner } }, or
// credits null when checks aren't metered (no database).
app.get('/api/credits', requireUser, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!dbEnabled() || req.user.id == null) return res.json({ credits: null });
  try {
    res.json({ credits: await getCredits(req.user) });
  } catch (e) {
    console.error('[credits]', e.message);
    res.status(503).json({ error: "Couldn't load your checks right now. Please try again in a moment." });
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
app.get(['/dashboard', '/favorites', '/promotions', '/clothing', '/electronics', '/beauty', '/food', '/follow', '/shared', '/how-it-works', '/privacy', '/terms', '/contact', '/pricing'], (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Scheduled refreshes, off unless set in config.js (the owner refreshes by hand): sections in
// `sectionSchedules` run on their own cron; the main schedule refreshes every other store. The
// first start still crawls everything, and the cooldown only limits clicks.
const ownSchedule = Object.fromEntries(Object.entries(config.sectionSchedules ?? {}).filter(([, expr]) => expr));
const SECTION_NAMES = { groceries: 'Supermarkets', clothing: 'Clothes', electronics: 'Electronics', beauty: 'Beauty & Health', food: 'Food' };
const schedules = [
  { label: Object.keys(ownSchedule).length ? 'Other sections' : null, cron: config.schedule, stores: () => crawlableStores().filter((k) => !ownSchedule[segmentOf(k)]) },
  ...Object.entries(ownSchedule).map(([seg, expr]) => ({ label: SECTION_NAMES[seg] ?? seg, cron: expr, stores: () => crawlableStores().filter((k) => segmentOf(k) === seg) })),
].filter((s) => s.cron).map((s) => ({
  ...s,
  // On Vercel the schedules only report their next run (a function can't run a cron).
  task: cron.schedule(s.cron, ON_VERCEL ? () => {} : () => crawlAll(console.log, 'schedule', s.stores()).catch((e) => console.error('[cron]', e)), { timezone: config.timezone }),
}));

// The next scheduled refresh of any section, for the dashboard.
function nextSchedule() {
  const next = schedules
    .map((s) => ({ ...s, at: s.task.getNextRun() }))
    .filter((s) => s.at && s.stores().length)
    .sort((a, b) => a.at - b.at)[0];
  return {
    cron: next?.cron ?? config.schedule, // null: no schedule, refreshed by hand
    label: next?.label ?? null,
    timezone: config.timezone,
    nextRun: next?.at.toISOString() ?? null,
    all: schedules.map((s) => ({ label: s.label, cron: s.cron, nextRun: s.task.getNextRun()?.toISOString() ?? null })),
  };
}

// Last stop for unexpected errors: log the details, send the visitor plain words (never a stack trace).
app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  if (res.headersSent) return;
  const status = err.status >= 400 && err.status < 500 ? err.status : 500; // e.g. 400 bad JSON, 413 too large
  res.status(status).json({ error: status < 500 ? 'The request could not be read.' : 'Something went wrong. Please try again in a moment.' });
});

// Builds every section's payload in the background as soon as the process starts (also on each
// cold Vercel instance), so the first crowd doesn't wait while a 3 MB section is parsed.
const warmDeals = () => Promise.all(SEGMENTS.map((s) => dealsPayload(s).catch((e) => console.error(`[deals] warm-up ${s}:`, e.message))));

// Below: only when running as a normal server (locally, or any host with a lasting process).
if (ON_VERCEL) warmDeals();
else await startServer();

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
    console.log(`iPromotion running at http://localhost:${config.port} (crawl schedules: ${schedules.map((x) => `${x.label ?? "all"} "${x.cron}"`).join(", ") || "none, refresh by hand"})`);
    if (await migrateLegacy()) console.log('Moved data/deals.json into per-section files (old file kept as deals.json.bak)');
    warmDeals();
    // First run: no data yet, so crawl right away.
    const { updatedAt } = await readStatus();
    if (!updatedAt) crawlAll(console.log, 'startup').catch((e) => console.error('[crawl]', e));
  }).on('error', (err) => {
    // e.g. EADDRINUSE: another iPromotion server is already running on this port.
    console.error(`Could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  });
}
