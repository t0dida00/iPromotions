import { withBrowser, declineCookies, sleep } from '../browser.js';
import { analyzeBanners, bannerToDeal } from '../analyst.js';

const BASE = 'https://www.kotipizza.fi';
const MAX_CAMPAIGN_PAGES = 6;

// Kotipizza's site is built in the browser from its CMS (Storyblok). The homepage loads one
// "homepage" story with the hero carousel (campaign name, link, start/end) and the "picked for
// you" cards (title, description, link). We read that response as the page loads it, then:
//  - open each running carousel campaign's page (e.g. /yolodiilit) and read its coupon cards
//    (name, description, "11,00 €", "norm. 13,50 €") as deals, no model needed;
//  - campaigns without coupon cards and the "picked" cards go to the campaign analyst
//    (src/analyst.js), which keeps the offers and drops the rest (gift cards, loyalty club, games).
export async function crawlKotipizza({ url = `${BASE}/` }, log = console.log) {
  const { story, campaigns } = await withBrowser(async (context) => {
    const page = await context.newPage();
    const res = page.waitForResponse((r) => /\/cdn\/stories\/homepage\b/.test(r.url()) && r.ok(), { timeout: 45_000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const story = (await (await res).json()).story;
    await declineCookies(page);

    const campaigns = [];
    for (const c of carousel(story).slice(0, MAX_CAMPAIGN_PAGES)) {
      await sleep(400);
      await page.goto(new URL(c.link, BASE).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Coupon cards render a moment after the page, not all at once; pages without them just time out.
      await page
        .waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /norm\./.test(b.textContent)), null, { timeout: 8000 })
        .then(() => page.waitForTimeout(1500))
        .catch(() => {});
      campaigns.push({ ...c, ...(await page.evaluate(readCampaignPage)) });
    }
    return { story, campaigns };
  });

  const deals = [];
  const banners = [];
  for (const c of campaigns) {
    if (!c.coupons.length) {
      banners.push({ text: [c.name, c.title, c.description, c.h1].filter(Boolean).join(' | ').slice(0, 1200), link: new URL(c.link, BASE).href, image: c.image });
      continue;
    }
    for (const k of c.coupons) {
      const price = euros(k.price);
      if (price == null) continue;
      deals.push({
        id: `kotipizza:${slug(c.link)}-${slug(k.name)}`,
        name: k.name,
        brand: null,
        category: couponCategory(k.name),
        price,
        regularPrice: euros(k.regular),
        dealText: [k.size, c.name.replace(/\s*\d+\.\d*\.?\s*[–-].*$/, ''), 'coupon price when logged in (app or web shop)'].filter(Boolean).join(' · '),
        image: k.image,
        url: new URL(c.link, BASE).href,
        validUntil: c.end,
      });
    }
  }
  for (const p of picks(story)) banners.push(p);
  if (!deals.length && !banners.length) throw new Error('Kotipizza: no campaigns on the homepage — page layout may have changed');

  const analyses = await analyzeBanners('Kotipizza', banners, log);
  const fromAnalyst = banners
    .map((banner, index) => bannerToDeal({ source: 'kotipizza', store: 'Kotipizza', banner, analysis: analyses[index], index }))
    .filter(Boolean);
  log(`  kotipizza: ${campaigns.length} campaign pages → ${deals.length} coupon deals, ${banners.length} cards → ${fromAnalyst.length} campaigns`);
  return [...deals, ...fromAnalyst];
}

// Storyblok dates are UTC ("2026-11-05 21:00").
const utc = (s) => (s ? new Date(`${s.replace(' ', 'T')}Z`) : null);
const running = (o, now = Date.now()) => (!o.start || utc(o.start) <= now) && (!o.end || utc(o.end) >= now);

// Every block of the given components anywhere in the story, once each (the same card appears in
// several "contexts": morning, lunch, evening…).
function blocks(story, component) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o.component === component) out.push(o);
    for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
  };
  walk(story?.content);
  if (!out.length && component === 'carousel_image') throw new Error('Kotipizza: no hero carousel in the homepage data — page layout may have changed');
  return out;
}

// Running hero campaigns that link to their own page (not the menu or the app).
function carousel(story) {
  const seen = new Set();
  return blocks(story, 'carousel_image')
    .filter((o) => running(o) && o.link?.cached_url && !/^\/?(menu|sovellus)\/?$/.test(o.link.cached_url))
    .map((o) => ({ name: o.campaign_name ?? '', link: `/${o.link.cached_url.replace(/^\//, '')}`, end: utc(o.end)?.toISOString() ?? null, image: absolute(o.image_mobile || o.image) }))
    .filter((c) => !seen.has(c.link) && seen.add(c.link));
}

// "Picked for you" cards, as banners for the analyst.
function picks(story) {
  const seen = new Set();
  return blocks(story, 'custom_pick')
    .filter((o) => running(o) && o.title && !seen.has(o.title) && seen.add(o.title))
    .map((o) => ({
      text: [o.title, o.description, o.price, o.end && `Voimassa ${o.end.slice(0, 10)} asti`].filter(Boolean).join(' | ').slice(0, 1200),
      link: o.url ? new URL(o.url, BASE).href : BASE,
      image: absolute(o.image?.filename),
    }));
}

// Runs in the page: the campaign's headline, description and coupon cards.
function readCampaignPage() {
  const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const coupons = [...document.querySelectorAll('button')]
    .filter((b) => /norm\./.test(b.textContent) && /€/.test(b.textContent))
    .map((b) => {
      const name = b.querySelector('span');
      const leaves = [...b.querySelectorAll('div')].filter((d) => !d.children.length).map(text);
      return {
        name: text(name),
        description: text(name?.nextElementSibling),
        size: leaves.find((t) => /koko$/i.test(t)) ?? '',
        price: leaves.find((t) => /€/.test(t) && !/norm\./.test(t)) ?? '',
        regular: leaves.find((t) => /norm\./.test(t)) ?? '',
        image: b.querySelector('img')?.src ?? null,
      };
    })
    .filter((c) => c.name);
  return {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content ?? '',
    h1: text(document.querySelector('h1')),
    coupons,
  };
}

// Coupons have no category of their own; descriptions name "Kotipizza-juusto" or "pizzataikina" even
// for dips, so only the name counts. Salads go to "Other" (some have chicken); the rest are pizzas.
function couponCategory(name) {
  if (/kombo/i.test(name)) return 'Meals & combos';
  if (/rulla|kotzone/i.test(name)) return 'Wraps & subs';
  if (/dippi|tanko|snacks|siipi|wings/i.test(name)) return 'Sides & dips';
  return /salaatti/i.test(name) ? 'Other offers' : 'Pizza';
}

const euros = (s) => {
  const m = String(s ?? '').match(/(\d+)(?:[,.](\d{1,2}))?\s*€/);
  return m ? Number(`${m[1]}.${m[2] ?? 0}`) : null;
};
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const absolute = (u) => (u ? (u.startsWith('//') ? `https:${u}` : u) : null);
