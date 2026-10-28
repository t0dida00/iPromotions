import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import config from '../config.js';
import { callerOf, isOwner, requireUser } from './auth.js';
import { dbEnabled, ensureDb, query } from './db.js';
import { DATA_DIR, readJson, writeJson } from './store.js';
import { rateLimit } from './rateLimit.js';
import { endOfDay } from './validity.js';

// "Shared by buddy": deals that signed-in users spotted themselves (often in-store offers no crawler
// sees) and share with everyone. Anyone can read them; posting needs a login. A post is shown until
// the end of its "valid until" day (a week when none is given); the author or the owner can delete
// it. Kept in the shared_deals table (with DATABASE_URL), otherwise in data/shared.json.
//
//   GET    /api/shared        → { posts: [...] } (live ones, newest first), canDelete per caller
//   POST   /api/shared        → share one (signed in)
//   DELETE /api/shared/:id    → delete one (its author or the owner)
export const sharedRouter = express.Router();

const FILE = path.join(DATA_DIR, 'shared.json');
const MAX_LIVE_PER_USER = 10;
const MAX_LIST = 200;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shareLimit = rateLimit({ name: 'share', shared: true, ...config.rateLimits.share, message: 'Too many shared deals from this address. Please wait a few minutes.' });

// Today in Finland as YYYY-MM-DD, and a day n days later.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// "2,49", "2.49", "2,49 €" → 2.49; empty → null; anything else → NaN.
const euros = (v) => {
  const s = String(v ?? '').replace(/[\s€]/g, '');
  if (!s) return null;
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
};

// What the browser sends → a post, or { error } saying what to fix.
export function postFrom(body) {
  const title = text(body?.title, 80);
  const store = text(body?.store, 60);
  if (title.length < 3) return { error: 'Say what the deal is (at least 3 characters).' };
  if (!store) return { error: 'Say which store has the deal.' };
  const price = euros(body?.price);
  const regularPrice = euros(body?.regularPrice);
  if (Number.isNaN(price) || Number.isNaN(regularPrice)) return { error: 'Prices should be numbers, like 2,49.' };
  const day = today();
  let validUntil = text(body?.validUntil, 10) || plusDays(day, DEFAULT_DAYS - 1);
  if (!DAY.test(validUntil) || new Date(`${validUntil}T00:00:00Z`).toISOString().slice(0, 10) !== validUntil) return { error: 'The end date should be a real date.' };
  if (validUntil < day) return { error: 'That deal has already ended.' };
  if (validUntil > plusDays(day, MAX_DAYS)) return { error: `Deals can be shared for up to ${MAX_DAYS} days.` };
  let url = text(body?.url, 500) || null;
  if (url && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return { error: 'The link should start with https://.' };
  return {
    title,
    store,
    price,
    regularPrice: regularPrice != null && price != null && regularPrice > price ? regularPrice : null,
    validUntil,
    url,
    note: text(body?.note, 280) || null,
  };
}

// The name shown on a post: the first name of the Google account, never the email.
const authorOf = (user) => text(user.name, 40).split(' ')[0] || 'A buddy';

// ── Storage ───────────────────────────────────────────────────────────────────────────────────
const COLUMNS = `id, firebase_uid as uid, author, title, store, price::float8 as price,
  regular_price::float8 as "regularPrice", to_char(valid_until, 'YYYY-MM-DD') as "validUntil", url, note,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;
const sql = async (q, params) => {
  await ensureDb();
  return (await query(q, params)).rows;
};
let writing = Promise.resolve();
const update = (fn) => (writing = writing.then(async () => {
  const all = await readJson(FILE, []);
  const result = fn(all);
  await writeJson(FILE, all);
  return result;
}));

async function livePosts() {
  const day = today();
  if (dbEnabled()) return sql(`select ${COLUMNS} from shared_deals where valid_until >= $1 order by created_at desc limit $2`, [day, MAX_LIST]);
  return (await readJson(FILE, [])).filter((p) => p.validUntil >= day).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_LIST);
}

async function liveCount(uid) {
  const day = today();
  if (dbEnabled()) return (await sql('select count(*)::int as n from shared_deals where firebase_uid = $1 and valid_until >= $2', [uid, day]))[0].n;
  return (await readJson(FILE, [])).filter((p) => p.uid === uid && p.validUntil >= day).length;
}

async function addPost(uid, author, post) {
  const id = crypto.randomUUID();
  if (dbEnabled()) {
    // Ended posts are of no use to anyone: tidy them away now and then.
    await sql("delete from shared_deals where valid_until < (now() at time zone 'Europe/Helsinki')::date - 30");
    const [saved] = await sql(
      `insert into shared_deals (id, firebase_uid, author, title, store, price, regular_price, valid_until, url, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
      [id, uid, author, post.title, post.store, post.price, post.regularPrice, post.validUntil, post.url, post.note],
    );
    return saved;
  }
  return update((all) => {
    const keep = plusDays(today(), -30);
    for (let i = all.length - 1; i >= 0; i--) if (all[i].validUntil < keep) all.splice(i, 1);
    const saved = { id, uid, author, ...post, createdAt: new Date().toISOString() };
    all.push(saved);
    return saved;
  });
}

// Deletes the post when `uid` wrote it (or always, for the owner). True when something was deleted.
async function removePost(id, uid, owner) {
  if (dbEnabled()) return (await sql('delete from shared_deals where id = $1 and ($2 or firebase_uid = $3) returning id', [id, owner, uid])).length > 0;
  return update((all) => {
    const i = all.findIndex((p) => p.id === id && (owner || p.uid === uid));
    if (i >= 0) all.splice(i, 1);
    return i >= 0;
  });
}

// What visitors get: no account ids, plus the discount and whether this caller may delete it.
const publicPost = (p, uid, owner) => ({
  id: p.id,
  title: p.title,
  store: p.store,
  price: p.price,
  regularPrice: p.regularPrice,
  discountPct: p.price != null && p.regularPrice ? Math.round((1 - p.price / p.regularPrice) * 100) : null,
  validUntil: endOfDay(p.validUntil),
  url: p.url,
  note: p.note,
  author: p.author,
  createdAt: p.createdAt,
  canDelete: owner || (uid != null && p.uid === uid),
});

const handle = (fn) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await fn(req, res);
  } catch (e) {
    console.error('[shared]', e.message);
    res.status(503).json({ error: "Couldn't reach the shared deals right now. Please try again in a moment." });
  }
};

sharedRouter.get('/api/shared', handle(async (req, res) => {
  const claims = await callerOf(req);
  const owner = claims ? await isOwner(req) : false;
  const posts = await livePosts();
  res.json({ posts: posts.map((p) => publicPost(p, claims?.sub ?? null, owner)), signedIn: Boolean(claims) });
}));

sharedRouter.post('/api/shared', requireUser, shareLimit, express.json({ limit: '8kb' }), handle(async (req, res) => {
  const post = postFrom(req.body);
  if (post.error) return res.status(400).json({ error: post.error });
  if ((await liveCount(req.user.uid)) >= MAX_LIVE_PER_USER)
    return res.status(429).json({ error: `You already have ${MAX_LIVE_PER_USER} shared deals running. Delete one, or wait until one ends.` });
  const saved = await addPost(req.user.uid, authorOf(req.user), post);
  res.status(201).json({ post: publicPost(saved, req.user.uid, req.user.role === 'owner') });
}));

sharedRouter.delete('/api/shared/:id', requireUser, handle(async (req, res) => {
  const ok = await removePost(req.params.id, req.user.uid, req.user.role === 'owner');
  if (!ok) return res.status(404).json({ error: 'That shared deal is gone already, or it isn’t yours.' });
  res.status(204).end();
}));
