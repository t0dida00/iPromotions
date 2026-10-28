import { USER_AGENT } from '../browser.js';

const BASE = 'https://www.s-kaupat.fi';
const API = 'https://api.s-kaupat.fi/';
const PAGE_SIZE = 100;
// S-kaupat's site asks its GraphQL API for products by the hash of a stored query. If S-kaupat
// changes the query, the API answers PersistedQueryNotFound: open
// https://www.s-kaupat.fi/hakutulokset?label=DISCOUNTED and copy `sha256Hash` from the
// RemoteFilteredProducts request (browser dev tools → Network).
const QUERY_HASH = '85a4eed2f0a1e3269ac49b94276ca952922568369d85ddd5dcee34481e4c0f91';

// The discounted products of one S-group store, read from the same API the site uses. The store is
// just a variable there, so no browser is needed (the site's store picker doesn't load on
// data-centre machines, the API does).
export async function crawlPrisma({ storeId, label }, log = console.log) {
  const products = new Map();
  let total = null;
  for (let from = 0; total == null || from < total; from += PAGE_SIZE) {
    const list = await fetchPage(storeId, from);
    total = list.total ?? 0;
    const before = products.size;
    for (const item of list.productListItems ?? []) {
      const p = item.product;
      if (p && p.storeId === storeId) products.set(p.ean, { ...p, labels: item.labels });
    }
    if (products.size === before) break;
  }
  log(`  prisma: captured ${products.size}/${total} products`);
  if (total > 0 && !products.size) throw new Error(`Prisma: ${total} products listed but none for store ${storeId}`);
  return [...products.values()].map((p) => normalize(p, label));
}

async function fetchPage(storeId, from) {
  const variables = {
    facets: [],
    filters: [{ key: 'labels', value: ['DISCOUNTED'] }],
    fetchSponsoredContent: false,
    limit: PAGE_SIZE,
    from,
    queryString: '',
    storeId,
    useRandomId: false,
  };
  const params = new URLSearchParams({
    operationName: 'RemoteFilteredProducts',
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: QUERY_HASH } }),
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { 'user-agent': USER_AGENT, 'content-type': 'application/json', 'x-client-name': 'skaupat-web' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Prisma: S-kaupat API answered ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    throw new Error(/PersistedQueryNotFound/i.test(msg) ? 'Prisma: S-kaupat changed its product query (update QUERY_HASH in src/crawlers/prisma.js)' : `Prisma: ${msg}`);
  }
  const list = body.data?.store?.products;
  if (!list) throw new Error('Prisma: the S-kaupat API answer has no product list');
  return list;
}

function normalize(p, store) {
  const pr = p.pricing ?? {};
  const rule = pr.primaryDiscountRule;
  const price = pr.campaignPrice ?? pr.currentPrice ?? p.price;
  const regular = pr.regularPrice ?? pr.lowest30DayPrice;
  const tree = p.hierarchyPath ?? [];
  const img = p.productDetails?.productImages?.mainImage?.urlTemplate;
  return {
    id: `prisma:${p.ean}`,
    source: 'prisma',
    store,
    name: p.name,
    brand: p.brandName ?? null,
    category: tree[tree.length - 1]?.name ?? 'Muut',
    price,
    regularPrice: regular && regular > price ? regular : null,
    dealText: ruleText(rule) ?? p.labels?.map((l) => l.labelText).filter(Boolean).join(', ') ?? null,
    // The CDN takes modifiers as w600_h600_q75 (the old "w_300,h_300,q_75" now answers 400).
    image: img ? img.replace('{MODIFIERS}', 'w600_h600_q75').replace('{EXTENSION}', 'jpg') : null,
    url: `${BASE}/tuote/${p.slug}/${p.ean}`,
    validUntil: pr.campaignPriceValidUntil ?? null,
  };
}

function ruleText(rule) {
  if (!rule) return null;
  if (rule.requiredItemCount && rule.discountValue != null)
    return `${rule.requiredItemCount} kpl / ${String(rule.discountValue).replace('.', ',')} €`;
  return rule.description ?? rule.title ?? null;
}
