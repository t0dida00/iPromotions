// Edit these to point the crawler at different stores or change the schedule.
export default {
  port: Number(process.env.PORT) || 3000,

  // Automatic refresh, in node-cron syntax (Helsinki time). Off by default: the owner refreshes by
  // hand. e.g. CRON_SCHEDULE="0 6 * * 3" for every Wednesday at 06:00.
  schedule: process.env.CRON_SCHEDULE || null,
  timezone: 'Europe/Helsinki',

  // Sections refreshed on their own schedule instead of the one above (same syntax and timezone;
  // also off unless set), e.g. FOOD_CRON_SCHEDULE="0 9 * * *" for Food every morning.
  sectionSchedules: {
    food: process.env.FOOD_CRON_SCHEDULE || null,
  },

  // How many stores to crawl at the same time. Each K-Ruoka/Prisma crawl runs its own headless
  // browser, so lower this on a small machine. Default: all stores at once.
  concurrency: Number(process.env.CRAWL_CONCURRENCY) || 5,

  // After a store is refreshed by hand, its Refresh buttons can stay unavailable for this many
  // minutes so repeated clicks don't hammer the store's website. Off (0) by default: only the owner
  // refreshes. A schedule (if set) ignores it.
  refreshCooldownMinutes: Number(process.env.REFRESH_COOLDOWN_MINUTES) || 0,

  // Per-IP request limits against bots (see src/rateLimit.js). Normal browsing stays far below.
  rateLimits: {
    crawl: { windowMs: 10 * 60_000, max: 5 }, // POST /api/crawl (Refresh buttons)
    api: { windowMs: 60_000, max: 120 }, // other /api/* calls
    pages: { windowMs: 60_000, max: 600 }, // pages, scripts, logos
    wolt: { windowMs: 10 * 60_000, max: 6 }, // Wolt lookups for a new location (each opens Chromium)
    scan: { windowMs: 10 * 60_000, max: 30 }, // expiry-date photo checks (each calls the vision model)
    checkout: { windowMs: 10 * 60_000, max: 10 }, // opening a Stripe payment page
    chat: { windowMs: 10 * 60_000, max: 20 }, // deals assistant questions (each calls the text model)
    share: { windowMs: 10 * 60_000, max: 10 }, // deals posted to Shared by buddy
  },

  // "Follow your discount": photo checks per signed-in user per day (bounds the AI cost).
  expiryScansPerDay: Number(process.env.EXPIRY_SCANS_PER_DAY) || 60,

  // Checks for "Follow your discount" (src/credits.js, /pricing). A check costs 1 only when a date
  // is found. New accounts get `freeChecks`, then `weeklyChecks` every week. Prices in euro cents,
  // VAT included; paid through Stripe Checkout (src/billing.js).
  credits: {
    freeChecks: 3,
    weeklyChecks: 1,
    unlimitedPerDay: 100, // fair use while Unlimited is active
    plans: {
      pack10: { name: '10 checks', checks: 10, cents: 899 },
      pack25: { name: '25 checks', checks: 25, cents: 1499 },
      unlimited30: { name: 'Unlimited for 30 days', days: 30, cents: 2499 },
    },
  },

  // Deals assistant (floating chat, src/chat.js): questions about this week's deals, answered from
  // the crawled data. An answered question costs 1 check (same balance as photo checks); questions
  // that are refused or find nothing are free. `perDay` caps one user's questions per day.
  chat: {
    maxChars: 300,
    perDay: Number(process.env.CHAT_QUESTIONS_PER_DAY) || 100,
    maxItems: 24,
  },

  // Wolt offers in Food Promotions are looked up live for the visitor's location (src/wolt.js),
  // not crawled. Results are cached per ~1 km area. The panel opens on `defaultLocation` (Oulu);
  // the visitor's own location is only used after they press "Update location".
  wolt: {
    cacheMinutes: 6 * 60, // 6 hours: nearby visitors share one lookup (each new one opens Chromium, ~50 s on Vercel)
    maxCachedLocations: 200,
    defaultLocation: { lat: 65.0121, lon: 25.4651, city: 'Oulu', name: 'Oulu city center' },
  },

  // Each key becomes a store tab in the UI. `type` picks the crawler; `name` is the tab label,
  // `label` the full store name, `color` the badge color, `logo` a file in public/logos, `brochureUrl` the link shown in the
  // "Weekly brochures" section. A store with `type: null` is brochure-only (no deals crawled).
  // `segment` picks the sidebar section: 'groceries' (default, Market Promotions), 'clothing'
  // (Cloth Promotions), 'electronics' (Electronics Promotions), 'food' (Food Promotions) or 'beauty'
  // (Beauty & Health Promotions).
  sources: {
    tokmanni: {
      type: 'tokmanni',
      enabled: true,
      name: 'Tokmanni',
      label: 'Tokmanni',
      color: '#e2001a',
      logo: '/logos/tokmanni.png',
      url: 'https://www.tokmanni.fi/viikkotarjoukset',
      brochureUrl: 'https://www.tokmanni.fi/tarjouslehti',
    },
    // K-Ruoka flyers: change ?kauppa= to switch branch (K-Market is intentionally not included).
    // Crawled from the owner's computer only: k-ruoka.fi answers data-centre servers (and sometimes
    // home connections too) with a Cloudflare challenge, which we don't try to get around. Then the
    // crawl fails and the store keeps its previous deals.
    ksupermarket: {
      type: 'kruoka',
      enabled: true,
      name: 'K-Supermarket',
      label: 'K-Supermarket Kaijonharju',
      color: '#ff6b00',
      logo: '/logos/ksupermarket.svg',
      url: 'https://www.k-ruoka.fi/k-supermarket/tarjouslehti?kauppa=k-supermarket-kaijonharju',
      brochureUrl: 'https://www.k-ruoka.fi/k-supermarket/tarjouslehti?kauppa=k-supermarket-kaijonharju',
    },
    kcitymarket: {
      type: 'kruoka',
      enabled: true,
      name: 'K-Citymarket',
      label: 'K-Citymarket Raksila',
      color: '#003a8c',
      logo: '/logos/kcitymarket.svg',
      url: 'https://www.k-ruoka.fi/k-citymarket/tarjouslehti?kauppa=k-citymarket-oulu-raksila',
      brochureUrl: 'https://www.k-ruoka.fi/kauppa/tarjoushaku',
    },
    prisma: {
      type: 'prisma',
      enabled: true,
      name: 'Prisma',
      label: 'Prisma Linnanmaa',
      color: '#00843d',
      logo: '/logos/prisma.svg',
      // S-group store id (Prisma Linnanmaa). Any S-group store with an online shop works (Prisma,
      // S-market; Sale and Prisma Raksila list nothing). List Oulu's ids by POSTing
      // {"query":"{ searchStores(query: \"oulu\") { stores { id name } } }"} to https://api.s-kaupat.fi/
      // with the header x-client-name: skaupat-web.
      storeId: '603116906',
      // Prisma has no public weekly flyer page; S-kaupat's campaign page is the closest equivalent.
      brochureUrl: 'https://www.s-kaupat.fi/tuotteet/kampanjat',
    },
    // Lidl prices are national; crawls this week's campaign pages linked from lidl.fi.
    lidl: {
      type: 'lidl',
      enabled: true,
      name: 'Lidl',
      label: 'Lidl Finland',
      color: '#0050aa',
      logo: '/logos/lidl.svg',
      brochureUrl: 'https://www.lidl.fi/c/tarjouslehdet/s10019134',
    },

    // ── Clothing (sidebar: Cloth Promotions) ──────────────────────────────────────────────
    // Chain prices are national; `label` names the nearest Oulu store where known.
    xxl: {
      type: 'xxl',
      segment: 'clothing',
      enabled: true,
      name: 'XXL',
      label: 'XXL Oulu Limingantulli',
      color: '#111111',
      logo: '/logos/xxl.svg',
      url: 'https://www.xxl.fi/kampanjat',
      clothingOnly: true, // the campaign also has sports equipment; keep clothing and shoes
      brochureUrl: 'https://www.xxl.fi/kampanjat',
    },
    // Sale-page links only: H&M and Lindex block automated browsers.
    hm: {
      type: null,
      segment: 'clothing',
      enabled: true,
      name: 'H&M',
      label: 'H&M Finland',
      color: '#e50010',
      brochureUrl: 'https://www2.hm.com/fi_fi/ale.html',
    },
    lindex: {
      type: null,
      segment: 'clothing',
      enabled: true,
      name: 'Lindex',
      label: 'Lindex Finland',
      color: '#1a1a1a',
      brochureUrl: 'https://www.lindex.com/fi/ale',
    },
    kappahl: {
      type: 'kappahl',
      segment: 'clothing',
      enabled: true,
      name: 'KappAhl',
      label: 'KappAhl Outlet',
      color: '#003b5c',
      url: 'https://www.kappahl.com/fi-fi/kappahl-outlet',
      brochureUrl: 'https://www.kappahl.com/fi-fi/tarjoukset',
    },
    newyorker: {
      type: 'newyorker',
      segment: 'clothing',
      enabled: true,
      name: 'New Yorker',
      label: 'New Yorker Finland (in-store prices)',
      color: '#000000',
      brochureUrl: 'https://www.newyorker.de/fi/',
    },
    intersport: {
      type: 'intersport',
      segment: 'clothing',
      enabled: true,
      name: 'Intersport',
      label: 'Intersport Finland',
      color: '#0a3a8c',
      logo: '/logos/intersport.svg',
      brochureUrl: 'https://www.intersport.fi/fi/ale/vaatteet-ale-ja-tarjoukset/',
    },
    stadium: {
      type: 'stadium',
      segment: 'clothing',
      enabled: true,
      name: 'Stadium',
      label: 'Stadium Finland',
      url: 'https://www.stadium.fi/tag/alehintaiset-tuotteet',
      clothingOnly: true, // the sale also has sports equipment; keep clothing and shoes
      color: '#0b1f3a',
      brochureUrl: 'https://www.stadium.fi/tag/alehintaiset-tuotteet',
    },

    // ── Electronics (sidebar: Electronics Promotions) ─────────────────────────────────────
    // Chain prices are national. Power and Gigantti also have outlet lists (thousands of
    // demo/returned items); add them with `urls` if wanted.
    power: {
      type: 'power',
      segment: 'electronics',
      enabled: true,
      name: 'Power',
      label: 'Power Finland',
      color: '#f96700',
      logo: '/logos/power.svg',
      brochureUrl: 'https://www.power.fi/tarjoukset/kampanja/',
    },
    verkkokauppa: {
      type: 'verkkokauppa',
      segment: 'electronics',
      enabled: true,
      name: 'Verkkokauppa.com',
      label: 'Verkkokauppa.com',
      color: '#e3101b',
      logo: '/logos/verkkokauppa.svg',
      url: 'https://www.verkkokauppa.com/fi/tarjoukset',
      brochureUrl: 'https://www.verkkokauppa.com/fi/tarjoukset',
    },
    gigantti: {
      type: 'gigantti',
      segment: 'electronics',
      enabled: true,
      name: 'Gigantti',
      label: 'Gigantti Oulu (Kallisensuora 12)',
      color: '#1e1b58',
      logo: '/logos/gigantti.svg',
      brochureUrl: 'https://www.gigantti.fi/kampanja',
    },

    // ── Beauty & health (sidebar: Beauty & Health Promotions) ────────────────────────────────
    // Online prices, the same in the Oulu stores. KICKS is at Ideapark Oulu.
    kicks: {
      type: 'kicks',
      segment: 'beauty',
      enabled: true,
      name: 'KICKS',
      label: 'KICKS Oulu Ideapark',
      color: '#111111',
      brochureUrl: 'https://www.kicks.fi/tarjouksessa-nyt',
    },
    // Member prices (free loyalty card) and the outlet. YA's Oulu pharmacy is at Isokatu 27.
    ya: {
      type: 'ya',
      segment: 'beauty',
      enabled: true,
      name: 'Yliopiston Apteekki',
      label: 'Yliopiston Apteekki Oulu',
      color: '#1e7d4f',
      brochureUrl: 'https://www.yliopistonapteekki.fi/tarjoukset',
    },

    // ── Fast food (sidebar: Food Promotions) ──────────────────────────────────────────────
    // Offers are national. McDonald's and Subway block automated visitors (McDonald's returns
    // "Access Denied", subway.fi runs an anti-bot challenge), so they're links only.
    hesburger: {
      type: 'hesburger',
      segment: 'food',
      enabled: true,
      name: 'Hesburger',
      label: 'Hesburger campaigns (prices in app / restaurant)',
      color: '#e30613',
      logo: '/logos/hesburger.png',
      brochureUrl: 'https://www.hesburger.fi/tuotteet/kampanjat',
    },
    burgerking: {
      type: 'burgerking',
      segment: 'food',
      enabled: true,
      name: 'Burger King',
      label: 'Burger King offers',
      color: '#d62300',
      logo: '/logos/burgerking.png',
      brochureUrl: 'https://burgerking.fi/tarjoukset/',
    },
    // Classic Pizza, Taco Bell and Rax are Restel chains on one website theme (src/crawlers/restel.js):
    // `url` is the page with their campaign blocks. All three have restaurants in Oulu.
    classicpizza: {
      type: 'restel',
      segment: 'food',
      enabled: true,
      name: 'Classic Pizza',
      label: 'Classic Pizza campaigns (Oulu: Valkea)',
      color: '#23512c',
      logo: '/logos/classicpizza.svg',
      url: 'https://classicpizza.fi/kampanjat/',
      brochureUrl: 'https://classicpizza.fi/kampanjat/',
    },
    tacobell: {
      type: 'restel',
      segment: 'food',
      enabled: true,
      name: 'Taco Bell',
      label: 'Taco Bell campaigns (Oulu: Kirkkokatu 14)',
      color: '#702082',
      url: 'https://tacobell.fi/',
      brochureUrl: 'https://tacobell.fi/',
    },
    rax: {
      type: 'restel',
      segment: 'food',
      enabled: true,
      name: 'Rax',
      label: 'Rax Pizzabuffet campaigns (Oulu: Ideapark, Pekuri)',
      color: '#c8102e',
      logo: '/logos/rax.svg',
      url: 'https://www.rax.fi/',
      brochureUrl: 'https://www.rax.fi/',
    },
    // National campaigns and app coupons; many restaurants in Oulu.
    kotipizza: {
      type: 'kotipizza',
      segment: 'food',
      enabled: true,
      name: 'Kotipizza',
      label: 'Kotipizza campaigns and coupons',
      color: '#00593e',
      logo: '/logos/kotipizza.svg',
      brochureUrl: 'https://www.kotipizza.fi/',
    },
    // Pizza Hut (Oulu: Kirkkokatu 27) shows its offers as pictures only, with no text to read: link only.
    pizzahut: {
      type: null,
      segment: 'food',
      enabled: true,
      name: 'Pizza Hut',
      label: 'Pizza Hut offers (Oulu: Kirkkokatu 27)',
      color: '#c8102e',
      brochureUrl: 'https://www.pizzahut.fi/tarjoukset/',
    },
    mcdonalds: {
      type: null,
      segment: 'food',
      enabled: true,
      name: "McDonald's",
      label: "McDonald's Finland (offers in the app)",
      color: '#ffbc0d',
      brochureUrl: 'https://www.mcdonalds.com/fi/fi-fi.html',
    },
    subway: {
      type: null,
      segment: 'food',
      enabled: true,
      name: 'Subway',
      label: 'Subway Finland',
      color: '#008938',
      brochureUrl: 'https://www.subway.fi/',
    },
  },
};
