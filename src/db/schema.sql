-- iPromotion database: signed-in users and their favorite categories. Applied on every server start
-- (src/db.js), so every statement must be safe to run again.

create table if not exists users (
  id            serial primary key,
  firebase_uid  text unique not null,          -- Google account id from the Firebase ID token
  email         text unique not null,
  name          text,
  photo_url     text,
  role          text not null default 'user' check (role in ('owner', 'user')),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- At most one owner (the account in OWNER_EMAIL).
create unique index if not exists users_one_owner on users ((role)) where role = 'owner';

-- Deals, status and caches when DATA_STORE=postgres (online: Vercel + GitHub Actions). One row per
-- former data/ file, keyed by its name (e.g. 'deals-food.json', 'status.json'); src/store.js.
create table if not exists kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Starred categories per account (logged-out visitors keep theirs in the browser).
create table if not exists favorites (
  user_id    int  not null references users(id) on delete cascade,
  segment    text not null,                     -- groceries | clothing | electronics | food
  category   text not null,                     -- unified category, e.g. 'Shoes'
  created_at timestamptz not null default now(),
  primary key (user_id, segment, category)
);

-- "Follow your discount" dates per signed-in user (src/expiry.js). One row per date, so requests on
-- different function instances can't overwrite each other's changes.
create table if not exists expiry_entries (
  id           uuid primary key,
  firebase_uid text not null,
  kind         text not null check (kind in ('use_by', 'best_before')),
  date         date not null,
  product      text not null,
  location     text,
  added_at     timestamptz not null default now()
);
create index if not exists expiry_entries_uid on expiry_entries (firebase_uid, date);

-- Request counters shared by every server instance, for the limits that guard costly work
-- (refreshes, Wolt lookups, photo checks) and the daily photo-check cap (src/rateLimit.js).
create table if not exists rate_counters (
  key      text primary key,
  count    int not null,
  reset_at timestamptz not null
);

-- "Follow your discount" checks (src/credits.js). Each account starts with 3 and gets 1 more every
-- week; packs add more; Unlimited is a 30-day pass. A check costs 1 only when a date is found.
create table if not exists credits (
  user_id         int primary key references users(id) on delete cascade,
  balance         int not null default 3 check (balance >= 0),
  unlimited_until timestamptz,
  weekly_at       timestamptz not null default now(), -- last weekly grant (or sign-up)
  created_at      timestamptz not null default now()
);

-- The starting balance comes from config.credits.freeChecks (src/credits.js); keep the default in step.
alter table credits alter column balance set default 3;

-- Every change to a balance, for support questions and refunds.
create table if not exists credit_ledger (
  id         bigserial primary key,
  user_id    int not null references users(id) on delete cascade,
  delta      int not null,                      -- +n checks, or days for unlimited (reason purchase)
  reason     text not null,                     -- signup | weekly | purchase | scan | refund
  ref        text,                              -- Stripe session id, plan…
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user on credit_ledger (user_id, created_at desc);

-- Paid Stripe Checkout sessions. The primary key makes the webhook safe to repeat.
create table if not exists purchases (
  session_id   text primary key,
  user_id      int not null references users(id) on delete cascade,
  plan         text not null,
  amount_cents int not null,
  currency     text not null,
  created_at   timestamptz not null default now()
);
