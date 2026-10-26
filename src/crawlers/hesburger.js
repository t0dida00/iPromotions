import * as cheerio from 'cheerio';
import { USER_AGENT, sleep } from '../browser.js';
import { analyzeBanners, bannerToDeal } from '../analyst.js';

const BASE = 'https://www.hesburger.fi';
const MAX_BANNERS = 12;

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-language': 'fi-FI' } });
  if (!res.ok) throw new Error(`Hesburger ${res.status} for ${url}`);
  return { html: await res.text(), url: res.url };
}

// Campaigns come from the homepage hero carousel. Its banners are pictures with the text drawn
// in (no alt text), so for each banner we follow its link and read the landing page's title,
// description and headings; the campaign analyst (src/analyst.js) turns that into a campaign
// and drops banners that aren't offers (news, shop, jobs).
export async function crawlHesburger({ url = `${BASE}/` }, log = console.log) {
  const $ = cheerio.load((await fetchPage(url)).html);
  const raw = [];
  $('.c-hero .banner').each((_, el) => {
    const $b = $(el);
    const href = $b.find('a').attr('href');
    const img = $b.find('img.desktop').attr('src') || $b.find('img').attr('src');
    if (href && !raw.some((r) => r.href === href)) raw.push({ href: new URL(href, BASE).href, img });
  });
  if (!raw.length) throw new Error('Hesburger: no hero banners found — page layout may have changed');

  const banners = [];
  for (const { href, img } of raw.slice(0, MAX_BANNERS)) {
    let text = '';
    let link = href;
    // Only follow links on Hesburger's own site; external ones (HeseKauppa) are described by URL.
    if (new URL(href).hostname.endsWith('hesburger.fi')) {
      try {
        const page = await fetchPage(href);
        link = page.url; // redirect.php?id=… resolves to the product/news page
        const $p = cheerio.load(page.html);
        text = [
          $p('title').text(),
          $p('meta[name="description"]').attr('content'),
          $p('meta[property="og:description"]').attr('content'),
          $p('h1').first().text(),
          $p('main p, .content p, article p').slice(0, 4).map((_, p) => $p(p).text()).get().join(' '),
        ]
          .filter(Boolean)
          .join(' | ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1200);
      } catch (e) {
        log(`  hesburger: could not read ${href}: ${e.message}`);
      }
      await sleep(400);
    }
    banners.push({ text: text || `Banner linking to ${link}`, link, image: img ? new URL(img, BASE).href : null });
  }

  const analyses = await analyzeBanners('Hesburger', banners, log);
  const deals = banners
    .map((banner, index) => bannerToDeal({ source: 'hesburger', store: 'Hesburger', banner, analysis: analyses[index], index }))
    .filter(Boolean);
  log(`  hesburger: ${banners.length} hero banners → ${deals.length} campaigns`);
  return deals;
}
