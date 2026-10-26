import fs from 'node:fs/promises';
import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

// PostgreSQL for accounts: users (with role), their favorite categories and expiry dates, plus shared
// rate-limit counters. Deals stay in the JSON files (src/store.js) unless DATA_STORE=postgres.
// Everything here needs DATABASE_URL; without it the site still runs, just without accounts
// (favorites stay in the browser and nobody is owner).
//
// Local: `docker compose up -d` (docker-compose.yml). Production: a hosted Postgres such as Neon;
// SSL is turned on when the URL asks for it (sslmode=require).

const url = process.env.DATABASE_URL;
const pool = url
  ? new pg.Pool({
      connectionString: url,
      ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 10_000, // hand idle connections back soon (Neon's pooler has a cap)
      connectionTimeoutMillis: 5_000,
    })
  : null;
pool?.on('error', (e) => console.error('[db]', e.message)); // idle client dropped; the pool reconnects
// On Vercel, lets a function instance close idle clients before it is suspended.
if (pool && process.env.VERCEL) attachDatabasePool(pool);

export const dbEnabled = () => Boolean(pool);
const OWNER_EMAIL = () => (process.env.OWNER_EMAIL || 'ddkhoa97@gmail.com').trim().toLowerCase();

// Creates the tables if they don't exist yet. Call once before serving.
export async function initDb() {
  if (!pool) return false;
  await pool.query(await fs.readFile(new URL('./db/schema.sql', import.meta.url), 'utf8'));
  return true;
}

export const query = (text, params) => pool.query(text, params);

// Counts one request against `key` in a fixed window shared by every server instance; returns the
// count so far and when the window ends. Expired windows restart at 1.
export async function hit(key, windowMs) {
  await ensureDb();
  const { rows } = await pool.query(
    `insert into rate_counters (key, count, reset_at) values ($1, 1, now() + $2 * interval '1 millisecond')
     on conflict (key) do update set
       count    = case when rate_counters.reset_at <= now() then 1 else rate_counters.count + 1 end,
       reset_at = case when rate_counters.reset_at <= now() then excluded.reset_at else rate_counters.reset_at end
     returning count, reset_at`,
    [key, windowMs],
  );
  // Now and then, forget finished windows so the table stays small.
  if (Math.random() < 0.01) pool.query('delete from rate_counters where reset_at < now()').catch(() => {});
  return { count: rows[0].count, resetAt: rows[0].reset_at.getTime() };
}

// ── Key/value documents (src/store.js when DATA_STORE=postgres) ─────────────────────────────────
let ready = null;
export const ensureDb = () => (ready ??= initDb().catch((e) => ((ready = null), Promise.reject(e))));

export async function kvGet(key) {
  await ensureDb();
  const { rows } = await pool.query('select value, updated_at from kv where key = $1', [key]);
  return rows[0] ? { value: rows[0].value, updatedAt: rows[0].updated_at } : null;
}

export async function kvSet(key, value) {
  await ensureDb();
  await pool.query(
    `insert into kv (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// Saves (or refreshes) the signed-in user from their verified token claims and returns the row.
// The account whose verified email is OWNER_EMAIL becomes the owner; everyone else is a user.
export async function upsertUser(claims) {
  const email = String(claims.email ?? '').toLowerCase();
  if (!email) throw new Error('Account has no email');
  const role = claims.email_verified && email === OWNER_EMAIL() ? 'owner' : 'user';
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (role === 'owner') await client.query(`update users set role = 'user' where role = 'owner' and firebase_uid <> $1`, [claims.sub]);
    const { rows } = await client.query(
      `insert into users (firebase_uid, email, name, photo_url, role)
       values ($1, $2, $3, $4, $5)
       on conflict (firebase_uid) do update
         set email = excluded.email, name = excluded.name, photo_url = excluded.photo_url,
             role = excluded.role, last_login_at = now()
       returning id, email, name, photo_url, role`,
      [claims.sub, email, claims.name ?? null, claims.picture ?? null, role],
    );
    await client.query('commit');
    return rows[0];
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function getUserByUid(uid) {
  const { rows } = await pool.query('select id, email, name, photo_url, role from users where firebase_uid = $1', [uid]);
  return rows[0] ?? null;
}

// { groceries: ['Bread & bakery'], clothing: ['Shoes'], … }
export async function listFavorites(userId) {
  const { rows } = await pool.query('select segment, category from favorites where user_id = $1 order by segment, category', [userId]);
  const out = {};
  for (const r of rows) (out[r.segment] ??= []).push(r.category);
  return out;
}

export async function addFavorite(userId, segment, category) {
  await pool.query('insert into favorites (user_id, segment, category) values ($1, $2, $3) on conflict do nothing', [userId, segment, category]);
}

export async function removeFavorite(userId, segment, category) {
  await pool.query('delete from favorites where user_id = $1 and segment = $2 and category = $3', [userId, segment, category]);
}

// Adds a set of favorites (the browser's, at sign-in) to the account; existing ones are kept.
export async function mergeFavorites(userId, map) {
  const pairs = Object.entries(map).flatMap(([segment, cats]) => cats.map((c) => [segment, c]));
  if (pairs.length) {
    await pool.query(
      `insert into favorites (user_id, segment, category)
       select $1, s, c from unnest($2::text[], $3::text[]) as t(s, c)
       on conflict do nothing`,
      [userId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
  }
  return listFavorites(userId);
}
