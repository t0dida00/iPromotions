import { USER_AGENT, sleep } from '../browser.js';

const API = 'https://api.newyorker.de/csp/products/public/query';
const SITE = 'https://www.newyorker.de/fi/products/';
const LIMIT = 30;

// New Yorker has no Finnish web shop, but its product catalog shows Finnish store prices.
// The catalog's "SALE" filter (`?gender=FEMALE&custom=sale`) reads from this public listing,
// 30 products at a time — the same request the page makes while scrolling.
export async function crawlNewYorker({ genders = ['FEMALE', 'MALE'] }, log = console.log) {
  const byId = new Map();
  for (const gender of genders) {
    let total = Infinity;
    for (let offset = 0; offset < total; offset += LIMIT) {
      const url = `${API}?limit=${LIMIT}&offset=${offset}&filters[country]=fi&filters[gender]=${gender}&filters[sale]=true`;
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', origin: 'https://www.newyorker.de' } });
      if (!res.ok) throw new Error(`New Yorker ${res.status}`);
      const data = await res.json();
      total = data.totalCount ?? 0;
      if (!data.items?.length) break;
      for (const p of data.items) {
        const d = normalize(p);
        if (d && !byId.has(d.id)) byId.set(d.id, d);
      }
      await sleep(400);
    }
    log(`  newyorker: ${gender.toLowerCase()} sale ${Number.isFinite(total) ? total : '?'} products (${byId.size} total)`);
  }
  return [...byId.values()];
}

function normalize(p) {
  // A product has colour variants; use the first one that is actually on sale.
  const v = p.variants?.find((x) => x.sale && x.current_price < x.original_price) ?? p.variants?.find((x) => x.sale);
  if (!v) return null;
  const name =
    p.descriptions?.find((d) => d.language === 'FI')?.description ??
    p.descriptions?.find((d) => d.language === 'EN')?.description ??
    p.maintenance_group;
  const img = v.images?.[0]?.key;
  const who = { FEMALE: 'Women', MALE: 'Men' }[p.customer_group];
  return {
    id: `newyorker:${p.id}-${v.id}`,
    source: 'newyorker',
    store: 'New Yorker',
    name: who ? `${name} (${who})` : name,
    brand: p.brand ?? null,
    // e.g. "T-Shirts, long sleeve Fashion" — matched by the English clothing keywords.
    category: p.maintenance_group ?? '',
    price: v.current_price,
    regularPrice: v.original_price > v.current_price ? v.original_price : null,
    dealText: 'In-store price',
    image: img ? `https://api.newyorker.de/csp/images/image/public/${img}?res=mid` : null,
    url: `${SITE}#/detail/${p.id}/${v.id}`,
    validUntil: null,
  };
}
