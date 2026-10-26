import { USER_AGENT, sleep } from '../browser.js';

const BASE = 'https://www.kappahl.com';
const PAGE_SIZE = 24;
const MAX_PAGES = 60; // safety stop

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`KappAhl ${res.status} for ${url}`);
  return res.text();
}

// Each listing page embeds its data as `window.CURRENT_PAGE = {...};`. Read that object by
// matching braces (strings may contain braces, so track quotes too).
function currentPage(html) {
  const start = html.indexOf('{', html.indexOf('window.CURRENT_PAGE'));
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

// KappAhl's outlet ("/kappahl-outlet") lists every marked-down product, 24 per `?page=N`.
export async function crawlKappAhl({ url = `${BASE}/fi-fi/kappahl-outlet` }, log = console.log) {
  const byCode = new Map();
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && (page - 1) * PAGE_SIZE < total; page++) {
    const data = currentPage(await fetchHtml(`${url}?page=${page}`));
    if (!data?.products?.length) break;
    if (page === 1) total = findCount(data, new URL(url).pathname) ?? Infinity;
    for (const p of data.products) {
      const d = normalize(p);
      if (d && !byCode.has(d.id)) byCode.set(d.id, d);
    }
    await sleep(500);
  }
  log(`  kappahl: ${byCode.size}/${Number.isFinite(total) ? total : '?'} outlet products`);
  return [...byCode.values()];
}

// The page's category tree carries the product count of the listing we're on.
function findCount(o, path) {
  if (!o || typeof o !== 'object') return null;
  if (o.url === path && typeof o.productCount === 'number') return o.productCount;
  for (const v of Object.values(o)) {
    const n = findCount(v, path);
    if (n != null) return n;
  }
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;

function normalize(p) {
  const price = p.price?.current?.inclVat;
  if (!p.displayName || price == null) return null;
  const original = p.price?.original?.inclVat;
  // URL is "/fi-fi/naiset/asusteet/korut/korvakorut/906552": the middle parts are the category.
  const parts = (p.url ?? '').split('/').filter(Boolean).slice(1, -1);
  const img = p.images?.[0]?.url;
  return {
    id: `kappahl:${p.code}`,
    source: 'kappahl',
    store: 'KappAhl',
    name: p.displayName,
    brand: null,
    category: parts.slice(-2).join(' '),
    price: round2(price),
    regularPrice: original > price ? round2(original) : null,
    dealText: p.price?.isOutlet ? 'Outlet' : null,
    image: img ? new URL(img, BASE).href : null,
    url: new URL(p.url, BASE).href,
    validUntil: null,
  };
}
