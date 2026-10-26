import { withBrowser, declineCookies, sleep } from '../browser.js';

const BASE = 'https://www.verkkokauppa.com';
const MAX_PAGES = 100; // 48 products per page

// Verkkokauppa.com's offers page loads products from its search service
// (search.service.verkkokauppa.com/…/product-search, filtered to `has_discount`), 48 at a time.
// We open the page in a headless browser, capture that first request, then repeat it with a
// growing page[number] from inside the page — the same request the page's paging makes.
// Responses are JSON:API: products in `data`, brands/categories/campaigns in `included`.
export async function crawlVerkkokauppa({ url = `${BASE}/fi/tarjoukset` }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    let first = null;
    page.on('request', (req) => {
      if (!first && req.url().includes('/product-search') && req.url().includes('has_discount'))
        first = { url: req.url(), origin: req.headers()['x-request-origin-path'] ?? '/fi/tarjoukset' };
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForResponse((r) => r.url().includes('/product-search'), { timeout: 60_000 }).catch(() => {});
    await declineCookies(page);
    if (!first) throw new Error('Verkkokauppa: product search request not seen — page layout or bot check changed');

    const products = new Map();
    const included = new Map(); // "type:id" -> resource
    let total = Infinity;
    for (let n = 1; n <= MAX_PAGES; n++) {
      const pageUrl = first.url.replace(/(page%5Bnumber%5D=|page\[number\]=)\d+/, `$1${n}`);
      const data = await page.evaluate(
        async ({ u, origin }) => {
          const r = await fetch(u, { headers: { 'x-request-origin-path': origin } });
          return r.ok ? r.json() : { status: r.status };
        },
        { u: pageUrl, origin: first.origin },
      );
      if (data?.status) throw new Error(`Verkkokauppa: product search returned HTTP ${data.status}`);
      for (const inc of data?.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
      const list = data?.data ?? [];
      if (!list.length) break;
      total = data.meta?.totalResults ?? total;
      for (const p of list) if (!products.has(p.id)) products.set(p.id, p);
      if (products.size >= total) break;
      await sleep(400);
    }
    log(`  verkkokauppa: captured ${products.size}/${total} discounted products`);
    return [...products.values()].map((p) => normalize(p, included)).filter(Boolean);
  });
}

function categoryPath(id, included) {
  const names = [];
  for (let i = 0; id && i < 6; i++) {
    const c = included.get(`salesCategories:${id}`);
    if (!c) break;
    names.unshift(c.attributes?.label);
    id = c.relationships?.parent?.data?.id;
  }
  return names.filter(Boolean).join(' > ') || null;
}

function normalize(p, included) {
  const a = p.attributes ?? {};
  const pr = a.price ?? {};
  const price = pr.current;
  if (typeof price !== 'number') return null;
  const regularPrice = pr.original > price ? pr.original : null;
  if (!regularPrice) return null;
  const disc = pr.discount ?? {};
  const brandId = p.relationships?.brand?.data?.id;
  const brand = brandId ? included.get(`brands:${brandId}`)?.attributes?.name ?? null : null;
  const catId = p.relationships?.category?.data?.id;
  // discountType 2 = time-limited campaign price ("Erityishintainen kampanjatuote").
  const dealText = disc.discountType === 2 ? 'Kampanja' : pr.discountPercentage ? `-${pr.discountPercentage}%` : null;
  const end = disc.endAt;
  return {
    id: `verkkokauppa:${p.id}`,
    source: 'verkkokauppa',
    store: 'Verkkokauppa.com',
    name: a.name,
    brand,
    category: categoryPath(catId, included) ?? a.pim_primary_category ?? null,
    price,
    regularPrice,
    dealText,
    image: a.images?.[0]?.orig ?? null,
    url: new URL(a.href ?? `/fi/product/${p.id}`, BASE).href,
    validUntil: end && new Date(end) - Date.now() < 365 * 864e5 ? new Date(end).toISOString() : null,
  };
}
