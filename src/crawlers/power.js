import { withBrowser, declineCookies, sleep } from '../browser.js';

const BASE = 'https://www.power.fi';
const IMG = 'https://media.power-cdn.net';
const MAX_PAGES = 100; // 36 products per page
const DEAL_BADGE = /halpaa|cashback|etu|hyvitys|tarjous|kaupan päälle|€|%/i;

// Power's listing pages ("Katso kaikki") load products from /api/v2/productlists, 36 at a time.
// We open each listing in a headless browser, capture that first request, then repeat it with a
// growing `from` from inside the page — the same request the "Näytä lisää" button makes.
// The weekly campaign has ~500 products and the clearance a few hundred; the outlet (thousands of
// returned/used items) is left out by default but can be added through `urls`.
export async function crawlPower(
  { urls = [`${BASE}/tarjoukset/kampanja/all/`, `${BASE}/tarjoukset/varastontyhjennys/all/`] },
  log = console.log,
) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const products = new Map();
    for (const url of urls) {
      let first = null;
      const onReq = (req) => {
        if (!first && req.url().includes('/api/v2/productlists')) first = req.url();
      };
      page.on('request', onReq);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page
        .waitForResponse((r) => r.url().includes('/api/v2/productlists'), { timeout: 45_000 })
        .catch(() => {});
      page.off('request', onReq);
      await declineCookies(page);
      if (!first) {
        log(`  power: product list request not seen on ${url} — skipped`);
        continue;
      }
      const label = /\/outlet\//.test(url) ? 'Outlet' : /varastontyhjennys/.test(url) ? 'Varastontyhjennys' : null;

      let total = Infinity;
      let seen = 0;
      for (let i = 0, from = 0; i < MAX_PAGES && from < total; i++) {
        const pageUrl = first.replace(/([?&]from=)\d+/, `$1${from}`);
        const data = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { accept: 'application/json' } });
          return r.ok ? r.json() : { status: r.status };
        }, pageUrl);
        if (data?.status) throw new Error(`Power: productlists returned HTTP ${data.status}`);
        const list = data?.products ?? [];
        if (!list.length) break;
        total = data.totalProductCount ?? 0;
        for (const p of list) if (!products.has(p.productId)) products.set(p.productId, { p, label });
        seen += list.length;
        from += list.length;
        if (data.isLastPage) break;
        await sleep(400);
      }
      log(`  power: ${seen}/${total === Infinity ? '?' : total} products from ${url}`);
      await sleep(400);
    }
    return [...products.values()].map(({ p, label }) => normalize(p, label)).filter(Boolean);
  });
}

function normalize(p, label) {
  const price = p.price;
  if (typeof price !== 'number') return null;
  const prev = p.minimumPreviousPriceInfo ?? {};
  const regularPrice = prev.minimumPrice > price ? prev.minimumPrice : null;
  // Listing pages are campaign/clearance pages, but keep only products that show a saving or
  // carry an explicit deal badge ("Nyt on halpaa", cashback, …) — not "Uutuudet" or brand badges.
  const alt = !p.hideCampaignBadge ? p.campaignMediaAltText?.trim().replace(/\.$/, '') : null;
  const badge = alt && DEAL_BADGE.test(alt) ? alt : null;
  if (!regularPrice && !badge && !label) return null;
  const crumbs = [...(p.breadcrumb ?? [])].sort((a, b) => b.sortValue - a.sortValue).map((c) => c.name);
  const img = p.productImage;
  const variant =
    img?.variants?.find((v) => v.width === 600 && v.filename.endsWith('.jpg')) ??
    img?.variants?.find((v) => v.filename.endsWith('.jpg')) ??
    img?.variants?.[0];
  const end = prev.activeCampaignEndTime;
  return {
    id: `power:${p.productId}`,
    source: 'power',
    store: 'Power',
    name: p.title,
    brand: p.manufacturerName ?? null,
    category: crumbs.length ? crumbs.join(' > ') : p.categoryName ?? null,
    price,
    regularPrice,
    dealText: label ?? badge,
    image: img?.basePath && variant ? `${IMG}${img.basePath}/${variant.filename}` : null,
    url: new URL(p.url, BASE).href,
    validUntil: end && new Date(end) - Date.now() < 365 * 864e5 ? new Date(end).toISOString() : null,
  };
}
