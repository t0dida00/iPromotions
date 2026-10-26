// "Wolt offers near you" panel in Food Promotions: restaurant offers on Wolt around the browser's
// location, from GET /api/wolt (looked up live by the server, cached per ~1 km area). Only offers
// open to everyone are listed, not Wolt+ member deals.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Links and images come from scraped sites: only http(s) URLs (or our own /paths), never javascript:.
const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(String(u ?? '')) ? esc(u) : '');
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// Areas are cached for 6 hours, so the check time may be yesterday's: "today 14:02" / "yesterday 18:40".
const checkedAt = (iso) => {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return `${days === 0 ? 'today' : days === 1 ? 'yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm(iso)}`;
};
const PAGE = 24;

const FILTERS = {
  discount: { label: 'Discounts', test: (v) => v.offers.some((o) => o.kind === 'discount') },
  delivery: { label: '0 € delivery', test: (v) => v.offers.some((o) => o.kind === 'delivery') },
  all: { label: 'All restaurants', test: () => true },
};

let root = null;
let data = null;
let state = { filter: 'discount', shown: PAGE, status: 'idle', message: '', q: '', rawQ: '' };

// Search by restaurant name, ignoring case and accents ("hese" finds "Hesburger", "cafe" finds "Café").
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const matches = (v) => !state.q || fold(v.name).includes(state.q);

// Browser location, rounded to ~1 km before it leaves the browser.
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) }),
      () => resolve(null),
      { timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  });
}

async function load() {
  state = { ...state, status: 'locating', message: '' };
  render();
  const pos = await locate();
  state.status = 'loading';
  render();
  let res = await fetch(pos ? `/api/wolt?lat=${pos.lat}&lon=${pos.lon}` : '/api/wolt');
  // Outside Finland: fall back to the default location.
  if (res.status === 400 && pos) res = await fetch('/api/wolt');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    state.status = 'error';
    state.message = res.status === 429 ? `${body.error ?? 'Too many lookups.'} Try again in ${Math.ceil((body.retryAfterSeconds ?? 60) / 60)} min.` : body.error ?? 'Could not load Wolt offers.';
    return render();
  }
  data = { ...body, located: Boolean(pos) };
  const hasDiscounts = data.venues.some(FILTERS.discount.test);
  state = { ...state, status: 'ready', filter: hasDiscounts ? 'discount' : 'all', shown: PAGE };
  render();
}

function card(v) {
  const offers = v.offers
    .map((o) => `<span class="wolt-offer ${o.kind}">${esc(o.text)}</span>`)
    .join('');
  const meta = [v.rating ? `★ ${v.rating.toFixed(1)}` : '', v.estimate ? `${esc(v.estimate)} min` : '', v.priceRange ? '€'.repeat(v.priceRange) : '']
    .filter(Boolean)
    .join(' · ');
  return `<a class="card wolt-card" href="${safeUrl(v.url)}" target="_blank" rel="noopener">
    <div class="img wolt-img">${v.image ? `<img src="${safeUrl(v.image)}" alt="" loading="lazy" />` : ''}</div>
    <span class="src" style="background:#009de0">Wolt</span>
    <div class="body">
      <span class="name">${esc(v.name)}</span>
      ${v.description ? `<span class="until">${esc(v.description)}</span>` : ''}
      <div class="wolt-offers">${offers}</div>
      ${meta ? `<span class="until wolt-meta">${meta}</span>` : ''}
    </div>
  </a>`;
}

function render() {
  if (!root) return;
  const active = document.activeElement?.id === 'wolt-q' ? document.activeElement : null;
  const focus = active ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const where = data
    ? data.located ? `near ${esc(data.location.address ?? 'you')}` : `near ${esc(data.location.address ?? 'Oulu city center')} (default — your location isn't shared)`
    : '';
  const status = {
    idle: '',
    locating: 'Asking your browser for your location…',
    loading: 'Looking up Wolt offers near you — a new area takes a few seconds…',
    error: esc(state.message),
    ready: `Offers open to everyone, no Wolt+ needed · ${where} · checked ${data ? checkedAt(data.fetchedAt) : ''}`,
  }[state.status];
  const busy = state.status === 'locating' || state.status === 'loading';

  let body = '';
  if (data && state.status !== 'error') {
    const found = data.venues.filter(matches);
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, found.filter(f.test).length]));
    const list = found.filter(FILTERS[state.filter].test);
    // Restaurants with real discounts first, then by rating.
    list.sort((a, b) => FILTERS.discount.test(b) - FILTERS.discount.test(a) || (b.rating ?? 0) - (a.rating ?? 0));
    const empty = state.q ? `No restaurant matching “${esc(state.q)}” ${state.filter === 'all' ? 'nearby' : 'in this list'}.` : 'No Wolt offers of this kind nearby right now.';
    body = `<div class="tools wolt-tools"><input type="search" id="wolt-q" placeholder="Search restaurants…" aria-label="Search restaurants by name" autocomplete="off" value="${esc(state.rawQ ?? '')}" /></div>
      <nav class="stores" aria-label="Wolt offer type">${Object.entries(FILTERS)
      .map(([k, f]) => `<button class="store" data-wolt-filter="${k}" aria-pressed="${state.filter === k}">${f.label}<span class="n">${counts[k]}</span></button>`)
      .join('')}</nav>
      ${list.length ? `<div class="grid">${list.slice(0, state.shown).map(card).join('')}</div>` : `<p class="empty">${empty}</p>`}
      ${list.length > state.shown ? `<button class="btn wolt-more" data-wolt-more>Show more (${list.length - state.shown} left)</button>` : ''}`;
  }
  root.innerHTML = `<div class="wolt-head">
      <div>
        <h2>Wolt offers near you</h2>
        <p class="hint">${busy ? '<span class="pulse"></span>' : ''}${status}</p>
      </div>
      <button class="btn btn-sm" data-wolt-locate ${busy ? 'disabled' : ''}>${state.status === 'error' ? 'Try again' : 'Update location'}</button>
    </div>${body}`;
  // The list is redrawn on every keystroke; keep typing in the search box without interruption.
  if (focus) {
    const q = root.querySelector('#wolt-q');
    q.focus();
    q.setSelectionRange(focus.start, focus.end);
  }
}

// Adds the panel to the Food section, under its offer-page links. Data loads on first show().
export function mountWolt(section) {
  root = document.createElement('section');
  root.className = 'wrap wolt';
  section.querySelector('.brochures-wrap').after(root);
  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-wolt-filter]');
    if (f) {
      state.filter = f.dataset.woltFilter;
      state.shown = PAGE;
      return render();
    }
    if (e.target.closest('[data-wolt-more]')) {
      state.shown += PAGE;
      return render();
    }
    if (e.target.closest('[data-wolt-locate]')) load();
  });
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'wolt-q') return;
    state.rawQ = e.target.value;
    state.q = fold(e.target.value.trim());
    state.shown = PAGE;
    render();
  });
  render();
}

export function showWolt() {
  if (root && state.status === 'idle') load();
}
