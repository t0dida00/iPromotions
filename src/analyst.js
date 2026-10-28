import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.js';

// "Campaign analyst": an LLM (Hugging Face Inference, OpenAI-compatible chat API) that reads the
// text gathered around each hero banner — headline, terms, link, the linked page's title and
// description — and turns it into a structured campaign, or says it isn't one.
//
// The model is text-only (openai/gpt-oss-120b by default); it never sees the banner picture.
// Configure with NUXT_HF_TOKEN and NUXT_HF_MODEL in .env. Results are cached per banner text in
// data/analyst-cache.json, so unchanged banners never call the model again.
const API = 'https://router.huggingface.co/v1/chat/completions';
const CACHE_FILE = path.join(DATA_DIR, 'analyst-cache.json');
const CATEGORIES = ['Burgers', 'Chicken', 'Pizza', 'Meals & combos', 'Lunch deals', 'Vegetarian', 'Desserts & ice cream', 'Sides & dips', 'Drinks', 'Wraps & subs', 'Other offers'];

const SYSTEM = `You analyse fast-food marketing banners from Finnish restaurant websites.
For each banner you get the text found around it (Finnish). Decide whether it advertises a
customer offer or campaign (a new product, a discount, a meal deal, a limited-time product, an
app or delivery offer). Banners about finding a restaurant, jobs, company news, loyalty sign-up
without a concrete offer, or shop merchandise are NOT campaigns.
Answer with JSON only: {"campaigns":[...]} with one object per banner, in the same order:
{"index": number, "isCampaign": boolean,
 "title": short English title (max 60 chars),
 "offer": one English sentence describing the deal (max 160 chars),
 "price": number in euros or null, "regularPrice": number or null,
 "discountPct": number or null (e.g. -40 % -> 40),
 "validFrom": "YYYY-MM-DD" or null, "validUntil": "YYYY-MM-DD" or null,
 "channel": where it applies, e.g. "Restaurants", "Wolt & Uber Eats only", "App only", or null,
 "category": one of ${JSON.stringify(CATEGORIES)}}
"price" is what the customer pays for the advertised deal. For "get X free when you buy Y"
offers, leave price, regularPrice and discountPct null and explain the freebie in "offer".
Only state prices and dates that appear in the text; never invent them. Today is {TODAY}.`;

// Bump when SYSTEM changes so cached analyses are redone with the new instructions.
const PROMPT_VERSION = 3;

export const analystEnabled = () => Boolean(process.env.NUXT_HF_TOKEN);

const readCache = () => readJson(CACHE_FILE, {});

const keyOf = (store, b) => crypto.createHash('sha1').update(JSON.stringify([PROMPT_VERSION, store, b.text, b.link])).digest('hex');

// banners: [{ text, link, image }] → same-length array of analysis objects (or null when the
// analyst is unavailable). Only banners not in the cache are sent to the model, in one request.
export async function analyzeBanners(store, banners, log = console.log) {
  if (!banners.length) return [];
  const cache = await readCache();
  const keys = banners.map((b) => keyOf(store, b));
  const todo = banners.map((b, i) => ({ b, i })).filter(({ i }) => !cache[keys[i]]);

  if (todo.length && analystEnabled()) {
    const today = new Date().toISOString().slice(0, 10);
    const user = todo.map(({ b }, n) => `Banner ${n}:\nLink: ${b.link ?? '-'}\nText: ${b.text}`).join('\n\n');
    const started = Date.now();
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.NUXT_HF_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.NUXT_HF_MODEL || 'openai/gpt-oss-120b',
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM.replace('{TODAY}', today) },
          { role: 'user', content: `${store} — ${todo.length} banner(s):\n\n${user}` },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Campaign analyst: Hugging Face returned ${res.status} ${(await res.text()).slice(0, 200)}`);
    const reply = (await res.json()).choices?.[0]?.message?.content ?? '';
    const parsed = parseJson(reply)?.campaigns;
    if (!Array.isArray(parsed)) throw new Error('Campaign analyst: model reply was not the expected JSON');
    for (const c of parsed) {
      const t = todo[c.index];
      if (t) cache[keys[t.i]] = { ...c, index: undefined, analyzedAt: new Date().toISOString() };
    }
    log(`  analyst: ${todo.length} new banner(s) for ${store} analysed in ${Math.round((Date.now() - started) / 1000)}s`);
    await writeJson(CACHE_FILE, cache);
  } else if (todo.length) {
    log(`  analyst: NUXT_HF_TOKEN not set — ${todo.length} banner(s) for ${store} not analysed`);
  }
  return keys.map((k) => cache[k] ?? null);
}

// Models sometimes wrap JSON in prose or code fences; take the outermost {...}.
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

// Turn a banner + its analysis into a deal for the Food section. Without an analysis (no token,
// or the model failed) the banner is still shown with its raw headline.
export function bannerToDeal({ source, store, banner, analysis, index }) {
  if (analysis && !analysis.isCampaign) return null;
  const a = analysis ?? {};
  // A €0 "price" means a freebie with a purchase, not a free deal: show the description instead.
  const price = typeof a.price === 'number' && a.price > 0 ? a.price : null;
  const fallbackTitle = banner.text.split(/[.|\n]/)[0].slice(0, 70) || `${store} campaign`;
  return {
    id: `${source}:hero-${crypto.createHash('sha1').update(banner.link ?? banner.image ?? String(index)).digest('hex').slice(0, 10)}`,
    source,
    store,
    name: a.title || fallbackTitle,
    brand: null,
    category: a.category || banner.text,
    price,
    regularPrice: price != null && typeof a.regularPrice === 'number' && a.regularPrice > price ? a.regularPrice : null,
    discountPct: typeof a.discountPct === 'number' && a.discountPct > 0 && a.discountPct < 100 ? a.discountPct : null,
    dealText: [a.offer, a.channel].filter(Boolean).join(' · ') || null,
    image: banner.image ?? null,
    url: banner.link ?? null,
    validUntil: a.validUntil ? `${a.validUntil}T23:59:59+02:00` : null,
    analyzed: Boolean(analysis),
  };
}
