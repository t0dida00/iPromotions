import { withBrowser, declineCookies, sleep } from '../browser.js';
import { isClothing } from '../categories.js';

const BASE = 'https://www.xxl.fi';

// XXL's campaign page loads products from its search service (Voyado Elevate), 36 at a time.
// We open the page in a headless browser, capture the first product request, then repeat it
// with a growing `skip` from inside the page — the same requests the "Seuraava" button makes.
export async function crawlXXL({ url = `${BASE}/kampanjat`, clothingOnly = true }, log = console.log) {
  return withBrowser(async (context) => {
    const page = await context.newPage();
    let first = null;
    page.on('request', (req) => {
      if (!first && req.url().includes('/queries/landing-page') && req.method() === 'POST')
        first = { url: req.url(), body: req.postData() };
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForResponse((r) => r.url().includes('/queries/landing-page'), { timeout: 60_000 });
    await declineCookies(page);
    if (!first) throw new Error('XXL: product request not seen — page layout may have changed');

    const products = new Map();
    let total = Infinity;
    for (let skip = 0; skip < total; skip += 36) {
      const pageUrl = first.url.replace(/([?&]skip=)\d+/, `$1${skip}`);
      const data = await page.evaluate(
        async ({ u, body }) => (await fetch(u, { method: 'POST', body, headers: { 'content-type': 'text/plain' } })).json(),
        { u: pageUrl, body: first.body },
      );
      const list = data?.primaryList;
      if (!list?.productGroups?.length) break;
      total = list.totalHits ?? 0;
      for (const g of list.productGroups) {
        const p = g.products?.[0];
        if (p && !products.has(p.key)) products.set(p.key, p);
      }
      await sleep(350);
    }
    log(`  xxl: captured ${products.size}/${total} campaign products`);

    const items = [...products.values()].map(normalize).filter(Boolean);
    return clothingOnly ? items.filter((d) => isClothing(`${d.category} ${d.name}`)) : items;
  });
}

function normalize(p) {
  let info;
  try {
    info = JSON.parse(p.custom?.priceInformation?.[0]?.id ?? 'null')?.DEFAULT?.default_price;
  } catch {}
  const values = info?.price_values ?? {};
  const price = values.sales_price;
  if (price == null) return null;
  const campaign = info.campaign_information ?? {};
  let brand = null;
  try {
    brand = JSON.parse(p.custom?.brand?.[0]?.label ?? 'null')?.name ?? null;
  } catch {}
  // Titles look like "Base Pant, miesten villapitkikset": the part after the comma is the type.
  const type = p.title.includes(',') ? p.title.slice(p.title.lastIndexOf(',') + 1).trim() : p.title;
  return {
    id: `xxl:${p.key}`,
    source: 'xxl',
    store: 'XXL',
    name: p.title,
    brand,
    category: type,
    price,
    regularPrice: values.alternate_price > price ? values.alternate_price : null,
    dealText: campaign.splash && !/^-?\d+%$/.test(campaign.splash) ? campaign.splash : null,
    // The thumbnail is a 1536 px PNG (~350 KB); the CDN resizes it.
    image: p.imageInfo?.thumbnail ? `${p.imageInfo.thumbnail}?resize=600,600` : null,
    url: new URL(p.link, BASE).href,
    // Ongoing offers (e.g. multibuy) carry an end date years away; treat those as open-ended.
    validUntil: campaign.end_date && new Date(campaign.end_date) - Date.now() < 365 * 864e5 ? campaign.end_date : null,
  };
}
