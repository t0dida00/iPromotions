import { withBrowser, declineCookies, sleep } from '../browser.js';

const BASE = 'https://www.gigantti.fi';

// Gigantti's pages are client-rendered: the page fetches a signed Algolia key from
// /api/algolia/signed-api-key and then queries Algolia for the product list, 48 at a time.
// We open the page in a headless browser, capture that first Algolia query (URL carries the
// page's signed key), then repeat it with a growing `page` from inside the page — the same
// request the page's "Näytä lisää" makes. The weekly campaign has ~800 products. The outlet
// (/outlet, ~5,000 demo/returned items) can be added through `urls`; `maxPages` caps each list.
export async function crawlGigantti({ urls = [`${BASE}/kampanja`], maxPages = 40 }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const products = new Map();
    for (const url of urls) {
      let first = null;
      const onReq = (req) => {
        if (!first && req.url().includes('algolia.net/1/indexes/') && req.method() === 'POST')
          first = { url: req.url(), body: req.postData() };
      };
      page.on('request', onReq);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page
        .waitForResponse((r) => r.url().includes('algolia.net/1/indexes/'), { timeout: 60_000 })
        .catch(() => {});
      page.off('request', onReq);
      await declineCookies(page);
      if (!first) {
        log(`  gigantti: product query not seen on ${url} — skipped`);
        continue;
      }
      // Keep only the product query (the page also asks the content index for articles).
      const body = JSON.parse(first.body);
      const query = body.requests.find((r) => r.indexName?.startsWith('commerce_')) ?? body.requests[0];
      const outlet = /\/outlet/.test(url);

      let nbPages = Infinity;
      let nbHits = '?';
      let seen = 0;
      for (let n = 0; n < Math.min(nbPages, maxPages); n++) {
        const data = await page.evaluate(
          async ({ u, b }) => {
            const r = await fetch(u, { method: 'POST', body: b, headers: { 'content-type': 'text/plain' } });
            return r.ok ? r.json() : { status: r.status };
          },
          { u: first.url, b: JSON.stringify({ requests: [{ ...query, page: n }] }) },
        );
        if (data?.status) throw new Error(`Gigantti: Algolia query returned HTTP ${data.status}`);
        const res = data?.results?.[0];
        if (!res?.hits?.length) break;
        nbPages = res.nbPages ?? 0;
        nbHits = res.nbHits;
        for (const h of res.hits) if (!products.has(h.objectID)) products.set(h.objectID, { h, outlet });
        seen += res.hits.length;
        await sleep(400);
      }
      log(`  gigantti: ${seen}/${nbHits} products from ${url}`);
      await sleep(400);
    }
    return [...products.values()].map(({ h, outlet }) => normalize(h, outlet)).filter(Boolean);
  });
}

// "Kampanja voimassa 12.10.-1.11." -> end of 1.11. (this year, or next year if it already passed
// more than two months ago).
function parseDisclaimer(text) {
  const m = /voimassa[^-–]*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})?/i.exec(text ?? '');
  if (!m) return null;
  const now = new Date();
  let d = new Date(Number(m[3] ?? now.getFullYear()), Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
  if (!m[3] && now - d > 60 * 864e5) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), 23, 59, 59);
  return d.toISOString();
}

function normalize(h, outlet) {
  const listPrice = h.price?.amount;
  if (typeof listPrice !== 'number') return null;
  const club = h.customerClubPrice?.amount;
  // Club offers ("Klubitarjous") are open to Gigantti's free customer club; use that price.
  const isClub = typeof club === 'number' && club < listPrice;
  const price = isClub ? club : listPrice;
  const regularPrice = h.beforePrice > price ? h.beforePrice : null;
  if (!regularPrice && !outlet) return null;
  const promo = h.promotion?.promotionBadgeText?.replace(/\*$/, '').trim() || null;
  const cats = h.hierarchicalCategories ?? {};
  const deepest = cats.lvl3 ?? cats.lvl2 ?? cats.lvl1 ?? h.ptLevel2NodeValue ?? h.ptLevel1NodeValue ?? null;
  const end = h.promotion?.promotionEndDate ?? parseDisclaimer(h.disclaimer);
  return {
    id: `gigantti:${h.objectID}`,
    source: 'gigantti',
    store: 'Gigantti',
    name: h.title,
    brand: h.brand ?? null,
    category: deepest,
    price,
    regularPrice,
    dealText: outlet ? (promo ? `Outlet, ${promo}` : 'Outlet') : isClub ? 'Klubitarjous' : promo && !/^Klubitarjous/.test(promo) && /%|€|cashback|paketti|kaupan/i.test(promo) ? promo : null,
    image: h.imageUrl ?? null,
    url: h.productUrl ?? `${BASE}/product/${h.objectID}/${h.objectID}`,
    validUntil: end && new Date(end) - Date.now() < 365 * 864e5 ? new Date(end).toISOString() : null,
  };
}
