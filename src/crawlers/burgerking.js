import * as cheerio from 'cheerio';
import { USER_AGENT, sleep } from '../browser.js';
import { analyzeBanners, bannerToDeal } from '../analyst.js';

const BASE = 'https://burgerking.fi';

// Campaigns come from two places, both read by the campaign analyst (src/analyst.js):
//  - the homepage hero blocks ("block-hero-alt"): headline, terms ("Voimassa 19.10.-1.11.2026
//    vain Woltissa…"), links and a picture;
//  - the offers page /tarjoukset/: one content block per offer (label, headline with price,
//    terms, picture), e.g. the lunch deal and meal combos.
// The analyst extracts price/discount/dates/channel and drops blocks that aren't offers
// (restaurant finder, loyalty club sign-up).
export async function crawlBurgerKing({ url = `${BASE}/`, offersUrl = `${BASE}/tarjoukset/` }, log = console.log) {
  const banners = [];
  const add = (b) => {
    // The same offer can appear on both pages; keep the first copy.
    if (!banners.some((x) => x.text === b.text)) banners.push(b);
  };

  // Homepage hero blocks.
  const $ = cheerio.load(await fetchHtml(url));
  $('section.block-hero-alt').each((_, sec) => {
    const b = readBlock($, $(sec), url);
    if (b) add(b);
  });
  const fromHero = banners.length;

  // Offers page blocks; each links to its own anchor on the page.
  await sleep(400);
  const $o = cheerio.load(await fetchHtml(offersUrl));
  $o('section.custom-block').each((i, sec) => {
    const $s = $o(sec);
    if (!$s.find('h1, h2').length) return;
    const b = readBlock($o, $s, offersUrl);
    if (b) add({ ...b, link: `${offersUrl}#${$s.attr('id') || `offer-${i}`}` });
  });
  if (!banners.length) throw new Error('Burger King: no hero or offer blocks found — page layout may have changed');

  const analyses = await analyzeBanners('Burger King', banners, log);
  const deals = banners
    .map((banner, index) => bannerToDeal({ source: 'burgerking', store: 'Burger King', banner, analysis: analyses[index], index }))
    .filter(Boolean);
  log(`  burgerking: ${fromHero} hero + ${banners.length - fromHero} offer blocks → ${deals.length} campaigns`);
  return deals;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`Burger King ${res.status} for ${url}`);
  return res.text();
}

// Text, first link and picture of one content block.
function readBlock($, $s, pageUrl) {
  const text = [
    $s.find('h1, h2').map((_, h) => $(h).text()).get().join(' — '),
    $s.find('p').map((_, p) => $(p).text()).get().join(' '),
  ]
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text.replace(/[|\s—]/g, '')) return null;
  const href = $s.find('a[href]').first().attr('href');
  const img = $s.find('img[src]').not('[src^="data:"]').attr('src') || $s.find('img[data-src]').attr('data-src');
  return {
    text: text.slice(0, 1200),
    link: href ? new URL(href, BASE).href : pageUrl,
    image: img ? new URL(img, BASE).href : null,
  };
}
