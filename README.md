# iPromotion

<img src="public/logo.svg" width="64" alt="iPromotion logo" />

This week's discounts from supermarkets, clothing, sports and electronics stores and fast-food
chains around Oulu, in one site with store and category filters, favorites, and a tool that reads
expiry dates from product photos.

Node.js (ESM) · Express 5 · Playwright · cheerio · PostgreSQL. No build step, no frontend framework.

## Sections

| Page | What it shows |
| --- | --- |
| **/promotions** (also `/`) | Groceries: Tokmanni, K-Supermarket, K-Citymarket, Prisma and Lidl, plus links to each store's weekly brochure |
| **/clothing** | Sale clothing and shoes: XXL, Intersport, Stadium, KappAhl and New Yorker; sale-page links for H&M and Lindex |
| **/electronics** | Campaign and clearance deals: Power, Verkkokauppa.com and Gigantti |
| **/food** | Hesburger and Burger King campaigns (read by the campaign analyst), live Wolt offers near you, links to McDonald's and Subway |
| **/favorites** | Deals from every starred (☆) category across sections |
| **/follow** | *Follow your discount* (signed in): photograph labels and the use-by / best-before dates go on a calendar |
| **/pricing** | Photo checks for *Follow your discount*: free checks, packs and Unlimited, paid with Stripe |
| **/dashboard** | Status of each store's crawler, deal counts, refresh history and the next scheduled run |

Each section has search, store and category filters and sorting. Deals load only when a section is
opened, and an unchanged section costs an empty `304 Not Modified`.

## Run locally

```bash
npm install            # also downloads headless Chromium
cp .env.example .env   # then fill in what you need (see Configuration)
docker compose up -d   # optional: Postgres on port 5434 for accounts, favorites and expiry dates
npm start              # http://localhost:3000; crawls on first start, then on the schedule
npm run crawl          # one-off crawl: all stores, or `-- --segment food,clothing`
```

Without a database the site still runs: favorites stay in the browser and there are no accounts.
`npm run crawl` exits with code 1 if any store failed (that store keeps its previous deals).

## Configuration

Stores, schedules and limits are in `config.js`. Secrets and deployment settings come from
environment variables (`.env` locally, which is git-ignored; see `.env.example`):

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | PostgreSQL: accounts, favorites, expiry dates, shared rate limits (and all data when `DATA_STORE=postgres`) |
| `DATA_STORE` | `postgres` online: deals and status live in the database instead of `data/` |
| `OWNER_EMAIL` | The one account allowed to start refreshes. **Not set = nobody is owner.** |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | Sign in with Google (public web settings) |
| `NUXT_HF_TOKEN`, `NUXT_HF_MODEL` | Hugging Face: campaign analyst for the Food section |
| `NUXT_HF_VISION_MODEL` | Hugging Face vision model for *Follow your discount* (has a default) |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Online only: the Refresh button starts the GitHub Actions crawl |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL` | Payments for photo checks (`/pricing`); without them Buy is disabled |
| `PORT`, `CRON_SCHEDULE`, `FOOD_CRON_SCHEDULE`, `CRAWL_CONCURRENCY`, `REFRESH_COOLDOWN_MINUTES` | Optional overrides |

## Accounts and security

- **Sign-in** is Google via Firebase Authentication, all in the browser (`public/auth.js`). Each
  request that needs an account carries the Firebase ID token. The server verifies its RS256
  signature against Google's certificates, plus audience, issuer and expiry (`src/auth.js`, no
  `firebase-admin`).
- **Roles:** everyone who signs in is saved in the `users` table as `user`. The single `owner` is
  the account whose *verified* Google email matches `OWNER_EMAIL`. The address is configured per
  environment and never committed. Only the owner sees and can use the Refresh buttons; the
  server checks the role again on every refresh (401 signed out, 403 otherwise).
- **Favorites** follow the account across devices (`favorites` table). Signed out, they stay in the
  browser and are merged into the account at sign-in.
- **Expiry dates** belong to the signed-in user (`expiry_entries` table). Photos are shrunk in
  the browser, sent once to the vision model and never stored.
- **Photo checks** (`src/credits.js`): every account gets 3, then +1 a week. A check is used
  only when a date is found (one is reserved before the AI runs, so parallel checks can't overdraw,
  and given back otherwise). Packs (10 for €8.99, 25 for €14.99) and Unlimited (30 days, €24.99,
  fair use 100 a day) are one-time Stripe Checkout payments. The webhook verifies Stripe's
  signature, checks the amount against the plan, and grants each session once. Card details never
  reach the server. Plans are in `config.credits`.
- **Rate limits** per IP (`rateLimits` in `config.js`) return `429` with `Retry-After`. The limits
  on costly work (refreshes, new Wolt areas, photo checks, the daily photo cap per user) are
  counted in the database, so they hold across server instances. A store refreshed in the last
  `refreshCooldownMinutes` is skipped.
- **Output:** everything scraped is HTML-escaped, and links and images must be `http(s)`.
  Unexpected errors are logged on the server and answered with plain words, never a stack trace.
  Online, Vercel adds `nosniff`, `X-Frame-Options: DENY`, a referrer policy and a permissions
  policy (`vercel.json`).
- Crawlers identify as a normal browser and never try to get around bot protection. Stores that
  block automated visitors get a link card only.

## Database

The schema is in `src/db/schema.sql` and is applied on start (idempotent).

| Table | Rows |
| --- | --- |
| `users` | One per signed-in Google account: `firebase_uid`, email, name, photo, `role` (at most one owner) |
| `favorites` | `(user_id, segment, category)`; deleted together with the user |
| `expiry_entries` | One per saved date: `firebase_uid`, `kind` (`use_by` / `best_before`), date, product, location |
| `rate_counters` | Shared request counters: `key`, `count`, `reset_at` |
| `credits` | Per account: photo checks left, `unlimited_until`, last weekly grant |
| `credit_ledger` | Every change to checks: signup, weekly, scan, purchase, refund |
| `purchases` | Paid Stripe Checkout sessions (one row each; makes the webhook safe to repeat) |
| `kv` | Online only: one JSON document per former `data/` file (`deals-<section>.json`, `status.json`, caches, crawl progress) |

## Deploy online (free tiers: Vercel + Neon + GitHub Actions)

| Part | Runs on | Notes |
| --- | --- | --- |
| Website + API | **Vercel**, region `fra1` | `public/` from the CDN; `/api/*` is the Express app as one function (`api/index.js`, `vercel.json`) |
| Database | **Neon** Postgres (Vercel Marketplace, Frankfurt) | Pooled `DATABASE_URL` |
| Crawling | **GitHub Actions** | `.github/workflows/crawl.yml`: Wednesdays (all but Food), daily (Food), and the owner's Refresh button |
| Wolt lookups | Vercel function | Chromium from `@sparticuz/chromium`; ~50 s for a new area, then cached per area in the database |

One-time setup:
1. **Vercel**: import the repository (or `vercel link`).
2. **Neon**: add it from the Vercel Marketplace (Storage → Neon, Frankfurt). It sets `DATABASE_URL`.
3. **Vercel environment variables** (Production and Preview): `DATA_STORE=postgres`,
   `OWNER_EMAIL` (mark it *sensitive*), the four `FIREBASE_*`, `NUXT_HF_TOKEN`, `NUXT_HF_MODEL`,
   `GITHUB_REPO`, and `GITHUB_TOKEN` (fine-grained, this repository only, **Actions: Read and
   write**).
4. **GitHub → Settings → Secrets and variables → Actions**: `DATABASE_URL`, `NUXT_HF_TOKEN`,
   `NUXT_HF_MODEL`.
5. **Firebase console → Authentication → Settings → Authorized domains**: add the Vercel domain.
6. Optional: copy local data in with `vercel env pull .env.production.local` and
   `node --env-file=.env.production.local scripts/import-data.js`.
7. Run the "Crawl stores" workflow once from the Actions tab, then open `/api/health`. It should
   return `{"ok":true,"db":true,"lastCrawl":…}`, or 503 if the database is unreachable.

Online, a Refresh click starts the GitHub job (it starts in ~30 s; a full crawl takes a few minutes)
and the buttons show "Refreshing…" meanwhile. A run where a store fails ends red, so GitHub emails
you.

## How the stores are read

| Store | Method |
| --- | --- |
| Tokmanni | Plain HTTP + cheerio over `/viikkotarjoukset/<category>?p=N` |
| K-Supermarket / K-Citymarket | Headless Chromium loads the flyer and captures `/kr-api/raw-offer/product-map` |
| Prisma | Headless Chromium picks the branch as pickup point, then pages through `/hakutulokset?label=DISCOUNTED` |
| Lidl | Plain HTTP: this week's campaign pages, product JSON in `data-grid-data` |
| XXL | Headless Chromium on `/kampanjat`, pages through its product search; clothing and shoes only |
| Intersport | Headless Chromium on the sale pages, clicks "Näytä enemmän" until everything is loaded |
| Stadium | Headless Chromium on the sale tag, clicks "Lataa lisää"; discounted clothing and shoes only |
| KappAhl | Plain HTTP over `/kappahl-outlet?page=N`, product JSON in `window.CURRENT_PAGE` |
| New Yorker | Plain HTTP over the public catalog with the SALE filter |
| Power | Headless Chromium captures the page's own `/api/v2/productlists` calls |
| Verkkokauppa.com | Headless Chromium captures the page's own discount search |
| Gigantti | Headless Chromium captures the page's own product search on `/kampanja` |
| Hesburger, Burger King | Plain HTTP: homepage campaign banners and offer pages, read by the campaign analyst |
| Wolt (live) | Not crawled: when Food opens, the browser's location (rounded to ~1 km) goes to `GET /api/wolt`, and headless Chromium reads wolt.com's "Offers near you" as a logged-out visitor. Without a location: Oulu city center |

- Stores are crawled in parallel (`concurrency`), so a refresh takes about as long as the slowest
  store. If a store fails, its previous deals are kept.
- Each store's categories are mapped to one shared list per section (`src/categories.js`).
- **Campaign analyst** (`src/analyst.js`): banner text goes to an LLM, which returns whether it is
  a real offer, plus an English title, price, discount, validity, channel and category. Results
  are cached per banner text, so unchanged banners never call the model again. Without a token the
  banners still show, unanalysed.
- **Schedule:** every Wednesday at 06:00 for all sections except Food, which runs daily at 09:00
  (Europe/Helsinki). The owner can refresh a section or everything at any time.

## Project layout

```
config.js            stores, schedules, limits
src/server.js        Express app and API routes
src/crawl.js         crawl runner (worker pool, progress, CLI)
src/crawlers/        one file per store type
src/store.js         data/ files or the kv table
src/db.js            Postgres pool, users, favorites, counters
src/auth.js          Firebase token verification, roles
src/expiry.js        Follow your discount (vision model, saved dates)
src/wolt.js          live Wolt offers
public/              the site (vanilla HTML/CSS/JS)
api/index.js         Vercel entry
scripts/             one-off tools (data import)
```

Pending work is tracked in `docs/ROADMAP.md`.
