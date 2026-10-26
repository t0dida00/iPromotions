import * as cheerio from 'cheerio';
import { USER_AGENT, sleep } from '../browser.js';
import { unifyCategory } from '../categories.js';

const BASE = 'https://www.lidl.fi';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`Lidl ${res.status} for ${url}`);
  return res.text();
}

// Lidl's homepage lists dated campaign pages ("ma 26.10. – ke 28.10. Alkuviikon tarjoukset",
// "Alkaen to 29.10. Koti ja sisustus"). We crawl the ones starting this week (Mon–Sun); each page
// embeds its products as JSON in data-grid-data attributes.
export async function crawlLidl(_opts, log = console.log) {
  const $home = cheerio.load(await fetchHtml(BASE));
  const weekEnd = endOfWeek(new Date());
  const campaigns = new Map();
  $home('a[href*="/c/"]').each((_, a) => {
    const href = $home(a).attr('href');
    const text = $home(a).text().replace(/\s+/g, ' ').trim();
    const m = text.match(/(\d{1,2})\.(\d{1,2})\./);
    if (!/\/a\d+/.test(href) || !m) return; // only dated campaign pages
    const start = new Date(new Date().getFullYear(), Number(m[2]) - 1, Number(m[1]));
    if (start > weekEnd) return; // next week's campaigns
    const url = new URL(href, BASE).href;
    // Link text is "<dates><title>"; the title is what follows the last date.
    const title = text.replace(/^.*\d{1,2}\.\d{1,2}\.\s*/, '').trim();
    if (!campaigns.has(url)) campaigns.set(url, title);
  });
  if (!campaigns.size) throw new Error('Lidl: no campaign pages found on the homepage');

  const byId = new Map();
  for (const [url, title] of campaigns) {
    const $ = cheerio.load(await fetchHtml(url));
    $('[data-grid-data]').each((_, el) => {
      try {
        const d = JSON.parse($(el).attr('data-grid-data'));
        const item = normalize(d, title);
        if (item && !byId.has(item.id)) byId.set(item.id, item);
      } catch {}
    });
    log(`  lidl: ${title} done (${byId.size} total)`);
    await sleep(400);
  }
  return [...byId.values()];
}

function normalize(d, campaign) {
  if (!d.havingPrice || !d.fullTitle) return null;
  const regular = d.price ?? {};
  const plus = d.lidlPlus?.[0];
  const plusPrice = Object.values(d.regionsPrices ?? {})[0]?.currentLidlPlusPrice?.price;
  const usePlus = regular.price == null && plus?.price?.price != null;
  const price = usePlus ? plus.price.price : regular.price;
  if (price == null) return null;
  const old = usePlus ? plusPrice?.discount?.deletedPrice ?? plusPrice?.oldPrice : regular.oldPrice ?? regular.discount?.deletedPrice;
  const highlight = usePlus ? plus.highlightText : regular.discount?.discountText;
  return {
    id: `lidl:${d.productId}`,
    source: 'lidl',
    store: 'Lidl',
    name: d.fullTitle,
    brand: typeof d.brand === 'object' ? d.brand?.name ?? null : d.brand ?? null,
    category: category(d, campaign),
    price,
    regularPrice: old && old > price ? old : null,
    dealText: [usePlus ? 'Lidl Plus' : null, highlight].filter(Boolean).join(': ') || null,
    image: d.image ?? null,
    url: new URL(d.canonicalUrl ?? '/', BASE).href,
    validUntil: d.storeEndDate ? new Date(d.storeEndDate * 1000).toISOString() : plusPrice?.endDate ?? null,
  };
}

// Lidl's own categories are coarse ("Food", "F+V"), so lean on the campaign page title
// ("Koti ja sisustus"…) and the product name to land in a useful shared category.
function category(d, campaign) {
  if (d.category === 'F+V') return 'Hedelmät ja vihannekset';
  if (unifyCategory(campaign) !== 'Other') return campaign;
  if (unifyCategory(d.fullTitle) !== 'Other') return d.fullTitle;
  return d.category === 'Food' ? 'Elintarvikkeet' : campaign;
}

function endOfWeek(now) {
  const end = new Date(now);
  end.setDate(now.getDate() + ((7 - now.getDay()) % 7)); // Sunday
  end.setHours(23, 59, 59, 999);
  return end;
}
