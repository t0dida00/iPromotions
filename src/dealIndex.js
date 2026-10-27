import config from '../config.js';
import { readSegment, SEGMENTS } from './store.js';
import { cachedOffers } from './wolt.js';

// Retrieval for the deals assistant (src/chat.js): every section's deals plus the cached Wolt
// offers for the default location, in ONE list. Sections are not a boundary: a question about
// clothes must also find the clothes Tokmanni and Prisma sell (groceries "Clothing & shoes"), so
// documents are matched by topic (what the item is) and keywords, never by the section they were
// crawled for. Plain code, no embeddings: the model turns the question into topics, stores and
// English + Finnish keywords (src/chat.js), and this file filters and ranks.

const REFRESH_MS = 5 * 60_000; // how often to check whether a section was re-crawled
const WOLT_COLOR = '#009de0';

// Lowercase, no accents ("Café" → "cafe"); keywords are folded the same way.
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SHOE = /kenka|kengat|saapas|saappaat|tossu|sandaali|tennari|lenkkari|shoe|boot|sneaker|sandal/;
const FOOD_GROUPS = new Set(['Meat & fish', 'Fruit & vegetables', 'Dairy, cheese & eggs', 'Ready meals & frozen', 'Bread & bakery', 'Drinks', 'Sweets & snacks', 'Pantry & other food']);
const isRestaurant = (d) => d.segment === 'food' || d.source === 'wolt';

// Broad families: a keyword match outside the chosen topics only counts inside the same family, so
// "chicken" (kana) never brings in bed sheets, and "shirt" never brings in a pizza.
const FAMILIES = {
  food: (d) => FOOD_GROUPS.has(d.group) || isRestaurant(d),
  clothing: (d) => d.segment === 'clothing' || d.group === 'Clothing & shoes',
  electronics: (d) => d.segment === 'electronics' || d.group === 'Electronics',
};
const FAMILY_OF = { groceries: 'food', meat: 'food', drinks: 'food', dairy: 'food', produce: 'food', bakery: 'food', frozen: 'food', snacks: 'food', pantry: 'food', restaurants: 'food', clothing: 'clothing', shoes: 'clothing', electronics: 'electronics' };

// Topic → which documents belong to it, across sections. The model picks topics from this list.
export const TOPICS = {
  clothing: { label: 'clothes, shoes and accessories from any store', test: (d) => d.segment === 'clothing' || d.group === 'Clothing & shoes' },
  shoes: { label: 'shoes and boots', test: (d) => d.group === 'Shoes' || (d.group === 'Clothing & shoes' && SHOE.test(d.text)) },
  electronics: { label: 'electronics and appliances from any store', test: (d) => d.segment === 'electronics' || d.group === 'Electronics' },
  groceries: { label: 'any food or drink from supermarkets', test: (d) => FOOD_GROUPS.has(d.group) },
  meat: { label: 'meat, chicken and fish', test: (d) => d.group === 'Meat & fish' },
  drinks: { label: 'drinks (soft drinks, juice, coffee, beer…), also restaurant drink offers', test: (d) => d.group === 'Drinks' },
  dairy: { label: 'milk, cheese, yoghurt, eggs', test: (d) => d.group === 'Dairy, cheese & eggs' },
  produce: { label: 'fruit and vegetables', test: (d) => d.group === 'Fruit & vegetables' },
  bakery: { label: 'bread and bakery', test: (d) => d.group === 'Bread & bakery' },
  frozen: { label: 'ready meals and frozen food', test: (d) => d.group === 'Ready meals & frozen' },
  snacks: { label: 'sweets, chocolate, chips, snacks', test: (d) => d.group === 'Sweets & snacks' },
  pantry: { label: 'pasta, rice, sauces, canned and other dry food', test: (d) => d.group === 'Pantry & other food' },
  restaurants: { label: 'fast food and restaurant offers (Hesburger, Burger King, Wolt restaurants)', test: isRestaurant },
  home: { label: 'home, decor, kitchenware', test: (d) => d.group === 'Home & decor' },
  cleaning: { label: 'cleaning and household supplies', test: (d) => d.group === 'Cleaning & household' },
  beauty: { label: 'beauty, health, cosmetics, personal care', test: (d) => d.group === 'Beauty & health' || d.group === 'Personal care' },
  kids: { label: 'kids and toys', test: (d) => d.group === 'Kids & toys' },
  pets: { label: 'pet food and supplies', test: (d) => d.group === 'Pets' },
  garden: { label: 'garden, car and DIY', test: (d) => d.group === 'Garden, car & DIY' },
  hobbies: { label: 'leisure, crafts, sports gear, office', test: (d) => d.group === 'Leisure & crafts' },
};

let index = null; // { docs, groups, versions, checkedAt }

// A Wolt venue with its offers, shaped like a deal. Discount % comes from offer texts like "-30%".
function woltDoc(v) {
  const offers = v.offers.map((o) => o.text);
  const pct = Math.max(0, ...offers.map((t) => Number(/(\d{1,2})\s*%/.exec(t)?.[1] ?? 0)));
  return {
    id: `wolt:${v.id}`,
    source: 'wolt',
    store: `Wolt · ${v.name}`,
    name: v.name,
    brand: null,
    category: (v.tags ?? []).join(', ') || v.description,
    group: 'Restaurants (Wolt)',
    segment: 'food',
    price: null,
    regularPrice: null,
    discountPct: pct || null,
    dealText: offers.join(' · '),
    image: v.image,
    url: v.url,
    validUntil: null,
  };
}

const withText = (d) => ({
  ...d,
  nameText: fold(`${d.name} ${d.brand ?? ''}`),
  groupText: fold(`${d.group ?? ''} ${d.category ?? ''}`),
  text: fold(`${d.name} ${d.brand ?? ''} ${d.category ?? ''} ${d.group ?? ''} ${d.store ?? ''} ${d.dealText ?? ''}`),
});

// Reads the sections again only when one of them was re-crawled (checked every few minutes).
async function load() {
  if (index && Date.now() - index.checkedAt < REFRESH_MS) return index;
  const segments = await Promise.all(SEGMENTS.map(readSegment));
  const versions = segments.map((s) => s.updatedAt).join('|');
  if (index?.versions === versions) {
    index.checkedAt = Date.now();
    return index;
  }
  const docs = segments.flatMap((s) => s.deals).map(withText);
  const groups = [...new Set(docs.map((d) => d.group).filter(Boolean))].sort();
  index = { docs, groups, versions, checkedAt: Date.now() };
  return index;
}

// Deals plus the Wolt venues cached for the default location (never starts a new Wolt lookup).
async function documents() {
  const { docs } = await load();
  const def = config.wolt?.defaultLocation;
  const wolt = def ? await cachedOffers(def.lat, def.lon).catch(() => null) : null;
  const now = Date.now();
  const live = docs.filter((d) => !d.validUntil || Date.parse(d.validUntil) >= now);
  return wolt?.venues?.length ? [...live, ...wolt.venues.map(woltDoc).map(withText)] : live;
}

// Changes whenever a section is re-crawled or the Wolt offers are looked up again: cached answers
// (src/chat.js) are keyed on it, so a new crawl never serves yesterday's deals.
export async function dataVersion() {
  const { versions } = await load();
  const def = config.wolt?.defaultLocation;
  const wolt = def ? await cachedOffers(def.lat, def.lon).catch(() => null) : null;
  return `${versions}|${wolt?.fetchedAt ?? ''}`;
}

// What the model may choose from: every group name in the data, and every store key.
export async function vocabulary() {
  const { groups } = await load();
  const stores = Object.fromEntries(Object.entries(config.sources).filter(([, s]) => s.type).map(([k, s]) => [k, s.name]));
  return { groups: [...groups, 'Restaurants (Wolt)'], stores: { ...stores, wolt: 'Wolt restaurants (Oulu)' }, topics: Object.keys(TOPICS) };
}

const pctOf = (d) => d.discountPct ?? (d.price && d.regularPrice > d.price ? Math.round((1 - d.price / d.regularPrice) * 100) : 0);
const discounted = (d) => pctOf(d) > 0 || Boolean(d.dealText);

// A keyword matches at the start of a word ("kana" → "kananpojan"). Keywords of 5+ letters also
// match at the end of a compound, plus up to 3 letters of Finnish ending ("broileri" →
// "maissibroileria"). Never in the middle of an unrelated word: "kana" must not match
// "pussilakanasetti" (a duvet cover set) or "porkkanaa" (carrot), so short words match starts only.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keywordRe = (k) =>
  new RegExp(`(?:^|[^\\p{L}])${escapeRe(k)}${k.length >= 5 ? `|${escapeRe(k)}\\p{L}{0,3}(?:$|[^\\p{L}])` : ''}`, 'u');

// Keyword hits: in the name counts most, then group/category, then anywhere (store, offer text).
function keywordScore(d, keywords) {
  let score = 0;
  for (const re of keywords) {
    if (re.test(d.nameText)) score += 3;
    else if (re.test(d.groupText)) score += 2;
    else if (re.test(d.text)) score += 1;
  }
  return score;
}

// Candidates for an intent, best first: { doc, score }. A document qualifies when it belongs to a
// chosen topic or group, or (from any section) when a keyword is in its name; topic members rank
// above keyword-only matches. Stores and price/discount limits are hard filters.
async function rank(intent) {
  const docs = await documents();
  const topics = intent.topics.map((t) => TOPICS[t]).filter(Boolean);
  const groups = new Set(intent.groups);
  const keywords = intent.keywords.map(fold).filter((k) => k.length >= 3).map(keywordRe);
  const families = [...new Set(intent.topics.map((t) => FAMILY_OF[t]).filter(Boolean))].map((f) => FAMILIES[f]);
  const stores = new Set(intent.stores);
  const scoped = topics.length > 0 || groups.size > 0;
  const out = [];
  for (const d of docs) {
    if (stores.size && !stores.has(d.source)) continue;
    if (intent.maxPrice != null && !(d.price != null && d.price <= intent.maxPrice)) continue;
    if (intent.minDiscount != null && pctOf(d) < intent.minDiscount) continue;
    if (intent.onlyDiscounted && !discounted(d)) continue;
    const inTopic = topics.some((t) => t.test(d)) || groups.has(d.group);
    const kw = keywords.length ? keywordScore(d, keywords) : 0;
    // Outside the topics, a name match counts only within the topics' family (none: no outside matches).
    const nameHit = keywords.some((re) => re.test(d.nameText)) && (!scoped || (families.length > 0 && families.some((f) => f(d))));
    // With keywords (a specific product: "kana", "burger") an item must match one of them; topics
    // then only decide which families count. Without keywords (a whole category: "meat", "drinks")
    // the topic decides. Only a store named: the whole store.
    const keep = keywords.length ? kw > 0 && (!scoped || inTopic || nameHit) : scoped ? inTopic : stores.size > 0;
    if (!keep) continue;
    // tier: in the topic and/or matching a keyword. Sorting by discount or price happens inside a
    // tier, so "cheapest burger" doesn't put a cheap pizza first just because it is a restaurant.
    out.push({ doc: d, score: (inTopic ? 10 : 0) + kw, tier: (inTopic ? 1 : 0) + (kw > 0 ? 1 : 0) });
  }
  const by = {
    discount: (a, b) => b.tier - a.tier || pctOf(b.doc) - pctOf(a.doc) || b.score - a.score,
    price: (a, b) => b.tier - a.tier || (a.doc.price ?? Infinity) - (b.doc.price ?? Infinity) || b.score - a.score,
  }[intent.sort] ?? ((a, b) => b.score - a.score || pctOf(b.doc) - pctOf(a.doc));
  return out.sort(by);
}

// Up to `limit` items, mixing stores so every store with matches gets a turn: within each tier
// (best matches first) the stores take turns, each giving its next best item. "Clothes on sale"
// then shows Tokmanni and Prisma next to XXL and KappAhl instead of 12 items from one store.
// Colour/size variants (same store, name and price) count once.
function diverse(ranked, limit) {
  const seen = new Set();
  const tiers = new Map(); // tier -> Map(store -> items), in ranked order
  for (const r of ranked) {
    const key = `${r.doc.store}|${r.doc.nameText}|${r.doc.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stores = tiers.get(r.tier) ?? tiers.set(r.tier, new Map()).get(r.tier);
    (stores.get(r.doc.store) ?? stores.set(r.doc.store, []).get(r.doc.store)).push(r);
  }
  const picked = [];
  for (const tier of [...tiers.keys()].sort((a, b) => b - a)) {
    const queues = [...tiers.get(tier).values()];
    while (picked.length < limit && queues.some((q) => q.length)) for (const q of queues) if (q.length && picked.length < limit) picked.push(q.shift());
    if (picked.length >= limit) break;
  }
  return picked;
}

// How many matched well: the items in the best tier ("TVs under 300 €" counts TVs, not every
// electronics deal under 300 € that only shares the topic).
const matches = (ranked) => {
  const best = Math.max(0, ...ranked.map((r) => r.tier));
  return ranked.filter((r) => r.tier === best).length;
};

// Deal fields the browser shows (search text and internals stay on the server).
export const card = (d) => ({
  id: d.id,
  source: d.source,
  store: d.store,
  color: d.source === 'wolt' ? WOLT_COLOR : config.sources[d.source]?.color ?? '#555',
  name: d.name,
  brand: d.brand ?? null,
  group: d.group ?? null,
  price: d.price ?? null,
  regularPrice: d.regularPrice ?? null,
  discountPct: pctOf(d) || null,
  dealText: d.dealText ?? null,
  image: d.image ?? null,
  url: d.url ?? null,
  validUntil: d.validUntil ?? null,
});

// "Discounted meat", "drinks on sale": the best `limit` items and how many matched in total.
export async function search(intent) {
  const ranked = await rank(intent);
  return { total: matches(ranked), items: diverse(ranked, intent.limit).map((r) => card(r.doc)) };
}

// "Where can I get a discounted burger?": the stores with matching deals, best 3 of each.
export async function whereToBuy(intent, maxStores = 8) {
  const ranked = await rank(intent);
  const stores = new Map();
  for (const r of ranked) {
    const s = stores.get(r.doc.store) ?? { store: r.doc.store, source: r.doc.source, count: 0, bestDiscount: 0, items: [] };
    s.count++;
    s.bestDiscount = Math.max(s.bestDiscount, pctOf(r.doc));
    if (s.items.length < 3) s.items.push(card(r.doc));
    stores.set(r.doc.store, s);
  }
  // Ranked order already puts the most relevant first; a store's place is its best item's.
  const list = [...stores.values()].slice(0, maxStores).map((s) => ({ ...s, color: s.items[0].color }));
  return { total: matches(ranked), stores: list };
}

// "What's on sale at Lidl?": the whole store across sections, counts per group and the top deals.
export async function storeOverview(source, limit = 10) {
  const docs = (await documents()).filter((d) => d.source === source);
  const pcts = docs.map(pctOf).filter((p) => p > 0);
  const groups = new Map();
  for (const d of docs) groups.set(d.group ?? 'Other', (groups.get(d.group ?? 'Other') ?? 0) + 1);
  const top = [...docs].sort((a, b) => pctOf(b) - pctOf(a));
  // Spread the top list over groups too, so it isn't 10 items of one kind.
  const perGroup = new Map();
  const items = [];
  for (const d of top) {
    const n = perGroup.get(d.group) ?? 0;
    if (n < 3) items.push(d), perGroup.set(d.group, n + 1);
    if (items.length >= limit) break;
  }
  return {
    store: source === 'wolt' ? 'Wolt restaurants' : config.sources[source]?.name ?? source,
    source,
    total: docs.length,
    discounted: pcts.length,
    avgDiscount: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
    maxDiscount: pcts.length ? Math.max(...pcts) : null,
    groups: [...groups].sort((a, b) => b[1] - a[1]).map(([group, count]) => ({ group, count })),
    items: items.map(card),
  };
}
