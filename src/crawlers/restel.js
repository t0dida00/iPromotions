import * as cheerio from 'cheerio';
import { USER_AGENT } from '../browser.js';
import { analyzeBanners, bannerToDeal } from '../analyst.js';

// Restel's restaurant chains (Classic Pizza, Taco Bell, Rax) share one WordPress theme: a page of
// content blocks (`#content section.block`), each with a headline, terms such as "Syysloman ajan
// 12.-25.10.2026 vain 9,90 € (norm 12,90 €)", a link and a lazy-loaded picture. Classic Pizza has
// them on /kampanjat/, Taco Bell and Rax on the homepage. The campaign analyst (src/analyst.js)
// extracts price/dates and drops blocks that aren't offers (menu highlights, loyalty club, game).
export async function crawlRestel({ url, name }, log = console.log) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`${name} ${res.status} for ${url}`);
  const $ = cheerio.load(await res.text());

  const banners = [];
  $('#content section.block').each((i, sec) => {
    const $s = $(sec);
    const heading = $s.find('h1, h2, h3').first().text().trim();
    if (!heading) return;
    const text = [heading, $s.find('p').map((_, p) => $(p).text()).get().join(' ')]
      .join(' | ')
      .replace(/\s+/g, ' ')
      .trim();
    // Pictures are lazy-loaded: `src` is a blurred placeholder, the real one is in data-src.
    const img = $s.find('img[data-src]').attr('data-src') || $s.find('img[src]').not('[src^="data:"]').attr('src');
    banners.push({
      text: text.slice(0, 1200),
      // The block's own anchor keeps each campaign's id stable (buttons often just link to the restaurant list).
      link: `${url}#${$s.attr('id') || `offer-${i}`}`,
      image: img ? new URL(img, url).href : null,
    });
  });
  if (!banners.length) throw new Error(`${name}: no content blocks found — page layout may have changed`);

  const analyses = await analyzeBanners(name, banners, log);
  const deals = banners
    .map((banner, index) => bannerToDeal({ source: 'restel', store: name, banner, analysis: analyses[index], index }))
    .filter(Boolean);
  log(`  ${name}: ${banners.length} content blocks → ${deals.length} campaigns`);
  return deals;
}
