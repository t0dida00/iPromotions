# iPromotion

<img src="public/logo.svg" width="64" alt="iPromotion logo" />

Crawls this week's discounted products from Tokmanni, K-Supermarket Kaijonharju, K-Citymarket
Raksila (K-Ruoka), Prisma Linnanmaa (S-kaupat) and Lidl on a cron schedule, and shows them all in one
page with store and category filters. A "Weekly brochures" section links to each store's own
flyer. Lidl deals come from this week's campaign pages on lidl.fi.

## Campaign analyst (Food section)

Fast-food campaigns come from each chain's homepage **hero banners**. `src/analyst.js` sends the
text around each banner (headline, terms, link, landing-page title/description) to an LLM on
Hugging Face and gets back: is it a real offer, English title and summary, price, discount,
validity dates, channel (e.g. "Wolt & Uber Eats only") and category. Non-offers (restaurant
finder, loyalty sign-up) are dropped. Results are cached per banner text in
`data/analyst-cache.json`, so unchanged banners never call the model again.

Set the key in `.env` (git-ignored; see `.env.example`):

```
NUXT_HF_TOKEN=hf_…
NUXT_HF_MODEL=openai/gpt-oss-120b
```

The default model is text-only, so it reads the text around a banner, not the picture. Without a
token the banners still show, with their raw headline and no analysis.

## Run locally

```bash
npm install        # also downloads headless Chromium for the K-Ruoka / S-kaupat crawlers
npm start          # http://localhost:3000 — crawls on first start, then every Wednesday 06:00 (Food Promotions: daily 09:00)
npm run crawl      # one-off crawl from the terminal
```

## Deploy online (free: Vercel + Neon + GitHub Actions)

| Part | Runs on | Notes |
| --- | --- | --- |
| Website + API | **Vercel** (Hobby, free for personal use) | `public/` from the CDN; `/api/*` is the Express app as one function (`api/index.js`, `vercel.json`) |
| Data | **Neon** Postgres (free) | users, favorites, and deals/status/caches in the `kv` table (`DATA_STORE=postgres`) |
| Crawling | **GitHub Actions** (free minutes) | `.github/workflows/crawl.yml`: Wednesdays (all but Food), daily (Food), and the owner's Refresh button |
| Wolt lookups | Vercel function | Chromium from `@sparticuz/chromium`; results cached per area in the database |

One-time setup:
1. **Neon** (neon.tech): create a project, copy the **pooled** connection string
   (`…-pooler…/neondb?sslmode=require`).
2. Copy today's data in: `DATABASE_URL='<neon url>' node scripts/import-data.js`.
3. **GitHub token** (Settings → Developer settings → Fine-grained tokens): only this repository,
   permission **Actions: Read and write**.
4. **Vercel** → Add New Project → import `t0dida00/iPromotions` → Environment Variables:
   `DATA_STORE=postgres`, `DATABASE_URL`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`,
   `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `OWNER_EMAIL`, `NUXT_HF_TOKEN`, `NUXT_HF_MODEL`,
   `NUXT_HF_VISION_MODEL` (if used), `GITHUB_TOKEN`, `GITHUB_REPO=t0dida00/iPromotions` → Deploy.
5. **GitHub repo → Settings → Secrets and variables → Actions**: `DATABASE_URL`, `NUXT_HF_TOKEN`,
   `NUXT_HF_MODEL`.
6. **Firebase console → Authentication → Settings → Authorized domains**: add your
   `<project>.vercel.app` domain, or Google sign-in fails there.
7. Actions tab → "Crawl stores" → Run workflow, to check the crawler can write to Neon.

Online, a Refresh click starts the GitHub job (starts in ~30 s, a full crawl takes a few minutes);
the buttons show "Refreshing…" meanwhile. Rate limits are per function instance there (best effort).
Locally nothing changes: files in `data/`, in-process crawls and cron.

## How it works

| Source | Method |
| --- | --- |
| Tokmanni | Plain HTTP + cheerio over `/viikkotarjoukset/<category>?p=N` |
| K-Supermarket / K-Citymarket | Headless Chromium loads the flyer and captures `/kr-api/raw-offer/product-map` |
| Lidl | Plain HTTP: this week's dated campaign pages from the homepage, product JSON in `data-grid-data` |
| XXL (clothing) | Headless Chromium opens `/kampanjat`, then pages through its product search (36 per request); keeps clothing & shoes only |
| Intersport (clothing) | Headless Chromium on the clothing and shoe sale pages, clicks "Näytä enemmän" until all tiles are loaded |
| KappAhl (clothing) | Plain HTTP over `/kappahl-outlet?page=N`, product JSON in `window.CURRENT_PAGE` |
| New Yorker (clothing) | Plain HTTP over the public catalog listing with the SALE filter (women + men); in-store prices |
| Stadium (clothing) | Headless Chromium on the sale tag, clicks "Lataa lisää" (~96 per click); keeps discounted items whose name identifies clothing/shoes |
| Power (electronics) | Headless Chromium captures the page's own `/api/v2/productlists` request on the campaign and clearance lists and pages through it |
| Verkkokauppa.com (electronics) | Headless Chromium captures the page's own discount search (`has_discount=true`) and pages through it |
| Gigantti (electronics) | Headless Chromium captures the page's own product search on `/kampanja` and pages through it |
| Hesburger (food) | Plain HTTP: homepage hero carousel; each banner's link is followed and the landing page text is given to the campaign analyst |
| Burger King (food) | Plain HTTP: homepage hero blocks plus the offer blocks on `/tarjoukset/` (headline, terms, links), given to the campaign analyst |
| Wolt (food, live) | Not crawled: when Food Promotions opens, the browser shares its location (rounded to ~1 km) with `GET /api/wolt`; headless Chromium opens wolt.com, sets that location with the site's own "Share location" button and reads the "Offers near you" list it loads. Restaurants only, as a logged-out visitor, so only offers open to everyone (no Wolt+ deals). Cached per area for 30 min; one lookup at a time; new areas limited to 6 per 10 min per IP. Location not shared → Oulu city center (`wolt` in `config.js`) |
| Prisma | Headless Chromium picks the branch as pickup point, then pages through `/hakutulokset?label=DISCOUNTED` |

- All stores are crawled in parallel (`concurrency` in `config.js`, or `CRAWL_CONCURRENCY`), so a
  refresh takes about as long as the slowest store (~45s) instead of the sum.
- Results are stored as JSON, one file per section, so the page downloads a section only when
  it is opened (and gets a cheap `304 Not Modified` when it hasn't changed):
  - `data/deals-groceries.json`, `-clothing`, `-electronics`, `-food`
  - `data/status.json` — store status, deal counts, refresh history (used by the dashboard)
  Files are written to a temp file and renamed, so a crash can't leave a half-written file. If a
  store fails, its previous deals are kept.
- Each store's own categories are mapped to one shared list in `src/categories.js`.
- Stores, schedule and port are in `config.js` (`CRON_SCHEDULE` / `PORT` env vars also work). Sections in
  `sectionSchedules` run on their own schedule instead: Food Promotions is refreshed every day at 09:00
  (`FOOD_CRON_SCHEDULE`); the weekly run covers the other sections.
- Accounts (PostgreSQL): everyone who signs in with Google is saved in the `users` table with a
  role: one `owner` (the verified email in `OWNER_EMAIL`, default `ddkhoa97@gmail.com`) and `user`
  for everyone else. Starred categories are saved per account (`favorites` table), so they follow
  you across devices; logged out they stay in the browser, and they're merged into the account at
  sign-in. Set `DATABASE_URL` in `.env` (local: `docker compose up -d`, Postgres on port 5434;
  production: a hosted Postgres such as Neon with `?sslmode=require`). Without it the site still
  runs, with favorites in the browser only.
- Only the owner can refresh: the Refresh buttons show only for the owner, and `POST /api/crawl`
  checks the signed-in user's Google token and role on the server (401 signed out, 403 for other
  accounts). The weekly schedule is unaffected.
- Refreshing is per section: each section's "Refresh now" and the Dashboard's "Refresh section"
  crawl only that section's stores (`POST /api/crawl?segment=clothing`); "Refresh all" (no
  parameters) crawls everything. Other stores keep their current deals; a
  request made while a crawl runs is queued and starts right after it. Repeated clicks can't
  hammer the stores: a store that is already refreshing, or was refreshed in the last
  `refreshCooldownMinutes` (default 10), is skipped and the button shows when it's available.
- Per-IP rate limits against bots (`rateLimits` in `config.js`, code in `src/rateLimit.js`):
  refresh requests 5 per 10 min, other `/api` calls 120 per min, pages/files 600 per min. Over the
  limit the server answers `429 Too Many Requests` with `Retry-After`, and logs the address once.
  Counters are in memory and reset on restart. Behind a reverse proxy, enable
  `app.set('trust proxy', 1)` in `src/server.js` so limits apply to the visitor's IP.

## Sign in with Google

The sidebar has a "Login" button that opens a "Sign in with Google" dialog. Sign-in runs in the
browser with Firebase Authentication (`public/auth.js`, SDK loaded from gstatic); the server only
serves the Firebase web settings from `.env` (`GET /api/auth-config`, `src/auth.js`). To enable it,
turn on the Google provider in the Firebase console, make sure your domain is an authorized domain,
and set `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` and `FIREBASE_APP_ID`
(see `.env.example`). Without them the dialog shows the Google button disabled. Signing in only
identifies the user for now; no page requires it.

## Pages

- **/dashboard** — crawler ("service") status per store, latest and next refresh, deal counts,
  average discount, crawl durations and the last 20 refreshes (`GET /api/status`).
- **/clothing** — Cloth Promotions: sale products from XXL, Intersport, Stadium, KappAhl and New Yorker
  in 12 clothing categories, plus sale-page links for H&M and Lindex (they block automated browsers). Stores are assigned to a
  section with `segment` in `config.js`.
- **/electronics** — Electronics Promotions: campaign and clearance deals from Power,
  Verkkokauppa.com and Gigantti in 12 electronics categories (phones, computers, TV & audio,
  appliances…).
- **/food** — Food Promotions: hero-banner campaigns from Hesburger and Burger King (analysed by the
  campaign analyst), plus
  links to McDonald's (blocks automated visitors) and Subway (anti-bot challenge).
- **/follow** — Follow your discount (signed-in users): photograph product labels and press
  **Mark the dates**. A vision model reads each label's use-by or best-before date (packing dates are
  ignored) and the dates go on a month calendar and an upcoming list, where each entry can get a
  location typed by the user (e.g. which store) and be downloaded as an `.ics` event. Markets often discount meat and other fresh food on that day. Each check is capped at 8 s
  and ~500 tokens; photos are not stored. Uses `NUXT_HF_TOKEN` and `NUXT_HF_VISION_MODEL`.
- **/promotions** (also `/`) — weekly brochure links plus all discounted products, filterable by
  store, category, search and sort. Star (☆) a category to pin it under "Favorites" above
  "All categories"; favorites are saved in the browser.
- **/favorites** — the deals in every starred category from all promotions sections in one page,
  grouped by section (top 20 per section, with a link to the rest), with search and sort. Click a category to open it in its section, or ★ to
  unstar it. The sidebar shows how many categories are starred.
