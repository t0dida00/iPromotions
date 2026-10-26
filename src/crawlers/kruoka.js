import { withBrowser, declineCookies, sleep } from '../browser.js';

// The K-Ruoka flyer page is behind bot protection, so we load it in a real (headless) browser
// and capture the JSON the page itself fetches from /kr-api/raw-offer/product-map.
export async function crawlKRuoka({ url, label }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    const products = new Map();
    page.on('response', async (res) => {
      if (!res.url().includes('/kr-api/raw-offer/product-map') || !res.ok()) return;
      try {
        const data = await res.json();
        for (const [ean, p] of Object.entries(data)) if (p?.type === 'product') products.set(ean, p);
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForResponse((r) => r.url().includes('product-map'), { timeout: 90_000 });
    await declineCookies(page);

    // The flyer may lazy-load more offers while scrolling; keep going until nothing new arrives.
    let stable = 0;
    while (stable < 3) {
      const before = products.size;
      await page.mouse.wheel(0, 4000);
      await sleep(1500);
      stable = products.size === before ? stable + 1 : 0;
    }
    log(`  kruoka: captured ${products.size} products`);

    return [...products.values()].map((p) => normalize(p, label)).filter(Boolean);
  });
}

function normalize(p, store) {
  const pricing = p.mobilescan?.pricing ?? {};
  const normal = pricing.normal;
  const deal = pricing.discount ?? pricing.batch;
  if (!deal) return null; // listed in the flyer but no active price discount for this store

  const amount = deal.amount ?? 1;
  const unitDealPrice = round2(deal.price / amount);
  const tree = p.category?.tree ?? [];
  const slug = p.productAttributes?.urlSlug;
  const label = deal.discountType === 'PLUSSA' ? ' (K-Plussa)' : '';
  return {
    id: `kruoka:${p.ean}`,
    source: 'kruoka',
    store,
    name: p.localizedName?.finnish ?? p.localizedName?.english ?? p.ean,
    brand: null,
    category: tree[0]?.localizedName?.finnish ?? 'Muut',
    price: unitDealPrice,
    regularPrice: normal?.price && normal.price > unitDealPrice ? normal.price : null,
    dealText: amount > 1 ? `${amount} kpl / ${fmt(deal.price)} €${label}` : label.trim() || null,
    image: p.productAttributes?.image?.url ?? null,
    url: slug ? `https://www.k-ruoka.fi/kauppa/tuote/${slug}` : 'https://www.k-ruoka.fi/',
    validUntil: deal.endDate ?? null,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => n.toFixed(2).replace('.', ',');
