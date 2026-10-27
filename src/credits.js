import config from '../config.js';
import { withTransaction } from './db.js';

// Checks for "Follow your discount". Each account starts with `freeChecks` and gets `weeklyChecks`
// more every week (added when the balance is next read, so no cron is needed). Packs bought on
// /pricing add checks; Unlimited is a pass until `unlimited_until`. A photo check reserves 1 before
// the model runs (so parallel checks can't overdraw) and gives it back unless a date was found.
// The owner account is never charged.
const { freeChecks, weeklyChecks, plans } = config.credits;
const WEEK_MS = 7 * 86_400_000;

// The account's row, created on first use and topped up with any weekly checks due. Locked for
// the rest of the transaction, so two requests can't add the same week twice.
async function load(client, userId) {
  const created = await client.query(
    'insert into credits (user_id, balance) values ($1, $2) on conflict do nothing returning user_id',
    [userId, freeChecks],
  );
  if (created.rowCount) await ledger(client, userId, freeChecks, 'signup');
  const { rows } = await client.query('select balance, unlimited_until, weekly_at from credits where user_id = $1 for update', [userId]);
  const row = rows[0];
  const weeks = Math.floor((Date.now() - row.weekly_at.getTime()) / WEEK_MS);
  if (weeks > 0) {
    row.balance += weeks * weeklyChecks;
    row.weekly_at = new Date(row.weekly_at.getTime() + weeks * WEEK_MS);
    await client.query('update credits set balance = $2, weekly_at = $3 where user_id = $1', [userId, row.balance, row.weekly_at]);
    await ledger(client, userId, weeks * weeklyChecks, 'weekly');
  }
  return row;
}

const ledger = (client, userId, delta, reason, ref = null) =>
  client.query('insert into credit_ledger (user_id, delta, reason, ref) values ($1, $2, $3, $4)', [userId, delta, reason, ref]);

const unlimitedActive = (row) => Boolean(row.unlimited_until && row.unlimited_until > new Date());

// What the browser shows: { balance, unlimitedUntil, nextFreeAt, owner }.
const view = (row, owner = false) => ({
  balance: row.balance,
  unlimitedUntil: unlimitedActive(row) ? row.unlimited_until.toISOString() : null,
  nextFreeAt: new Date(row.weekly_at.getTime() + WEEK_MS).toISOString(),
  owner,
});

export const getCredits = (user) => withTransaction(async (c) => view(await load(c, user.id), user.role === 'owner'));

// Before a photo check. { ok: true, charged } when it may run (charged = 1 was taken), or
// { ok: false } when the account has no checks left. `credits` is the state afterwards.
export const reserve = (user) =>
  withTransaction(async (c) => {
    const row = await load(c, user.id);
    if (user.role === 'owner' || unlimitedActive(row)) return { ok: true, charged: false, unlimited: unlimitedActive(row), credits: view(row, user.role === 'owner') };
    if (row.balance < 1) return { ok: false, charged: false, credits: view(row) };
    row.balance -= 1;
    await c.query('update credits set balance = $2 where user_id = $1', [user.id, row.balance]);
    return { ok: true, charged: true, credits: view(row) };
  });

// After the check: keep the reserved check when it found something (a date, or deals for an
// assistant question), otherwise give it back. `reason` is recorded in the ledger.
export const settle = (user, reservation, found, reason = 'scan') =>
  withTransaction(async (c) => {
    if (reservation.charged && !found) await c.query('update credits set balance = balance + 1 where user_id = $1', [user.id]);
    else if (reservation.charged) await ledger(c, user.id, -1, reason);
    return view(await load(c, user.id), user.role === 'owner');
  });

// A paid Stripe Checkout session. Safe to call again for the same session (Stripe retries
// webhooks): the purchases primary key lets only the first one through. Returns false if the
// session was already granted.
export const grant = ({ userId, plan, sessionId, amountCents, currency }) =>
  withTransaction(async (c) => {
    const p = plans[plan];
    if (!p) throw new Error(`Unknown plan ${plan}`);
    const fresh = await c.query(
      'insert into purchases (session_id, user_id, plan, amount_cents, currency) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [sessionId, userId, plan, amountCents, currency],
    );
    if (!fresh.rowCount) return false;
    await load(c, userId);
    if (p.checks) await c.query('update credits set balance = balance + $2 where user_id = $1', [userId, p.checks]);
    if (p.days)
      await c.query(
        `update credits set unlimited_until = greatest(now(), coalesce(unlimited_until, now())) + $2 * interval '1 day' where user_id = $1`,
        [userId, p.days],
      );
    await ledger(c, userId, p.checks ?? p.days, 'purchase', `${plan}:${sessionId}`);
    return true;
  });
