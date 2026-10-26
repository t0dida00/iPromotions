import config from '../config.js';
import path from 'node:path';
import { withBrowser, declineCookies } from './browser.js';
import { DATA_DIR, readJson, writeJson, useDb } from './store.js';

// Wolt offers near a location, for the "Wolt offers near you" panel in Food Promotions.
//
// Unlike the stores, Wolt isn't crawled on a schedule: offers depend on where the visitor is, so
// they're looked up when the Food section asks (GET /api/wolt?lat=&lon=). A headless browser opens
// wolt.com, picks the location with the site's own "Share location" button (the browser context
// is given the visitor's coordinates) and reads the "Offers near you" list the page itself loads.
// We browse as a logged-out visitor, so only offers open to everyone are listed — Wolt+ member
// deals aren't shown to logged-out visitors (any offer text naming Wolt+ is dropped as well).

const BASE = 'https://wolt.com/en';
const opts = config.wolt ?? {};
const TTL_MS = (opts.cacheMinutes ?? 30) * 60_000;
const MAX_CACHED = opts.maxCachedLocations ?? 200;

const cache = new Map(); // "lat,lon" (2 decimals, ~1 km) -> { at, data }
const pending = new Map(); // same key -> promise, so simultaneous requests share one lookup
let queue = Promise.resolve(); // one Chromium at a time

// Round to ~1 km so nearby visitors share a lookup (and exact positions aren't kept).
export const areaKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

// Online each function instance has its own memory, so areas are also cached in the database
// (DATA_STORE=postgres), one row per area: wolt-<lat>,<lon>.json.
const sharedFile = (key) => path.join(DATA_DIR, `wolt-${key}.json`);
const fresh = (hit) => (hit && Date.now() - hit.at < TTL_MS ? hit.data : null);

export async function cachedOffers(lat, lon) {
  const key = areaKey(lat, lon);
  const local = fresh(cache.get(key));
  if (local || !useDb()) return local;
  const shared = await readJson(sharedFile(key), null);
  if (fresh(shared)) cache.set(key, shared);
  return fresh(shared);
}

export async function woltOffers(lat, lon, log = console.log) {
  const key = areaKey(lat, lon);
  const hit = await cachedOffers(lat, lon);
  if (hit) return hit;
  if (pending.has(key)) return pending.get(key);
  const [rlat, rlon] = key.split(',').map(Number);
  const job = (queue = queue.catch(() => {}).then(() => lookup(rlat, rlon, log)))
    .then((data) => {
      const entry = { at: Date.now(), data };
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value); // oldest first
      if (useDb()) writeJson(sharedFile(key), entry).catch((e) => console.error('[wolt] cache:', e.message));
      return data;
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function lookup(lat, lon, log) {
  const started = Date.now();
  const body = await withBrowser(
    async (context) => {
      const page = await context.newPage();
      await page.goto(`${BASE}/discovery`, { waitUntil: 'domcontentloaded' });
      const consent = page.locator('[data-test-id="decline-button"]');
      await consent.waitFor({ timeout: 10_000 }).then(() => consent.click()).catch(() => declineCookies(page));

      // Address picker → "Share location" fills in the address for our coordinates → Continue.
      // A "log in" pop-up sometimes opens a moment later and covers the page; close it and retry.
      const picker = page.locator('[data-test-id="header.address-select-button"]').first();
      for (let attempt = 1; ; attempt++) {
        await closePopups(page);
        try {
          await picker.click({ timeout: 4000 });
          break;
        } catch (e) {
          if (attempt === 4) throw e;
        }
      }
      await page.locator('[data-test-id="share-location"]').click({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('[data-test-id="address-query-input"]')?.value, null, { timeout: 10_000 }).catch(() => {});
      await page.locator('[data-test-id="continue-button"]').click({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      const address = (await page.locator('[data-test-id="header.address-select-button"]').first().textContent().catch(() => ''))?.trim();

      const res = page.waitForResponse((r) => r.url().includes('/pages/venue-list/promotions-near-you'), { timeout: 30_000 });
      await page.goto(`${BASE}/discovery/promotions-near-you`, { waitUntil: 'domcontentloaded' });
      const r = await res;
      if (!r.ok()) throw new Error(`Wolt offers list answered ${r.status()}`);
      // Make sure Wolt really used our location, not its IP-based guess.
      const u = new URL(r.url());
      const dist = Math.hypot(Number(u.searchParams.get('lat')) - lat, Number(u.searchParams.get('lon')) - lon);
      if (!(dist < 0.05)) throw new Error('Wolt did not accept the location (page layout may have changed)');
      return { json: await r.json(), address };
    },
    { locale: 'en-US', geolocation: { latitude: lat, longitude: lon }, permissions: ['geolocation'] },
  );

  const venues = parse(body.json);
  log(`  wolt: ${venues.length} restaurants with offers near ${body.address || areaKey(lat, lon)} (${Math.round((Date.now() - started) / 1000)}s)`);
  return { location: { lat, lon, address: body.address || null }, fetchedAt: new Date().toISOString(), venues };
}

async function closePopups(page) {
  const close = page.locator('[data-test-id="modal-close-button"]');
  if (await close.first().isVisible().catch(() => false)) await close.first().click().catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

const WOLT_PLUS = /wolt\s*\+|wolt\s*plus/i;

// Restaurants only (the list also has shops, pharmacies, florists…), with every offer they show.
function parse(json) {
  const items = (json.sections ?? []).flatMap((s) => s.items ?? []).filter((i) => i.venue);
  if (!items.length && !json.sections?.some((s) => s.name === 'no-content'))
    throw new Error('Wolt: no venues in the offers list — page layout may have changed');
  const out = [];
  const seen = new Set();
  for (const { venue: v, link, image } of items) {
    if (v.product_line !== 'restaurant' || seen.has(v.id)) continue;
    seen.add(v.id);
    const offers = [];
    for (const p of [...(v.promotions ?? []), ...(v.promotions_for_telemetry ?? [])]) {
      if (!p.text || WOLT_PLUS.test(p.text) || offers.some((o) => o.text === p.text)) continue;
      offers.push({ text: p.text, kind: /delivery/i.test(p.text) ? 'delivery' : 'discount' });
    }
    if (!offers.length) continue;
    offers.sort((a, b) => (a.kind === 'discount' ? 0 : 1) - (b.kind === 'discount' ? 0 : 1));
    out.push({
      id: v.id,
      name: v.name,
      url: link?.type === 'url' && link.target ? link.target : `${BASE}/discovery`,
      image: image?.url ?? null,
      logo: v.brand_image?.url ?? null,
      description: v.short_description_v2?.value ?? v.short_description ?? '',
      address: v.address ?? '',
      rating: v.rating?.score ?? null,
      estimate: v.estimate_range ?? null,
      deliveryPrice: v.delivery_price ?? null,
      priceRange: v.price_range ?? null,
      tags: v.tags ?? [],
      online: v.online !== false,
      offers,
    });
  }
  return out;
}
