// Edit these to point the crawler at different stores or change the schedule.
export default {
  port: Number(process.env.PORT) || 3000,

  // node-cron syntax. Default: every Wednesday at 06:00 (Helsinki time).
  // e.g. CRON_SCHEDULE="0 6 * * 1,4" for Monday + Thursday when the weekly flyers start.
  schedule: process.env.CRON_SCHEDULE || '0 6 * * 3',
  timezone: 'Europe/Helsinki',

  // Sections refreshed on their own schedule instead of the weekly one above (same syntax and
  // timezone). Fast-food campaigns change often, so Food Promotions is refreshed every morning.
  sectionSchedules: {
    food: process.env.FOOD_CRON_SCHEDULE || '0 9 * * *',
  },

  // How many stores to crawl at the same time. Each K-Ruoka/Prisma crawl runs its own headless
  // browser, so lower this on a small machine. Default: all stores at once.
  concurrency: Number(process.env.CRAWL_CONCURRENCY) || 5,

  // After a store is refreshed by hand, its Refresh buttons stay unavailable for this long, so
  // repeated clicks can't hammer the store's website. The weekly schedule ignores it.
  refreshCooldownMinutes: Number(process.env.REFRESH_COOLDOWN_MINUTES) || 10,

  // Per-IP request limits against bots (see src/rateLimit.js). Normal browsing stays far below.
  rateLimits: {
    crawl: { windowMs: 10 * 60_000, max: 5 }, // POST /api/crawl (Refresh buttons)
    api: { windowMs: 60_000, max: 120 }, // other /api/* calls
    pages: { windowMs: 60_000, max: 600 }, // pages, scripts, logos
    wolt: { windowMs: 10 * 60_000, max: 6 }, // Wolt lookups for a new location (each opens Chromium)
    scan: { windowMs: 10 * 60_000, max: 30 }, // expiry-date photo checks (each calls the vision model)
    checkout: { windowMs: 10 * 60_000, max: 10 }, // opening a Stripe payment page
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

  // Wolt offers in Food Promotions are looked up live for the visitor's location (src/wolt.js),
  // not crawled. Results are cached per ~1 km area; `defaultLocation` is used when the browser
  // doesn't share its location.
  wolt: {
    cacheMinutes: 30,
    maxCachedLocations: 200,
    defaultLocation: { lat: 65.0121, lon: 25.4651, name: 'Oulu city center' },
  },

  // Each key becomes a store tab in the UI. `type` picks the crawler; `name` is the tab label,
  // `label` the full store name, `color` the badge color, `logo` a file in public/logos, `brochureUrl` the link shown in the
  // "Weekly brochures" section. A store with `type: null` is brochure-only (no deals crawled).
  // `segment` picks the sidebar section: 'groceries' (default, Market Promotions), 'clothing'
  // (Cloth Promotions), 'electronics' (Electronics Promotions) or 'food' (Food Promotions).
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
      // Typed into S-kaupat's "Toimitustapa" search, then the pickup point whose name contains it
      // is chosen. Any S-group store works (Prisma, S-market, Sale…):
      // see https://www.s-kaupat.fi/myymalat/prisma
      search: 'Prisma Linnanmaa',
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
