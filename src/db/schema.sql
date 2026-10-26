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

-- Starred categories per account (logged-out visitors keep theirs in the browser).
create table if not exists favorites (
  user_id    int  not null references users(id) on delete cascade,
  segment    text not null,                     -- groceries | clothing | electronics | food
  category   text not null,                     -- unified category, e.g. 'Shoes'
  created_at timestamptz not null default now(),
  primary key (user_id, segment, category)
);
