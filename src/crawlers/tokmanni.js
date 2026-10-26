import * as cheerio from 'cheerio';
import { USER_AGENT, sleep } from '../browser.js';

const PAGE_SIZE = 40;

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`Tokmanni ${res.status} for ${url}`);
  return res.text();
}

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function parseProducts($, category) {
  return $('li.product-item')
    .map((_, el) => {
      const $el = $(el);
      const link = $el.find('a.product-item-link');
      const url = link.attr('href');
      const name = link.text().trim();
      if (!url || !name) return null;
      const price = num($el.find('[data-price-type="finalPrice"]').attr('data-price-amount'));
      const regularPrice = num($el.find('[data-price-type="oldPrice"]').attr('data-price-amount'));
      const sku = $el.find('[data-product-sku]').attr('data-product-sku') || url;
      return {
        id: `tokmanni:${sku}`,
        source: 'tokmanni',
        store: 'Tokmanni',
        name,
        brand: $el.find('.brand-name').text().trim() || null,
        category,
        price,
        regularPrice: regularPrice && regularPrice > (price ?? 0) ? regularPrice : null,
        dealText: $el.find('.campaign-label').first().text().replace(/\s+/g, ' ').trim() || null,
        image: $el.find('img').first().attr('src') || null,
        url,
        validUntil: null,
      };
    })
    .get()
    .filter(Boolean);
}

export async function crawlTokmanni({ url }, log = console.log) {
  const $root = cheerio.load(await fetchHtml(url));
  const categories = $root('a.subcategory-link')
    .map((_, a) => ({ name: $root(a).text().trim(), url: $root(a).attr('href') }))
    .get();
  if (!categories.length) throw new Error('Tokmanni: no categories found — page layout may have changed');

  const byId = new Map();
  for (const cat of categories) {
    for (let p = 1; ; p++) {
      const $ = p === 1 && cat.url === url ? $root : cheerio.load(await fetchHtml(`${cat.url}?p=${p}`));
      const items = parseProducts($, cat.name);
      for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
      // Toolbar reads "1 – 40 / 2329"; the largest number is the total.
      const total = Math.max(0, ...$('.toolbar-number').map((_, e) => num($(e).text()) ?? 0).get());
      if (items.length < PAGE_SIZE || p * PAGE_SIZE >= total) break;
      await sleep(400);
    }
    log(`  tokmanni: ${cat.name} done (${byId.size} total)`);
    await sleep(400);
  }
  return [...byId.values()];
}
