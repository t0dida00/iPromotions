# iPromotion roadmap: clothing, sports & electronics deals

> **Status (26 Oct 2026):** Cloth Promotions (XXL, Intersport, Stadium, KappAhl, New Yorker) and
> Electronics Promotions (Power, Verkkokauppa.com, Gigantti) are built. H&M and Lindex remain
> link-only (bot protection). Still open: the SQLite/paged API step, price history and alerts.

Goal: add sale/campaign products from fashion, sports and electronics chains around Oulu
(home area 90570 Linnanmaa/Kaijonharju) next to the existing grocery deals.

## What the site checks showed (26 Oct 2026)

| Store | Segment | Sale page | How it serves data | Feasibility | Oulu store |
|---|---|---|---|---|---|
| **Gigantti** | Electronics | `gigantti.fi/kampanja`, `/outlet` | Client-rendered, products via Algolia (page fetches a signed key) | Medium: headless browser, capture JSON | Kallisensuora 12, 90400 ✅ |
| **Power** | Electronics | `power.fi/tarjoukset/kampanja/`, `/varastontyhjennys/`, `/outlet/` | Server-rendered + own `/api/v2` | Easy–medium | Limingantulli, Nuottasaarentie 4 (to verify) |
| **Verkkokauppa.com** | Electronics | `verkkokauppa.com/fi/tarjoukset` (+ per-category `/tarjoukset`) | Server-rendered + `api.verkkokauppa.com` | Easy–medium | Online + pickup (to verify) |
| **XXL** | Sports & clothing | `xxl.fi/kampanjat`, `?cid=outlet` | Server-rendered + `api.xxlsports.com` product API | Easy–medium | Limingantulli, Alasintie 8 ✅ |
| **Intersport** | Sports & clothing | `intersport.fi/fi/ale/…` | Server-rendered | Easy | Several in Oulu (to verify) |
| **Stadium** | Sports & clothing | `stadium.fi/tag/alehintaiset-tuotteet` | Client-rendered | Medium: headless | To verify |
| **KappAhl** | Clothing | `kappahl.com/fi-fi/tarjoukset`, outlet | Server-rendered | Easy–medium | To verify |
| **New Yorker** | Clothing | No sale link on the FI home page | Public JSON API (`api.newyorker.de`) | Medium: find the sale endpoint | To verify (Valkea?) |
| **H&M** | Clothing | — | **Blocks automated browsers (403)** | Brochure/link only | To verify (Valkea?) |
| **Lindex** | Clothing | — | **Blocks automated browsers (403)** | Brochure/link only | To verify |

Other good candidates in Oulu: Clas Ohlson, Jysk, Motonet, Biltema, Puuilo, Dressmann, Cubus.

### Key finding: prices are national
Unlike groceries (Prisma/K prices differ per branch), these chains price the same online and in
store (Power's tagline literally says so). So:
- Crawl **national** campaign pages; no branch selection is needed.
- "Around Oulu 90570" becomes **store info**: nearest Oulu store, address, and where the site
  exposes it, *in-stock in Oulu* (Gigantti and Power show store stock).

Sites that block bots (H&M, Lindex) get a **brochure/sale-page link card only**. We do not try
to get around bot protection.

## Changes needed in the app

1. **Segments.** Add `segment: 'groceries' | 'fashion' | 'electronics'` to each store in
   `config.js`. The sidebar gets one section per segment (*Groceries*, *Fashion & Sports*,
   *Electronics*), each with the existing brochures/tabs/categories/favorites UI. The Dashboard
   groups services by segment.
2. **Storage and API.** Electronics and fashion sales can reach 10–30k products, too much to
   send to the browser as one JSON file. Move to **SQLite** (`better-sqlite3`) and add
   `GET /api/deals?segment=&store=&group=&q=&sort=&page=` with server-side filtering and
   paging. Category counts come from the same query.
3. **Categories per segment.** Extend `src/categories.js` with segment rule sets:
   - Fashion: Women · Men · Kids · Shoes · Sportswear · Outdoor · Accessories.
   - Electronics: Phones · Computers · TV & audio · Gaming · Smart home · Home appliances · Photo.
4. **Noise control.** Each chain's sale has thousands of items. Add an optional per-store
   `minDiscount` (e.g. 20%), merge colour/size variants into one card ("3 colours"), and
   default the sort to biggest saving in €.
5. **Per-segment schedule.** Electronics campaigns change often (daily at 06:00); fashion and
   sports weekly. Store `schedule` overrides the global cron. The worker pool already crawls in
   parallel.
6. **Crawler guard rails.** Respect each site's `robots.txt`, one request at a time per site with
   a delay, run at most daily, and identify the crawler. Add a saved-page **fixture test** per
   crawler so a site redesign shows up as a failing test, not as an empty store.

## Phases

| Phase | Scope | Size |
|---|---|---|
| **0. Foundation** | Segments + sidebar sections, SQLite + paged API, segment categories, crawler fixture tests | ~2 days |
| **1. Electronics** | Power, Verkkokauppa.com, Gigantti (+ Oulu stock where available) | ~1 day each |
| **2. Sports & clothing** | XXL, Intersport, KappAhl, Stadium, New Yorker | ~0.5–1 day each |
| **3. Link-only stores** | H&M, Lindex (+ any store that blocks bots) as sale-page cards | ~1 hour |
| **4. Extras** | Price history per product ("lowest price in 30 days", spotting fake discounts) · watchlist with alerts when a favourite drops in price · Oulu store map/distance from 90570 · optional AI for categories/English names | pick per need |

Suggested order: Phase 0 → Power and Verkkokauppa.com (easiest, biggest value) → XXL and
Intersport → Gigantti and Stadium (need a headless browser) → Phase 4.

## Decisions to make

1. Separate sidebar section per segment, or one Market Promotions page with a segment switch?
2. Minimum discount to show (all sale items, or e.g. ≥ 20%)?
3. Which stores first?
4. Keep running on this Mac, or host it (always-on server, e.g. a small VPS or Vercel cron +
   database) so the schedule runs while the laptop is off?
