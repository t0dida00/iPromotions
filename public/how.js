// "How the app works" (/how-it-works): a sketch of the whole system (visitors, Vercel's CDN, the API
// servers, the in-memory cache, Neon, the crawlers and the outside services), drawn as one inline
// SVG, and a "Simulate" button that plays a scenario on it: dots run along the arrows, busy parts
// turn yellow, overloaded ones red. The numbers in the captions are from the load test in the
// "Handle crowds" commit. Nothing here talks to the server.

const SVG = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const ICONS = {
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 13.5A6 6 0 0 1 21 19"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
  split: '<path d="M12 21v-7l-6-6M6 8V3.5M6 3.5 3.5 6M6 3.5 8.5 6M12 14l6-6M18 8V3.5M18 3.5 15.5 6M18 3.5 20.5 6"/>',
  server: '<rect x="4" y="4" width="16" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5"/><path d="M8 7.2h.01M8 16.8h.01"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z"/>',
  sparkle: '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z"/><path d="M19 16c.3 1.6 1 2.4 2.5 2.6-1.5.3-2.2 1-2.5 2.6-.3-1.6-1-2.3-2.5-2.6 1.5-.2 2.2-1 2.5-2.6Z"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  robot: '<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V4.5M9.5 13h.01M14.5 13h.01M9.5 16.5h5M3 12.5v3M21 12.5v3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.5 5.4 3.5 8.5s-.9 5.9-3.5 8.5c-2.6-2.6-3.5-5.4-3.5-8.5s.9-5.9 3.5-8.5Z"/>',
};

// x, y = centre. shape: box | pill | trapezoid | cylinder; stack: copies badge; external: dashed
// (a service run by someone else); top: text at the top (the API server holds the cache inside it);
// small: smaller text; band: coloured strip on the left.
const NODES = {
  users: { x: 270, y: 70, w: 280, h: 64, shape: 'pill', icon: 'users', label: 'Visitors', sub: 'browser or phone' },
  firebase: { x: 625, y: 70, w: 210, h: 64, icon: 'key', label: 'Firebase Auth', sub: 'Google sign-in', external: true },
  cdn: { x: 270, y: 205, w: 340, h: 78, shape: 'trapezoid', icon: 'split', label: 'Vercel CDN', sub: 'static files · answers cached 5–60 s' },
  app: { x: 270, y: 385, w: 340, h: 150, stack: 'auto ×N', top: true, icon: 'server', label: 'API server', sub: 'Express on Vercel Functions · fra1' },
  cache: { x: 270, y: 418, w: 296, h: 58, small: true, icon: 'bolt', label: 'In-memory cache', sub: 'sections · status · deal index', band: true },
  hf: { x: 625, y: 335, w: 210, h: 72, icon: 'sparkle', label: 'Hugging Face', sub: 'assistant · photo dates', external: true },
  wolt: { x: 625, y: 470, w: 210, h: 72, icon: 'globe', label: 'Wolt', sub: 'food offers near you', external: true },
  neon: { x: 250, y: 650, w: 300, h: 86, shape: 'cylinder', icon: 'db', label: 'Neon Postgres', sub: 'deals · users · favorites · checks' },
  crawler: { x: 625, y: 675, w: 230, h: 72, stack: '×15', icon: 'robot', label: 'Crawlers', sub: 'GitHub Actions' },
  stores: { x: 625, y: 840, w: 250, h: 72, icon: 'globe', label: 'Store websites', sub: 'Tokmanni, Prisma, Power…', external: true },
};

// async: a call to an outside service (dashed, orange dots). label: small tag at the middle.
// off: moves both ends sideways (px), so two arrows between the same boxes don't overlap.
const EDGES = {
  visit: { from: 'users', to: 'cdn' },
  signin: { from: 'users', to: 'firebase', async: true, label: 'sign-in' },
  miss: { from: 'cdn', to: 'app', label: 'miss' },
  db: { from: 'cache', to: 'neon', label: 'changed?' },
  ai: { from: 'app', to: 'hf', async: true },
  wolt: { from: 'app', to: 'wolt', async: true, label: 'live' },
  refresh: { from: 'app', to: 'crawler', async: true, label: 'Refresh' },
  fetch: { from: 'crawler', to: 'stores', label: 'read deals' },
  write: { from: 'crawler', to: 'neon', label: 'write' },
};

// Each scenario is a few steps: which arrows carry traffic (dots per second) and how busy each part
// is (0–1; ≥ 0.55 yellow, ≥ 0.9 red). Steps last STEP_MS, the last one is held a little longer.
const STEP_MS = 3400;
const SPEED = 190; // drawing units a second, the same for every dot
const MAX_RATE = 11; // dots a second per arrow: at SPEED that keeps them ≥ 17 units apart
const SAMPLE = 2; // arrows are sampled every 2 units
const SCENARIOS = {
  browse: {
    label: 'Open a deals page',
    steps: [
      { text: 'A visitor opens Market Promotions. The page, its scripts and the store logos come straight from Vercel’s CDN; no server of ours runs.', flows: { visit: 5 }, load: { cdn: 0.3 } },
      { text: 'The section’s deals (/api/deals, gzipped) are kept by the CDN for 60 seconds too, so most visits end there.', flows: { visit: 5 }, load: { cdn: 0.35 } },
      { text: 'About once a minute the CDN asks again. The API server answers from its memory and only asks Neon whether the section changed — a tiny query, not the 3 MB section.', flows: { visit: 3, miss: 1, db: 0.6 }, load: { cdn: 0.25, app: 0.2, cache: 0.3, neon: 0.1 } },
    ],
  },
  crowd: {
    label: '1,000 visitors at once',
    steps: [
      { text: '1,000 people open the site within the same second.', flows: { visit: 45 }, load: { cdn: 0.7 } },
      { text: 'The CDN answers almost all of them. Vercel starts more API server instances only if more requests get through.', flows: { visit: 45, miss: 3 }, load: { cdn: 0.75, app: 0.25 } },
      { text: 'Requests arriving together share one read of each section: 1,000 visitors cost about one Neon query, not 1,000.', flows: { visit: 30, miss: 3, db: 0.5 }, load: { cdn: 0.6, app: 0.25, cache: 0.4, neon: 0.1 } },
      { text: 'Load test (10,000 requests within one second): every request answered, 99% within 108 ms.', flows: { visit: 12, miss: 1 }, load: { cdn: 0.35, app: 0.15, cache: 0.2 } },
    ],
  },
  before: {
    label: 'The same crowd, before the fix',
    steps: [
      { text: 'Before the fix, deals weren’t cached at the edge: every request went through to the API servers…', flows: { visit: 40, miss: 30 }, load: { cdn: 0.45, app: 0.8 } },
      { text: '…and each one read the whole 3 MB section from Neon. An instance has only 5 database connections, so requests queued up.', flows: { visit: 40, miss: 30, db: 28 }, load: { cdn: 0.5, app: 0.95, cache: 0.85, neon: 1 } },
      { text: 'Requests waited for a connection until they timed out: 17% failed and the slowest took 28 seconds.', flows: { visit: 30, miss: 24, db: 24 }, load: { cdn: 0.5, app: 1, cache: 0.9, neon: 1 } },
    ],
  },
  assistant: {
    label: 'Ask the assistant',
    steps: [
      { text: 'A visitor signs in with Google in the browser (Firebase). Each question carries that sign-in token; the API server checks it against Google’s public keys.', flows: { signin: 1.5, visit: 2 }, load: { firebase: 0.3, cdn: 0.15 } },
      { text: 'Questions are never cached. The API server first checks the text (no code, no tricks), then a text model on Hugging Face turns it into what to search for.', flows: { visit: 2, miss: 2, ai: 2.5 }, load: { app: 0.4, hf: 0.55 } },
      { text: 'The search runs over every section’s deals in memory. The answer cards always come from our data, never from the model.', flows: { miss: 2 }, load: { app: 0.45, cache: 0.55 } },
      { text: 'The model writes a short summary. One check is used, only if deals were found; checks and the conversation are saved in Neon.', flows: { ai: 2, db: 1 }, load: { app: 0.35, hf: 0.45, cache: 0.25, neon: 0.2 } },
    ],
  },
  wolt: {
    label: 'Food near you (Wolt)',
    steps: [
      { text: 'On Food Promotions the visitor shares their location. The browser sends it to the API server, not to Wolt.', flows: { visit: 2, miss: 2 }, load: { cdn: 0.15, app: 0.3 } },
      { text: 'The server opens wolt.com in a headless browser at that spot and reads the restaurants’ offers. This takes a few seconds.', flows: { miss: 1, wolt: 3 }, load: { app: 0.65, wolt: 0.6 } },
      { text: 'The offers are cached for that area (about 1 km), so the next visitor nearby gets them at once, without opening Wolt again.', flows: { wolt: 1, miss: 2, db: 1 }, load: { app: 0.3, cache: 0.35, wolt: 0.2, neon: 0.15 } },
    ],
  },
  crawl: {
    label: 'Weekly crawl',
    steps: [
      { text: 'Every Wednesday GitHub Actions crawls all stores; Food (Hesburger, Burger King) is crawled every morning at 09:00.', flows: {}, load: { crawler: 0.5 } },
      { text: 'The crawlers read 15 store websites, mostly by opening a real browser and listening to the site’s own deal API. H&M, Lindex, McDonald’s and Subway are links only.', flows: { fetch: 7 }, load: { crawler: 0.8, stores: 0.6 } },
      { text: 'The deals are written to Neon, one row per section. A store that fails keeps its previous deals and shows a ⚠ on its button.', flows: { fetch: 3, write: 5 }, load: { crawler: 0.55, stores: 0.3, neon: 0.5 } },
      { text: 'Within 5 seconds the API servers see the newer version and rebuild their memory once; the CDN has the new deals within a minute.', flows: { db: 2, miss: 1.5, visit: 3 }, load: { neon: 0.3, cache: 0.5, app: 0.25, cdn: 0.3 } },
    ],
  },
  refresh: {
    label: 'Owner presses Refresh',
    steps: [
      { text: 'Only the owner sees Refresh. The API server checks their sign-in and role, and that the stores weren’t refreshed in the last 10 minutes.', flows: { visit: 1.5, miss: 1.5 }, load: { app: 0.3 } },
      { text: 'It doesn’t crawl itself (Vercel functions are short-lived): it asks GitHub to start the crawl workflow for that section.', flows: { refresh: 2.5 }, load: { app: 0.35, crawler: 0.55 } },
      { text: 'The crawlers run as in the weekly crawl and save progress in Neon; the open page polls every 3 seconds and shows which store is being read.', flows: { fetch: 5, write: 3, miss: 2, db: 1.5 }, load: { crawler: 0.75, stores: 0.5, neon: 0.4, app: 0.25, cache: 0.3 } },
    ],
  },
};

let root = null;
let svg = null;
let paths = {}; // edge id → { el, len }
let nodeEls = {}; // node id → { g, bar, w }
let load = {}; // node id → current level (eased toward target)
let target = {};
let flows = {}; // edge id → dots per second
let dots = []; // { edge, t, el }
let spawnDebt = {};
let scenario = 'crowd';
let step = -1;
let stepTimer = null;
let raf = null;
let last = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Where an arrow leaves `a` toward `b`: top/bottom when it runs mostly up or down, else a side.
// `off` shifts the point along that edge.
function anchor(a, b, off = 0) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) > Math.abs(dx) * 0.6)
    return { x: a.x + off + Math.max(-a.w / 3, Math.min(a.w / 3, dx * 0.35)), y: a.y + Math.sign(dy) * (a.h / 2 + 2), v: true };
  // Sideways: leave at the other box's height when this box is tall enough (the API server talks
  // to three services on its right), so those arrows run nearly straight instead of fanning out.
  const y = Math.max(a.y - a.h / 2 + 14, Math.min(a.y + a.h / 2 - 14, b.y)) + off;
  return { x: a.x + Math.sign(dx) * (a.w / 2 + 2), y, v: false };
}

function edgePath(e) {
  const a = NODES[e.from];
  const b = NODES[e.to];
  const p = anchor(a, b, e.off);
  const q = anchor(b, a, e.off);
  if (p.v) {
    const k = (q.y - p.y) * 0.5;
    return `M${p.x} ${p.y} C${p.x} ${p.y + k} ${q.x} ${q.y - k} ${q.x} ${q.y}`;
  }
  const k = (q.x - p.x) * 0.5;
  return `M${p.x} ${p.y} C${p.x + k} ${p.y} ${q.x - k} ${q.y} ${q.x} ${q.y}`;
}

function shapeFor(n) {
  const x = n.x - n.w / 2;
  const y = n.y - n.h / 2;
  if (n.shape === 'pill') return `<rect class="how-shape" x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${n.h / 2}"/>`;
  if (n.shape === 'trapezoid') {
    const i = 22;
    return `<path class="how-shape" d="M${x + i} ${y} H${x + n.w - i} L${x + n.w} ${y + n.h} H${x} Z"/>`;
  }
  if (n.shape === 'cylinder') {
    const ry = 11;
    return `<path class="how-shape" d="M${x} ${y + ry} V${y + n.h - ry} A${n.w / 2} ${ry} 0 0 0 ${x + n.w} ${y + n.h - ry} V${y + ry}"/>
      <ellipse class="how-shape how-lid" cx="${n.x}" cy="${y + ry}" rx="${n.w / 2}" ry="${ry}"/>`;
  }
  const stack = n.stack ? `<rect class="how-stack" x="${x + 7}" y="${y + 7}" width="${n.w}" height="${n.h}" rx="6"/>` : '';
  return `${stack}<rect class="how-shape${n.external ? ' how-ext' : ''}" x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="6"/>
    ${n.band ? `<path class="how-band" d="M${x + 1.5} ${y + 1.5} h22 v${n.h - 3} h-22 Z"/>` : ''}`;
}

function nodeSvg(id, n) {
  const x = n.x - n.w / 2;
  const y = n.y - n.h / 2;
  const ix = x + (n.shape === 'trapezoid' ? 40 : n.band ? 36 : 18);
  const tx = ix + (n.small ? 32 : 36);
  const ty = n.top ? y + 34 : n.y + (n.shape === 'cylinder' ? 6 : n.small ? 2 : 0);
  const sy = n.small ? 13 : 16; // label → subtitle → load bar spacing
  const heads = n.shape === 'pill' ? [-24, 0, 24].map((d) => `<circle class="how-head" cx="${n.x + d}" cy="${y - 4}" r="11"/>`).join('') : '';
  const bw = n.stack ? Math.max(40, n.stack.length * 8 + 14) : 0;
  const badge = n.stack ? `<g class="how-badge"><rect x="${x + n.w - bw}" y="${y - 10}" width="${bw}" height="22" rx="3"/><text x="${x + n.w - bw / 2}" y="${y + 5}">${esc(n.stack)}</text></g>` : '';
  const barW = n.w - (tx - x) - 22;
  return `<g class="how-node" data-node="${id}">
    ${heads}${shapeFor(n)}
    <svg class="how-icon" x="${ix}" y="${ty - 12}" width="24" height="24" viewBox="0 0 24 24">${ICONS[n.icon]}</svg>
    <text class="how-label${n.small ? ' small' : ''}" x="${tx}" y="${ty - 4}">${esc(n.label)}</text>
    <text class="how-sub" x="${tx}" y="${ty + sy}">${esc(n.sub)}</text>
    <rect class="how-track" x="${tx}" y="${ty + sy + 7}" width="${barW}" height="4" rx="2"/>
    <rect class="how-bar" x="${tx}" y="${ty + sy + 7}" width="0" height="4" rx="2"/>
    ${badge}
    <g class="how-fire" transform="translate(${x + 4} ${y - 6})"><circle r="15"/><path d="M0 9c-4.5 0-7-2.8-7-6.2 0-3.9 3.4-5.7 3.9-9.8 2.2 1.5 3.3 3.6 3.1 6 1.2-.7 2-2 2.2-3.5C4.5-2.6 7-.4 7 3c0 3.4-2.5 6-7 6Z"/></g>
  </g>`;
}

function build() {
  const edges = Object.entries(EDGES)
    .map(([id, e]) => `<path class="how-edge${e.async ? ' async' : ''}" data-edge="${id}" d="${edgePath(e)}" marker-end="url(#how-arrow)"/>`)
    .join('');
  root.querySelector('.how-canvas').innerHTML = `<svg class="how-svg" viewBox="0 0 760 910" role="img" aria-labelledby="how-svg-title">
    <title id="how-svg-title">Diagram: visitors sign in with Firebase and reach Vercel's CDN, which passes cache misses to the API server (auto-scaling, with an in-memory cache inside). The server checks Neon Postgres for changes and calls Hugging Face (assistant, photo dates) and Wolt (live offers). Crawlers on GitHub Actions, started on a schedule or by the owner's Refresh, read 15 store websites and write to Neon.</title>
    <defs><marker id="how-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2 2 10 6 2 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
    <g class="how-edges">${edges}</g>
    <g class="how-tags"></g>
    <g class="how-nodes">${Object.entries(NODES).map(([id, n]) => nodeSvg(id, n)).join('')}</g>
    <g class="how-dots"></g>
  </svg>`;
  svg = root.querySelector('.how-svg');
  paths = {};
  // Each arrow sampled every SAMPLE units once, so moving a dot is a lookup, not a curve calculation.
  for (const el of svg.querySelectorAll('[data-edge]')) {
    const len = el.getTotalLength();
    const n = Math.ceil(len / SAMPLE);
    const pts = new Float32Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const p = el.getPointAtLength(Math.min(len, i * SAMPLE));
      pts[i * 2] = p.x;
      pts[i * 2 + 1] = p.y;
    }
    paths[el.dataset.edge] = { el, len, pts };
  }
  // Edge tags ("miss", "async"…) at the middle of their arrow, on a paper-coloured patch.
  svg.querySelector('.how-tags').innerHTML = Object.entries(EDGES)
    .filter(([, e]) => e.label)
    .map(([id, e]) => {
      const { el, len } = paths[id];
      const m = el.getPointAtLength(len / 2);
      return `<g class="how-tag"><rect x="${m.x - e.label.length * 3.6 - 6}" y="${m.y - 10}" width="${e.label.length * 7.2 + 12}" height="18" rx="4"/><text x="${m.x}" y="${m.y + 4}">${esc(e.label)}</text></g>`;
    })
    .join('');
  nodeEls = {};
  for (const g of svg.querySelectorAll('[data-node]')) {
    const bar = g.querySelector('.how-bar');
    nodeEls[g.dataset.node] = { g, bar, w: Number(g.querySelector('.how-track').getAttribute('width')) };
  }
  bindZoom();
}

// ── Zoom and pan ─────────────────────────────────────────────────────────────────────────────
// The view is the SVG's viewBox: zooming shrinks it around a point (in) or widens it (out, with the
// drawing kept centred), dragging moves it. 100% = Fit, the whole drawing. Ctrl/⌘ + wheel or a
// trackpad pinch zooms; a plain wheel still scrolls the page. On touch, one finger scrolls the page
// until you zoom in, then it pans.
const BASE = { x: 0, y: 0, w: 760, h: 910 };
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.5;
let view = { ...BASE };
const clampW = (w) => Math.min(BASE.w / MIN_ZOOM, Math.max(BASE.w / MAX_ZOOM, w));
// Zoomed in, the view stays inside the drawing; zoomed out, the drawing stays inside the view.
const clampAxis = (v, size, base0, baseSize) => Math.min(Math.max(base0, base0 + baseSize - size), Math.max(Math.min(base0, base0 + baseSize - size), v));

function setView(v) {
  const w = clampW(v.w);
  const h = (w * BASE.h) / BASE.w;
  // Zoomed out there is nothing to pan to: centre the drawing.
  const out = w > BASE.w + 0.5;
  const x = out ? BASE.x - (w - BASE.w) / 2 : clampAxis(v.x, w, BASE.x, BASE.w);
  const y = out ? BASE.y - (h - BASE.h) / 2 : clampAxis(v.y, h, BASE.y, BASE.h);
  view = { x, y, w, h };
  svg.setAttribute('viewBox', `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  svg.classList.toggle('zoomed', w < BASE.w - 0.5);
  const z = root.querySelector('.how-zoom');
  z.querySelector('[data-zoom="out"]').disabled = w >= BASE.w / MIN_ZOOM - 0.5;
  z.querySelector('[data-zoom="fit"]').disabled = Math.abs(w - BASE.w) < 0.5;
  z.querySelector('[data-zoom="in"]').disabled = w <= BASE.w / MAX_ZOOM + 0.5;
  z.querySelector('.how-zoom-level').textContent = `${Math.round((BASE.w / w) * 100)}%`;
}

// factor > 1 zooms in, keeping the point (cx, cy) in drawing units where it is on screen.
function zoomAt(factor, cx = view.x + view.w / 2, cy = view.y + view.h / 2) {
  const w = clampW(view.w / factor);
  const k = w / view.w;
  setView({ x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, w });
}

// A screen point (clientX/Y) in drawing units.
function toSvg(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return { x: view.x + ((clientX - r.left) / r.width) * view.w, y: view.y + ((clientY - r.top) / r.height) * view.h };
}

function bindZoom() {
  view = { ...BASE };
  setView(view);
  svg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain scrolling stays page scrolling
    e.preventDefault();
    const p = toSvg(e.clientX, e.clientY);
    zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => {
    const p = toSvg(e.clientX, e.clientY);
    zoomAt(1.8, p.x, p.y);
  });
  // Drag to pan (when zoomed in); two fingers pinch.
  const pointers = new Map();
  let pinch = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
    }
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const r = svg.getBoundingClientRect();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const mid = toSvg((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAt(view.w / ((pinch.w * pinch.d) / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))), mid.x, mid.y);
    } else if (pointers.size === 1 && svg.classList.contains('zoomed')) {
      setView({ ...view, x: view.x - ((e.clientX - prev.x) / r.width) * view.w, y: view.y - ((e.clientY - prev.y) / r.height) * view.h });
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

function renderControls() {
  const s = SCENARIOS[scenario];
  root.querySelector('.how-scenarios').innerHTML = Object.entries(SCENARIOS)
    .map(([k, v]) => `<button class="store" data-scenario="${k}" aria-pressed="${k === scenario}">${esc(v.label)}</button>`)
    .join('');
  const playing = step >= 0;
  const btn = root.querySelector('.how-play');
  btn.textContent = playing ? '■ Stop' : '▶ Simulate';
  btn.setAttribute('aria-pressed', String(playing));
  root.querySelector('.how-steps').innerHTML = s.steps
    .map((st, i) => `<li class="${i === step ? 'now' : i < step ? 'done' : ''}"${i === step ? ' aria-current="step"' : ''}>${esc(st.text)}</li>`)
    .join('');
}

// ── Simulation ───────────────────────────────────────────────────────────────────────────────
function play() {
  stop(false);
  step = 0;
  applyStep();
  if (!raf) raf = requestAnimationFrame(frame);
}

function applyStep() {
  const st = SCENARIOS[scenario].steps[step];
  // An arrow that just became busy sends its first dot at once; one that stays busy keeps its rhythm.
  for (const id of Object.keys(spawnDebt)) if (!st.flows[id]) delete spawnDebt[id];
  flows = { ...st.flows };
  target = { ...st.load };
  renderControls();
  root.querySelector('.how-live').textContent = st.text;
  clearTimeout(stepTimer);
  const last = step === SCENARIOS[scenario].steps.length - 1;
  stepTimer = setTimeout(() => {
    if (last) return stop();
    step++;
    applyStep();
  }, last ? STEP_MS * 1.4 : STEP_MS);
}

// keepView: false when a new run starts right away (no need to reset the drawing in between).
function stop(keepView = true) {
  clearTimeout(stepTimer);
  step = -1;
  flows = {};
  target = {};
  if (keepView) renderControls();
}

function frame(now) {
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  // New dots on every busy arrow (none with reduced motion: then only the colours change).
  // Every dot moves at the same speed (SPEED drawing units a second, whatever the arrow's length)
  // and dots on one arrow are evenly spaced: `rate` per second, at most MAX_RATE so they stay apart.
  if (!reducedMotion.matches)
    for (const [id, want] of Object.entries(flows)) {
      const rate = Math.min(MAX_RATE, want);
      spawnDebt[id] = (spawnDebt[id] ?? 1) + rate * dt;
      while (spawnDebt[id] >= 1 && dots.length < 500) {
        spawnDebt[id]--;
        const el = document.createElementNS(SVG, 'circle');
        el.setAttribute('r', '5');
        el.setAttribute('class', `how-dot${EDGES[id].async ? ' async' : ''}`);
        svg.querySelector('.how-dots').append(el);
        // A dot due earlier in this frame has already travelled a little.
        dots.push({ edge: id, s: (spawnDebt[id] / rate) * SPEED, el });
      }
    }
  dots = dots.filter((d) => {
    d.s += SPEED * dt;
    const { len, pts } = paths[d.edge];
    if (d.s >= len) return d.el.remove(), false;
    // Between two samples, so the motion stays smooth at any speed.
    const f = d.s / SAMPLE;
    const i = Math.floor(f);
    const k = f - i;
    const x = pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * k;
    const y = pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * k;
    d.el.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    return true;
  });
  // Load bars ease toward the step's level; the colours follow.
  let moving = dots.length > 0;
  for (const [id, n] of Object.entries(nodeEls)) {
    const want = target[id] ?? 0;
    const cur = load[id] ?? 0;
    const next = cur + (want - cur) * Math.min(1, dt * 3);
    load[id] = Math.abs(next - want) < 0.002 ? want : next;
    if (load[id] !== want) moving = true;
    n.bar.setAttribute('width', (n.w * load[id]).toFixed(1));
    n.g.classList.toggle('busy', load[id] >= 0.55 && load[id] < 0.9);
    n.g.classList.toggle('hot', load[id] >= 0.9);
    n.g.classList.toggle('active', load[id] > 0.02);
  }
  // Keep animating while something runs or is still settling; then rest until the next Simulate.
  raf = step >= 0 || moving ? requestAnimationFrame(frame) : null;
  if (!raf) last = 0;
}

export function mountHow(section) {
  root = section.querySelector('#how');
  root.innerHTML = `<div class="how-intro follow-card">
      <h2>From a click to a deal</h2>
      <p class="hint">Every part of iPromotion and what talks to what. Pick a situation and press Simulate to watch requests move through the system.</p>
      <nav class="stores how-scenarios" aria-label="Situation"></nav>
      <div class="how-actions">
        <button class="btn btn-primary how-play" aria-pressed="false">▶ Simulate</button>
        <span class="how-legend"><i class="dot"></i>request <i class="dot async"></i>outside service <i class="sq busy"></i>busy <i class="sq hot"></i>overloaded</span>
      </div>
    </div>
    <div class="how-board">
      <div class="how-canvas"></div>
      <div class="how-zoom" role="group" aria-label="Zoom">
        <button class="btn btn-icon" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
        <span class="how-zoom-level" aria-live="polite">100%</span>
        <button class="btn btn-icon" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
        <button class="btn btn-icon" data-zoom="fit" aria-label="Fit the whole diagram" title="Fit">⤢</button>
      </div>
      <p class="how-zoom-hint"><span class="for-mouse">Ctrl/⌘ + scroll or pinch to zoom · drag to move · double-click to zoom in</span><span class="for-touch">Pinch to zoom · when zoomed in, drag to move</span></p>
    </div>
    <ol class="how-steps"></ol>
    <p class="visually-hidden how-live" aria-live="polite"></p>`;
  build();
  renderControls();
  root.addEventListener('click', (e) => {
    const s = e.target.closest('[data-scenario]');
    if (s) {
      scenario = s.dataset.scenario;
      return step >= 0 ? play() : renderControls();
    }
    if (e.target.closest('.how-play')) return step >= 0 ? stop() : play();
    const z = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (z === 'in') zoomAt(1.5);
    else if (z === 'out') zoomAt(1 / 1.5);
    else if (z === 'fit') setView({ ...BASE });
  });
}

// Opening the page loads its hand-drawn font (once; only this page uses it).
export function showHow() {
  if (document.getElementById('how-font')) return;
  document.head.append(Object.assign(document.createElement('link'), { id: 'how-font', rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap' }));
}

// Leaving the page stops the run; the drawing stays as it was.
export function hideHow() {
  if (step >= 0) stop();
}
