import { withBrowser, declineCookies, sleep } from '../browser.js';

const BASE = 'https://www.intersport.fi';
const DEFAULT_PAGES = ['/fi/ale/vaatteet-ale-ja-tarjoukset/', '/fi/ale/kengat-ale-ja-tarjoukset/'];
const MAX_CLICKS = 120; // safety stop (~30 products per click)

// Intersport renders the first 30 products into the sale page and loads 30 more per
// "Näytä enemmän" click. We click until every product is loaded, then read the tiles.
export async function crawlIntersport({ pages = DEFAULT_PAGES }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const byId = new Map();
    for (const path of pages) {
      await page.goto(new URL(path, BASE).href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForSelector('.product-list-item', { timeout: 30_000 });
      await declineCookies(page);
      // The page says how many products the sale has ("135 / 135 tuotetta").
      const total = await page.$eval('[data-total-products]', (e) => Number(e.dataset.totalProducts)).catch(() => Infinity);
      let stalls = 0;
      for (let i = 0; i < MAX_CLICKS; i++) {
        const before = await page.locator('.product-list-item').count();
        if (before >= total) break;
        // "Näytä enemmän" loads the next 30. Clicked from the page itself so the cookie banner
        // (which has no decline option) can't intercept it.
        const clicked = await page.evaluate(() => {
          const b = document.querySelector('.load-more');
          if (!b || !b.offsetParent) return false;
          b.click();
          return true;
        });
        if (!clicked) break;
        // Wait for new tiles; stop if nothing arrives.
        const grew = await page
          .waitForFunction((n) => document.querySelectorAll('.product-list-item').length > n, before, { timeout: 15_000 })
          .then(() => true, () => false);
        // Under load (other crawlers running) a batch can be slow; allow a few retries.
        if (!grew && ++stalls >= 3) break;
        if (grew) stalls = 0;
        await sleep(300);
      }
      const items = await page.$$eval('.product-list-item', (tiles) =>
        tiles.map((t) => ({
          id: t.dataset.identifier || t.dataset.id,
          category: t.dataset.fullCategoryPath || t.dataset.categoryPath || t.dataset.category || '',
          target: t.dataset.targetgroup || '',
          href: t.querySelector('a.product-link')?.getAttribute('href'),
          brand: t.querySelector('.brand')?.textContent.trim() || null,
          name: t.querySelector('.name')?.textContent.trim() || '',
          image: t.querySelector('img')?.getAttribute('src') || null,
          price: (t.querySelector('.product-price .discount, .product-price .bonus, .product-price .normal') || {}).textContent || '',
          normal: t.querySelector('.product-price .show-discount')?.textContent || '',
          pkg: t.querySelector('.product-price .package')?.textContent || '',
          badge: t.querySelector('.badge-sale-percentage')?.textContent.trim() || '',
        })),
      );
      for (const it of items) {
        const d = normalize(it);
        if (d && !byId.has(d.id)) byId.set(d.id, d);
      }
      log(`  intersport: ${path} → ${items.length} tiles (${byId.size} total)`);
    }
    return [...byId.values()];
  });
}

const euro = (s) => {
  const n = parseFloat(String(s).replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function normalize(it) {
  const price = euro(it.price);
  if (!it.href || !it.name || price == null) return null;
  const normal = euro(it.normal);
  return {
    id: `intersport:${it.id}`,
    source: 'intersport',
    store: 'Intersport',
    name: it.name,
    brand: it.brand,
    // e.g. "vaatteet/naisten/paidat/fleecetakit" — the clothing rules match on the last parts.
    category: it.category.split('/').slice(-2).join(' '),
    price,
    regularPrice: normal > price ? normal : null,
    dealText: it.pkg ? it.pkg.replace(/\s+/g, ' ').trim() : null,
    image: it.image,
    url: new URL(it.href, BASE).href,
    validUntil: null,
  };
}
