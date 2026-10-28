import { USER_AGENT, sleep } from '../browser.js';

const BASE = 'https://www.kicks.fi';
const PAGE_SIZE = 180; // the largest the site offers (90, 120, 180)
const MAX_PAGES = 40;
const MARKER = 'Components.ProductListPage, ';

// KICKS' "Tarjouksessa nyt" list (~3,400 products) is rendered on the server: each page carries the
// list's React props as JSON in a <script>, with the price, the price before the campaign, the
// category path and the campaign label of every product.
export async function crawlKicks({ url = `${BASE}/tarjouksessa-nyt` }, log = console.log) {
  const products = new Map();
  let pages = 1;
  for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
    const list = await fetchList(`${url}?pagesize=${PAGE_SIZE}&page=${page}`);
    pages = list.pagingModel?.numberOfPages ?? 1;
    for (const item of list.items ?? []) {
      const deal = normalize(item);
      if (deal) products.set(deal.id, deal);
    }
    if (page === 1) log(`  kicks: ${list.pagingModel?.hitsTotal ?? '?'} products on ${pages} pages`);
    await sleep(400);
  }
  if (!products.size) throw new Error('KICKS: the offer list has no products with prices');
  return [...products.values()];
}

async function fetchList(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`KICKS ${res.status} for ${url}`);
  const html = await res.text();
  const start = html.indexOf(MARKER);
  if (start < 0) throw new Error('KICKS: product list data not found (page layout changed)');
  const list = jsonAt(html, start + MARKER.length)?.model?.productListModel?.productList;
  if (!list?.items) throw new Error('KICKS: product list data has no items (page layout changed)');
  return list;
}

// The JSON object starting at `start`, read up to its matching closing brace.
function jsonAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

// "51,92 €" → 51.92
const euros = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function normalize(item) {
  const pr = item.priceInfo ?? {};
  const price = euros(pr.price);
  if (price == null) return null;
  const regular = euros(pr.priceBefore);
  const tracked = item.dataLayerDto?.viewEvents?.[0]?.ecommerce?.impressions?.[0] ?? {};
  const splash = item.splashes?.primary;
  const brand = item.listName?.lines?.find((l) => l.type === 'Brand')?.value ?? tracked.brand ?? null;
  return {
    id: `kicks:${item.id}`,
    source: 'kicks',
    store: 'KICKS',
    name: item.standardName,
    brand,
    // e.g. "Hiukset/Viimeistely/Seerumit Ja Silkkitipat"
    category: tracked.category ?? '',
    price,
    regularPrice: regular && regular > price ? regular : null,
    dealText: splash?.lines?.filter(Boolean).join(' ') || null,
    image: item.primaryImage?.url ?? null,
    url: new URL(item.linkAction?.url ?? '/', BASE).href,
    validUntil: splash?.endDate ?? campaignEnd(pr.campaignInfo?.disclaimer),
  };
}

// The campaign's last day from its small print: "Voimassa 28.10.–05.11. myymälässä…" or
// "Tarjous on voimassa 31.12.2026 asti". A date without a year is this year's, or next year's when
// it is months behind (a campaign running over New Year).
function campaignEnd(text) {
  const m = /[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})?|(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*asti/.exec(text ?? '');
  if (!m) return null;
  const [day, month, year] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
  const now = new Date();
  let y = Number(year) || now.getFullYear();
  if (!year && Number(month) < now.getMonth() + 1 - 6) y++;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
