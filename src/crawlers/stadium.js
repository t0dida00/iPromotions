import { withBrowser, declineCookies, sleep } from '../browser.js';
import { isClothing } from '../categories.js';

const BASE = 'https://www.stadium.fi';
const MAX_CLICKS = 80; // ~96 products per click; the sale has ~4,500

// Stadium's sale list shows 24 products and adds ~96 per "Lataa lisää" click. Tiles carry only
// the name and prices ("J LINDEBERG Rosario Pant 199 € 259 € (-23%)"), no category, so we keep
// products with a real discount whose name identifies them as clothing or shoes.
export async function crawlStadium({ url = `${BASE}/tag/alehintaiset-tuotteet`, clothingOnly = true }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForSelector('article', { timeout: 30_000 });
    await declineCookies(page);

    let stalls = 0;
    for (let i = 0; i < MAX_CLICKS; i++) {
      const before = await page.locator('article').count();
      // Clicked from the page itself so a cookie banner can't intercept it.
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button, a')].find((x) => /Lataa lisää/.test(x.textContent));
        b?.click();
        return Boolean(b);
      });
      if (!clicked) break;
      const grew = await page
        .waitForFunction((n) => document.querySelectorAll('article').length > n, before, { timeout: 15_000 })
        .then(() => true, () => false);
      if (!grew && ++stalls >= 3) break;
      if (grew) stalls = 0;
      await sleep(250);
    }

    const tiles = await page.$$eval('article', (arts) =>
      arts.map((a) => {
        const link = a.querySelector('a[href^="/product/"]');
        const img = a.querySelector('img');
        // next/image URLs wrap the original: /_next/image?url=<original>&w=…
        let src = img?.currentSrc || img?.getAttribute('src') || '';
        try {
          const inner = new URL(src, location.href).searchParams.get('url');
          if (inner) src = inner;
        } catch {}
        return { href: link?.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim(), image: src || null };
      }),
    );
    const items = tiles.map(normalize).filter(Boolean);
    const unique = [...new Map(items.map((d) => [d.id, d])).values()];
    log(`  stadium: ${tiles.length} sale tiles, ${unique.length} with a discount`);
    return clothingOnly ? unique.filter((d) => isClothing(d.name)) : unique;
  });
}

const euro = (s) => parseFloat(s.replace(/\s/g, '').replace('€', '').replace(',', '.'));

function normalize(t) {
  if (!t.href) return null;
  // Text is "[-23%]<name><price> €[<old price> €(-23%)]".
  const text = t.text.replace(/^-\d+%/, '');
  const prices = [...text.matchAll(/(\d[\d\s]*(?:,\d+)?)\s?€/g)];
  if (prices.length < 2) return null; // full price only: no visible discount
  const price = euro(prices[0][1]);
  const old = euro(prices[1][1]);
  if (!(old > price)) return null;
  const name = text.slice(0, prices[0].index).trim();
  const id = t.href.split('/')[2];
  return {
    id: `stadium:${id}`,
    source: 'stadium',
    store: 'Stadium',
    name,
    brand: null,
    category: name,
    price,
    regularPrice: old,
    dealText: null,
    image: t.image,
    url: new URL(t.href, BASE).href,
    validUntil: null,
  };
}
