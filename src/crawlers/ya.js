import * as cheerio from 'cheerio';
import { USER_AGENT, sleep } from '../browser.js';

const BASE = 'https://www.yliopistonapteekki.fi';
const MAX_PAGES = 30; // 48 products per page

// Yliopiston Apteekki (YA) is a Magento shop: its offer lists are rendered on the server with the
// offer price and the normal price of each product. "Kanta-asiakastarjoukset" are member prices
// (free loyalty card), the outlet is clearance. The pharmacy's own landing page (/tarjoukset) only
// links to these lists.
export async function crawlYa(
  {
    lists = [
      { path: '/tarjoukset/kanta-asiakastarjoukset', label: 'Kanta-asiakas' },
      { path: '/tarjoukset/outlet', label: 'Outlet' },
    ],
  },
  log = console.log,
) {
  const products = new Map();
  for (const { path, label } of lists) {
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const $ = cheerio.load(await fetchHtml(`${BASE}${path}?p=${page}`));
      const items = $('li.product-item');
      if (page === 1 && !items.length) throw new Error(`YA: no products on ${path} (page layout changed)`);
      items.each((_, el) => {
        const deal = normalize($, $(el), label);
        if (deal && !products.has(deal.id)) {
          products.set(deal.id, deal);
          count++;
        }
      });
      if (!$('.pages-item-next').length) break;
      await sleep(400);
    }
    log(`  ya: ${path} → ${count} products`);
  }
  if (!products.size) throw new Error('YA: the offer lists have no products with prices');
  return [...products.values()];
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`YA ${res.status} for ${url}`);
  return res.text();
}

function normalize($, $el, label) {
  const link = $el.find('a.product-item__photo').first();
  const id = link.attr('data-id');
  const price = Number($el.find('[data-price-type="finalPrice"]').first().attr('data-price-amount'));
  // YA hides the name of intimate products in lists ("SENSITIIVINENTUOTE"): nothing to show.
  if (!id || !Number.isFinite(price) || /^sensitiivinentuote$/i.test(link.attr('data-name') ?? '')) return null;
  const regular = Number($el.find('[data-price-type="oldPrice"]').first().attr('data-price-amount'));
  // The list shows a 352 px copy from Magento's image cache; the original (≈1400 px) is the same
  // path without "/cache/<hash>".
  const img = $el.find('img.product-image-photo').first().attr('src');
  const percent = $el.find('.amlabel-text').map((_, t) => $(t).text().trim()).get().find((t) => /%/.test(t));
  return {
    id: `ya:${id}`,
    source: 'ya',
    store: 'Yliopiston Apteekki',
    name: link.attr('data-name') ?? $el.find('.product-item-name').text().trim(),
    brand: link.attr('data-brand') || null,
    // e.g. "vitamiinit-ja-ravinto/vitamiinit/b-vitamiinit"
    category: (link.attr('data-category') ?? '').replace(/-/g, ' '),
    price,
    regularPrice: regular > price ? regular : null,
    dealText: [label, percent].filter(Boolean).join(' ') || null,
    image: img ? img.replace(/\/cache\/[0-9a-f]+\//, '/') : null,
    url: link.attr('href') ?? BASE,
    validUntil: null,
  };
}
