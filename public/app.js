import { showDashboard, hideDashboard } from './dashboard.js';
import { initAuth, idToken } from './auth.js';
import { mountWolt, showWolt } from './wolt.js';
import { mountFollow, showFollow } from './expiry.js';
import { mountPricing, showPricing } from './pricing.js';
import { friendlyError } from './friendly.js';
import { mountChat } from './chat.js';

// META comes from /api/meta (small): stores from config.js, their status, per-section update
// times, refresh state and cooldowns. Deals are loaded per section, only when it is opened.
let STORES = {};
let META = null;
const PAGE = 60;
const FAV_PREVIEW = 20; // deals per section on the Favorites page; the rest are in the section itself
const views = []; // one PromoView per promotions section

const $ = (id) => document.getElementById(id);
// Waits until typing pauses, so a section of 5,000 deals isn't filtered again on every key.
const debounce = (fn, ms = 200) => {
  let t;
  return (...args) => (clearTimeout(t), (t = setTimeout(() => fn(...args), ms)));
};
const eur = (n) => (n == null ? '' : '€' + n.toFixed(2));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Links and images come from scraped sites: only http(s) URLs (or our own /paths), never javascript:.
const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(String(u ?? '')) ? esc(u) : '');

// Small wrapper so a blocked localStorage (private mode etc.) never breaks the page.
const store = {
  get: (k, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const SORTS = {
  discount: (a, b) => (b.discountPct ?? -1) - (a.discountPct ?? -1),
  price: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
  saving: (a, b) => saving(b) - saving(a),
  name: (a, b) => a.name.localeCompare(b.name, 'fi'),
};
const saving = (d) => (d.regularPrice && d.price != null ? d.regularPrice - d.price : -1);

// Search box match: every word must appear in the name, brand or category.
const matchesQuery = (d, q) => {
  if (!q) return true;
  const hay = `${d.name} ${d.brand ?? ''} ${d.category} ${d.group}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
};

// Deal labels come from the stores in Finnish; translate the common ones.
const dealText = (t) =>
  t
    .replace(/(\d+) kpl \/ ([\d,]+) €/, (_, n, p) => `${n} for €${p.replace(',', '.')}`)
    .replace(/(\d+) kpl (\d+)\s?€/, '$1 for €$2')
    .replace(/(\d+) kpl/, '$1 pcs')
    .replace('(K-Plussa)', '(K-Plussa members)')
    .replace(/^Kampanja$/, 'Campaign')
    .replace(/^Halvempi hinta$/, 'Lower price');

function card(d) {
  const s = STORES[d.source];
  const until = d.validUntil ? `Valid until ${new Date(d.validUntil).toLocaleDateString('en-GB')}` : '';
  return `<a class="card" href="${safeUrl(d.url)}" target="_blank" rel="noopener">
    <div class="img">${d.image ? `<img src="${safeUrl(d.image)}" alt="" loading="lazy" />` : ''}</div>
    ${d.discountPct ? `<span class="pct">−${d.discountPct}%</span>` : ''}
    <span class="src" style="background:${esc(s?.color ?? '#666')}">${esc(s?.name ?? d.store)}</span>
    <div class="body">
      ${d.brand ? `<span class="brandname">${esc(d.brand)}</span>` : ''}
      <span class="name">${esc(d.name)}</span>
      ${d.dealText && !/^-?\d+\s?%$/.test(d.dealText) ? `<span class="deal">${esc(dealText(d.dealText))}</span>` : ''}
      <div class="prices">${
        d.price != null
          ? `<span class="price">${eur(d.price)}</span>${d.regularPrice ? `<span class="old">${eur(d.regularPrice)}</span>` : ''}`
          : '<span class="no-price">See offer for price</span>'
      }</div>
      ${until ? `<span class="until">${until}</span>` : ''}
    </div>
  </a>`;
}

// One promotions section (Market Promotions, Cloth Promotions…): brochure/sale-page cards,
// store tabs, starred categories, search, sort and the deal grid, limited to one segment.
class PromoView {
  constructor(root) {
    this.root = root;
    this.segment = root.dataset.segment;
    root.append($('promo-template').content.cloneNode(true));
    this.el = (role) => root.querySelector(`[data-role="${role}"]`);
    for (const role of ['title', 'sub', 'links-title', 'links-hint'])
      this.el(role).textContent = root.dataset[role.replace(/-(\w)/g, (_, c) => c.toUpperCase())];

    this.state = { store: 'all', group: 'all', q: '', sort: 'discount', shown: PAGE, remaining: 0 };
    this.list = null; // this section's deals, once loaded
    this.version = null; // updatedAt of the loaded file
    this.loading = null;
    // Favorites are kept per section; groceries keep the original key so existing stars survive.
    // The keys keep the project's old name (iBenefits) so stars saved before the rename survive.
    this.favKey = this.segment === 'groceries' ? 'ibenefits.favoriteCategories' : `ibenefits.favoriteCategories.${this.segment}`;
    this.favorites = new Set(store.get(this.favKey, []));
    this.bind();
  }

  stores() {
    return Object.values(STORES).filter((s) => s.segment === this.segment);
  }

  deals() {
    // Hide deals from stores removed from the config (until the next crawl drops them).
    return (this.list ?? []).filter((d) => STORES[d.source]?.segment === this.segment);
  }

  // Fetch this section's deals the first time it is shown, and again only when the section file
  // changed (a refresh finished). The server answers an unchanged file with 304, so even a
  // re-check costs almost nothing.
  ensureLoaded() {
    const latest = META?.segments?.[this.segment] ?? null;
    if (this.list && this.version === latest) return Promise.resolve();
    this.loading ??= (async () => {
      if (!this.list) this.el('count').textContent = 'Loading deals…';
      let data;
      try {
        const res = await fetch(`/api/deals?segment=${this.segment}`);
        if (res.status === 429) {
          // Rate-limited: try again when the server says so.
          const wait = Number(res.headers.get('Retry-After')) || 30;
          if (!this.list) this.el('count').textContent = `Too many requests — retrying in ${wait}s…`;
          setTimeout(() => this.ensureLoaded(), wait * 1000);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        data = await res.json();
      } catch {
        // Offline or a server error: keep what's shown (if anything) and offer to try again.
        if (!this.list)
          this.el('count').innerHTML = `${navigator.onLine === false ? "You're offline." : "Couldn't load the deals."} <button class="btn btn-sm" data-retry>Retry</button>`;
        else toast("Couldn't refresh the deals. Showing the ones loaded before.");
        return;
      }
      this.list = data.deals ?? [];
      this.version = data.updatedAt ?? latest;
      this.render();
      if (currentView === 'favorites') favoritesView.render();
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  matches(d, { store = this.state.store, group = this.state.group } = {}) {
    if (store !== 'all' && d.source !== store) return false;
    if (group !== 'all' && d.group !== group) return false;
    return matchesQuery(d, this.state.q);
  }

  renderLinks() {
    const text = this.root.dataset.linkText;
    this.el('brochures').innerHTML = this.stores()
      .filter((s) => s.brochureUrl)
      .map(
        (s) => `<a class="brochure" href="${safeUrl(s.brochureUrl)}" target="_blank" rel="noopener" style="--c:${esc(s.color)}">
          ${s.logo ? `<img class="blogo" src="${esc(s.logo)}" alt="${esc(s.name)}" />` : `<span class="bname">${esc(s.name)}</span>`}
          <span class="bbranch">${esc(s.label)}</span>
          <span class="bopen">${esc(text)} ↗</span>
        </a>`,
      )
      .join('');
  }

  render() {
    const deals = this.deals();
    const st = this.state;

    // Store tabs — counts respect the search box and category.
    const storeCounts = { all: 0 };
    for (const d of deals) if (this.matches(d, { store: 'all' })) {
      storeCounts.all++;
      storeCounts[d.source] = (storeCounts[d.source] ?? 0) + 1;
    }
    const dealStores = this.stores().filter((s) => s.hasDeals);
    this.el('stores').innerHTML = [{ key: 'all' }, ...dealStores]
      .map((s) => {
        const k = s.key;
        const status = META?.sources?.[k];
        const warn = status && !status.ok
          ? `<span class="warn" title="${esc(status.error != null ? `Last refresh failed: ${friendlyError(status.error)} Showing its previous deals.` : "Failed to get this store's latest promotions. Showing its previous deals. If this keeps happening, please contact the admin.")}">⚠</span>`
          : '';
        const label =
          k === 'all' ? 'All stores'
          : s.logo ? `<img class="tlogo" src="${esc(s.logo)}" alt="${esc(s.name)}" />`
          : `<span class="dot" style="background:${esc(s.color)}"></span>${esc(s.name)}`;
        const title = k === 'all' ? '' : ` title="${esc(s.label)}"`;
        return `<button class="store" data-store="${k}" aria-pressed="${st.store === k}"${title}>${label}<span class="n">${storeCounts[k] ?? 0}</span>${warn}</button>`;
      })
      .join('');

    // Category list — counts respect the selected store and search.
    const groupCounts = {};
    let groupTotal = 0;
    for (const d of deals) if (this.matches(d, { group: 'all' })) {
      groupCounts[d.group] = (groupCounts[d.group] ?? 0) + 1;
      groupTotal++;
    }
    const groups = [...new Set(deals.map((d) => d.group))].sort((a, b) => a.localeCompare(b, 'en'));
    const catRow = (g) => {
      const n = groupCounts[g] ?? 0;
      const fav = this.favorites.has(g);
      return `<div class="cat-row">
        <button class="cat" data-group="${esc(g)}" aria-pressed="${st.group === g}" ${n || st.group === g ? '' : 'disabled'}><span>${esc(g)}</span><span class="n">${n}</span></button>
        <button class="star" data-star="${esc(g)}" aria-pressed="${fav}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(g)} ${fav ? 'from' : 'to'} favorites">${fav ? '★' : '☆'}</button>
      </div>`;
    };
    // Starred categories sit above "All categories"; the rest follow below it.
    const favs = groups.filter((g) => this.favorites.has(g));
    this.el('cats').innerHTML =
      (favs.length ? `<p class="cats-head">★ Favorites</p>${favs.map(catRow).join('')}<hr class="cats-sep" />` : '') +
      // Empty star-sized spacer so "All categories" lines up with the starred rows' counts.
      `<div class="cat-row"><button class="cat" data-group="all" aria-pressed="${st.group === 'all'}"><span>All categories</span><span class="n">${groupTotal}</span></button><span class="star-spacer" aria-hidden="true"></span></div>` +
      groups.filter((g) => !this.favorites.has(g)).map(catRow).join('');

    const list = deals.filter((d) => this.matches(d)).sort(SORTS[st.sort]);
    this.el('count').textContent = `${list.length} deals`;
    this.el('empty').hidden = list.length > 0 || !this.version;
    this.el('grid').innerHTML = list.slice(0, st.shown).map(card).join('');
    st.remaining = list.length - st.shown;
  }

  reset(patch) {
    Object.assign(this.state, patch, { shown: PAGE });
    this.render();
  }

  // Star/unstar a category; also used by the Favorites section. Signed in, it's saved to the
  // account (the star changes at once and goes back if saving fails); signed out, in the browser.
  async toggleFavorite(g) {
    const adding = !this.favorites.has(g);
    const flip = () => {
      if (this.favorites.has(g)) this.favorites.delete(g);
      else this.favorites.add(g);
      if (this.list) this.render();
      favoritesView.render();
    };
    flip();
    if (!account.active) return store.set(this.favKey, [...this.favorites]);
    const res = await accountFetch(`/api/favorites/${encodeURIComponent(this.segment)}/${encodeURIComponent(g)}`, { method: adding ? 'PUT' : 'DELETE' });
    if (!res?.ok) {
      flip();
      toast((await res?.json().catch(() => null))?.error ?? "Couldn't save your favorite. Please try again.");
    }
  }

  bind() {
    this.el('stores').addEventListener('click', (e) => {
      const b = e.target.closest('[data-store]');
      if (b) this.reset({ store: b.dataset.store });
    });
    this.el('cats').addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        this.toggleFavorite(star.dataset.star);
        return;
      }
      const b = e.target.closest('[data-group]');
      if (!b || b.disabled) return;
      this.reset({ group: b.dataset.group });
      this.root.querySelector('.filters').scrollIntoView();
    });
    this.el('q').addEventListener('input', debounce((e) => this.reset({ q: e.target.value.trim().toLowerCase() })));
    this.el('count').addEventListener('click', (e) => e.target.closest('[data-retry]') && this.ensureLoaded());
    this.el('sort').addEventListener('change', (e) => this.reset({ sort: e.target.value }));
    // Infinite scroll: render more cards as the bottom comes into view.
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && this.state.remaining > 0 && !this.root.hidden) {
        this.state.shown += PAGE;
        this.render();
      }
    }, { rootMargin: '600px' }).observe(this.el('sentinel'));
  }
}

// Favorites section: the deals in every starred category, grouped by promotions section. It reads
// the favorites and deals of the PromoViews, so stars stay in sync both ways.
class FavoritesView {
  constructor(root) {
    this.root = root;
    this.state = { q: '', sort: 'discount' };
    this.bind();
    this.renderCount();
  }

  // Load only the sections that have starred categories.
  ensureLoaded() {
    this.render();
    return Promise.all(views.filter((v) => v.favorites.size).map((v) => v.ensureLoaded()));
  }

  renderCount() {
    const n = views.reduce((sum, v) => sum + v.favorites.size, 0);
    $('fav-count').hidden = !n;
    $('fav-count').textContent = n;
  }

  render() {
    this.renderCount();
    if (this.root.hidden) return;
    const st = this.state;
    const starred = views.filter((v) => v.favorites.size);
    if (!starred.length) {
      $('favs').innerHTML = `<div class="fav-empty">
        <strong>No favorites yet</strong>
        Star (☆) a category in any promotions section and its deals will show up here.
        <div class="links">${views.map((v) => `<a class="btn" href="/${v.root.dataset.view}" data-go="${v.root.dataset.view}">${esc(v.root.dataset.title)}</a>`).join('')}</div>
      </div>`;
      return;
    }
    $('favs').innerHTML = starred
      .map((v) => {
        const seg = v.segment;
        const groups = [...v.favorites].sort((a, b) => a.localeCompare(b, 'en'));
        const deals = v.list ? v.deals().filter((d) => v.favorites.has(d.group) && matchesQuery(d, st.q)) : [];
        const counts = {};
        for (const d of deals) counts[d.group] = (counts[d.group] ?? 0) + 1;
        const chips = groups
          .map(
            (g) => `<span class="fav-chip">
              <button data-open="${esc(g)}" data-segment="${seg}" title="Open in ${esc(v.root.dataset.title)}"><span>${esc(g)}</span><span class="n">${v.list ? counts[g] ?? 0 : ''}</span></button>
              <button class="unstar" data-unstar="${esc(g)}" data-segment="${seg}" title="Remove from favorites" aria-label="Remove ${esc(g)} from favorites">★</button>
            </span>`,
          )
          .join('');
        deals.sort(SORTS[st.sort]);
        const body = !v.list
          ? '<p class="count">Loading deals…</p>'
          : deals.length
            ? `<div class="grid">${deals.slice(0, FAV_PREVIEW).map(card).join('')}</div>` +
              (deals.length > FAV_PREVIEW
                ? `<a class="btn fav-more" href="/${v.root.dataset.view}" data-segment="${seg}"${groups.length === 1 ? ` data-open="${esc(groups[0])}"` : ''}>See all ${deals.length} deals in ${esc(v.root.dataset.title)} →</a>`
                : '')
            : `<p class="empty">${st.q ? 'No deals match your search.' : 'No deals in these categories right now.'}</p>`;
        return `<section class="fav-block">
          <div class="fav-head">
            <h2>${esc(v.root.dataset.title)}</h2>
            ${v.list ? `<span class="n">${deals.length} deals</span>` : ''}
            <a href="/${v.root.dataset.view}" data-go="${v.root.dataset.view}">Open section →</a>
          </div>
          <div class="fav-chips">${chips}</div>
          ${body}
        </section>`;
      })
      .join('');
  }

  bind() {
    $('fav-q').addEventListener('input', debounce((e) => {
      this.state.q = e.target.value.trim().toLowerCase();
      this.render();
    }));
    $('fav-sort').addEventListener('change', (e) => {
      this.state.sort = e.target.value;
      this.render();
    });
    $('favs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unstar], [data-open], [data-go]');
      if (!b || e.metaKey || e.ctrlKey) return;
      const v = views.find((x) => x.segment === b.dataset.segment);
      if (b.dataset.unstar) v.toggleFavorite(b.dataset.unstar);
      else {
        // Open the section, filtered to the clicked category when there is one.
        e.preventDefault();
        if (b.dataset.open) {
          v.el('q').value = '';
          Object.assign(v.state, { store: 'all', group: b.dataset.open, q: '', shown: PAGE });
          if (v.list) v.render();
        }
        navigate(`/${b.dataset.go ?? v.root.dataset.view}`);
      }
    });
  }
}

// ── Favorites: browser or account ───────────────────────────────────────────────────────────────
// Logged out, favorites live in this browser (localStorage, keys per section). Signed in (with
// accounts set up on the server), they live in the account; the browser's favorites are merged in
// once per sign-in, so nothing starred before logging in is lost. auth.js says who is signed in.
const account = { active: false };
const MERGED_KEY = (uid) => `ipromotion.favoritesMerged.${uid}`;

async function accountFetch(url, opts = {}) {
  const token = await idToken();
  if (!token) return null;
  return fetch(url, { ...opts, headers: { ...opts.headers, authorization: `Bearer ${token}` } }).catch(() => null);
}

function showFavorites(map) {
  for (const v of views) {
    v.favorites = new Set(map(v));
    if (v.list) v.render();
  }
  // Account favorites arrive after startup, when Favorites may already be open: load the sections
  // they need now, or the page waits on "Loading deals…" until the next meta poll.
  if (currentView === 'favorites') favoritesView.ensureLoaded();
  else favoritesView.render();
}

async function useAccountFavorites(uid) {
  // First load in this browser since signing in: send the browser's stars along to be merged.
  const merge = !store.get(MERGED_KEY(uid), false);
  const browser = Object.fromEntries(views.map((v) => [v.segment, store.get(v.favKey, [])]));
  const res = merge
    ? await accountFetch('/api/favorites/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(browser) })
    : await accountFetch('/api/favorites');
  if (!res?.ok) {
    toast((await res?.json().catch(() => null))?.error ?? "Couldn't load your saved favorites; showing this browser's.");
    return useBrowserFavorites();
  }
  const saved = await res.json();
  if (merge) store.set(MERGED_KEY(uid), true);
  account.active = true;
  showFavorites((v) => saved[v.segment] ?? []);
}

function useBrowserFavorites() {
  account.active = false;
  showFavorites((v) => store.get(v.favKey, []));
}

document.addEventListener('ipromotion:account', (e) => {
  load(); // the owner gets crawler error details in /api/meta
  const { signedIn, accounts, uid } = e.detail;
  if (signedIn && accounts) return useAccountFavorites(uid);
  // Signed out: forget the merge marker so stars made while logged out merge at the next sign-in.
  if (!signedIn)
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('ipromotion.favoritesMerged.')) localStorage.removeItem(k);
    } catch {}
  useBrowserFavorites();
});

const viewFor = (name) => (name === 'favorites' ? favoritesView : views.find((v) => v.root.dataset.view === name));

async function load() {
  clearTimeout(load.timer);
  // Signed in as the owner, the server adds crawler error details to the store statuses.
  const token = await idToken();
  const res = await fetch('/api/meta', token ? { headers: { authorization: `Bearer ${token}` } } : {});
  if (res.status === 429) {
    load.timer = setTimeout(load, (Number(res.headers.get('Retry-After')) || 30) * 1000);
    return;
  }
  META = await res.json();
  STORES = Object.fromEntries(META.stores.map((s) => [s.key, s]));
  renderHeader();
  for (const v of views) v.renderLinks();
  // Only the section on screen loads (or re-checks) its deals; others wait until opened.
  viewFor(currentView)?.ensureLoaded();
  // Poll while a refresh runs; otherwise just keep cooldowns and times current.
  load.timer = setTimeout(load, META.crawling ? 3000 : 60_000);
}

// Stores being crawled right now (empty when idle).
const busyStores = () => (META?.crawling ? META.crawling.scope ?? [] : []);
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// "today, 16:02", "yesterday, 09:10" or "24 Oct, 06:00".
function shortWhen(iso) {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${day}, ${hhmm(iso)}`;
}

function renderHeader() {
  const { updatedAt } = META;
  const busy = busyStores();
  const updated = $('updated');
  updated.classList.toggle('busy', busy.length > 0);
  updated.textContent = busy.length
    ? `Refreshing ${busy.map((k) => STORES[k]?.name ?? k).join(', ')}…`
    : updatedAt
      ? `Updated ${shortWhen(updatedAt)}`
      : 'No data yet';
  updated.title = updatedAt ? new Date(updatedAt).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }) : '';
  // A section's button is busy while its own stores are crawled, and unavailable while every one
  // of its stores is in the post-refresh cooldown.
  for (const b of document.querySelectorAll('.crawl-btn')) {
    const seg = b.closest('section.view')?.dataset.segment;
    const keys = Object.values(STORES).filter((s) => s.hasDeals && (!seg || s.segment === seg)).map((s) => s.key);
    const mine = busy.filter((k) => keys.includes(k));
    const waits = keys.map((k) => META.cooldownUntil?.[k]);
    const allCooling = keys.length && waits.every(Boolean);
    b.disabled = mine.length > 0 || allCooling;
    b.textContent = mine.length
      ? 'Refreshing…'
      : allCooling
        ? `Refreshed · again at ${hhmm(waits.sort()[0])}`
        : seg ? 'Refresh now' : 'Refresh all';
    b.title = allCooling ? `Refreshed less than ${META.cooldownMinutes ?? 10} minutes ago` : '';
  }
}

// Short message at the bottom of the screen.
function toast(text) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: text });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

for (const section of document.querySelectorAll('section.promo')) views.push(new PromoView(section));
const favoritesView = new FavoritesView(document.querySelector('section[data-view="favorites"]'));
// Food Promotions also lists Wolt offers near the visitor (public/wolt.js).
const foodSection = document.querySelector('section[data-wolt]');
if (foodSection) mountWolt(foodSection);
// Follow your discount: product photos → expiry dates on a calendar (public/expiry.js).
mountFollow(document.querySelector('section[data-view="follow"]'));
mountPricing(document.querySelector('section[data-view="pricing"]'));
// Deals assistant: floating chat at the bottom-right of every page (public/chat.js).
mountChat();

// Refresh buttons: a promotions section refreshes only its own stores; the dashboard's refreshes
// everything. Also used by the dashboard's per-store and per-section buttons. The server ignores
// stores that are already refreshing or were refreshed within the cooldown.
export async function startCrawl(query = '', button = null) {
  if (button) button.disabled = true; // no double clicks while the request is on its way
  // Only owners may refresh; the server checks the signed-in user's token.
  const token = await idToken();
  const res = await fetch(`/api/crawl${query}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  const r = await res.json();
  if (res.status === 401 || res.status === 403) {
    toast(r.error);
    if (button) button.disabled = false;
    return;
  }
  if (res.status === 429)
    toast(
      r.rateLimited ? r.error
      : r.availableAt ? `Refreshed recently — available again at ${hhmm(r.availableAt)}`
      : 'Already refreshing',
    );
  else if (r.skipped?.length)
    toast(`Refreshing ${r.stores.map((k) => STORES[k]?.name ?? k).join(', ')} · skipped ${r.skipped.length} refreshed recently`);
  await load();
  if (currentView === 'dashboard') showDashboard();
}
document.addEventListener('ipromotion:crawl', (e) => startCrawl(e.detail));
for (const btn of document.querySelectorAll('.crawl-btn'))
  btn.addEventListener('click', () => {
    const seg = btn.closest('section.view')?.dataset.segment;
    startCrawl(seg ? `?segment=${seg}` : '', btn);
  });

// Sidebar sections: the URL path (/dashboard, /promotions, /clothing, /electronics) picks which
// <section data-view> is shown. "/" opens the dashboard; old #promotions links still work.
const DEFAULT_VIEW = 'dashboard';
let currentView = null;
function showView() {
  const names = [...document.querySelectorAll('.view')].map((v) => v.dataset.view);
  const wanted = location.pathname.slice(1) || location.hash.slice(1);
  currentView = names.includes(wanted) ? wanted : DEFAULT_VIEW;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== currentView;
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.view === currentView) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const label = document.querySelector(`.nav-item[data-view="${currentView}"] span`) ?? document.querySelector(`.view[data-view="${currentView}"] h1`);
  document.title = `${label?.textContent.trim()} · iPromotion`;
  document.querySelector('.app').classList.remove('menu-open');
  if (currentView === 'dashboard') showDashboard();
  else hideDashboard();
  if (currentView === foodSection?.dataset.view) showWolt();
  if (currentView === 'follow') showFollow();
  if (currentView === 'pricing') showPricing();
  if (META) viewFor(currentView)?.ensureLoaded();
}
// Switch sections without reloading the page.
function navigate(href) {
  history.pushState(null, '', href);
  showView();
  window.scrollTo({ top: 0 });
}
document.querySelector('.nav').addEventListener('click', (e) => {
  const a = e.target.closest('.nav-item');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
// "Please check before you go" notices: closing one hides them all, remembered in this browser
// (restored before painting by the inline script in index.html). The footer keeps the disclaimer.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.data-note-close')) return;
  document.querySelector('.app').classList.add('data-note-closed');
  store.set('ipromotion.dataNoteClosed', true);
});
window.addEventListener('popstate', showView);
showView();

// Desktop: the sidebar collapses to an icon rail (remembered in this browser). Collapsed, each
// item's label becomes its tooltip.
const app = document.querySelector('.app');
function setCollapsed(collapsed) {
  app.classList.toggle('sidebar-collapsed', collapsed);
  const btn = $('collapse-btn');
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', label);
  btn.title = label;
  for (const a of document.querySelectorAll('.nav-item')) {
    if (collapsed) a.title = a.querySelector('span').textContent.trim();
    else a.removeAttribute('title');
  }
  store.set('ipromotion.sidebarCollapsed', collapsed);
}
setCollapsed(app.classList.contains('sidebar-collapsed'));
$('collapse-btn').addEventListener('click', () => setCollapsed(!app.classList.contains('sidebar-collapsed')));

// Mobile drawer.
for (const b of document.querySelectorAll('.menu-btn'))
  b.addEventListener('click', () => document.querySelector('.app').classList.add('menu-open'));
$('scrim').addEventListener('click', () => document.querySelector('.app').classList.remove('menu-open'));

initAuth();
load();
