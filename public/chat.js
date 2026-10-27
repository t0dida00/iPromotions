// Deals assistant: a floating chat button at the bottom-right of every page. Questions go to
// POST /api/chat (src/chat.js), which searches this week's deals of every store and answers with a
// short text plus the matching items. Signed-in users only: an answered question uses 1 check (the
// same checks as Follow your discount); refused questions and questions that find nothing are free.
// Everything from the server, the model's text included, is escaped before it reaches the page.
// The conversation is saved on the server for 24 hours (GET /api/chat/history); "/clear" or the
// trash button deletes it sooner. Questions asked before on the same data come from a cache, free.
import { idToken, openDialog } from './auth.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Links and images come from scraped sites: only http(s) URLs (or our own /paths), never javascript:.
const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(String(u ?? '')) ? esc(u) : '');
const euro = (n) => (n == null ? '' : `${Number(n).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`);
const MAX = 300;
const EXAMPLES = ['Discounted meat', 'Drinks on sale', "What's on sale at Lidl?", 'Where can I get a discounted burger?', 'Clothes on sale in any store'];

let user = null;
let credits; // { balance, unlimitedUntil, owner } | null (not metered) | undefined (not loaded)
let messages = []; // { role: 'user' | 'bot' | 'error', text, data? }
let busy = false;
let historyLoaded = false;
let els = null;

const ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function itemRow(i) {
  const pct = i.discountPct ? `<span class="chat-pct">-${i.discountPct}%</span>` : '';
  const price = i.price != null ? `<b>${euro(i.price)}</b>${i.regularPrice ? ` <s>${euro(i.regularPrice)}</s>` : ''}` : `<span class="chat-deal">${esc((i.dealText ?? '').slice(0, 70))}</span>`;
  return `<a class="chat-item" href="${safeUrl(i.url)}" target="_blank" rel="noopener">
    <span class="chat-img">${i.image ? `<img src="${safeUrl(i.image)}" alt="" loading="lazy" />` : ''}</span>
    <span class="chat-info">
      <span class="chat-name">${esc(i.name)}</span>
      <span class="chat-meta"><span class="chat-store" style="background:${/^#[0-9a-f]{3,8}$/i.test(i.color) ? i.color : '#555'}">${esc(i.store)}</span>${pct}</span>
      <span class="chat-price">${price}</span>
    </span>
  </a>`;
}

function botExtras(d) {
  if (!d) return '';
  // The remembered search ("kana · Tokmanni"): the next question builds on it ("cheaper ones").
  const searching = d.searching
    ? `<p class="chat-searching"><span>Searching: <b>${esc(d.searching)}</b></span><button type="button" class="chat-chip chat-new" data-q="/new">New search</button></p>`
    : '';
  return searching + (d.cached ? '<p class="chat-more">Saved answer · no check used</p>' : '') + botContent(d);
}

function botContent(d) {
  if (d.kind === 'items' && d.items?.length)
    return `<div class="chat-items">${d.items.map(itemRow).join('')}</div>${d.total > d.items.length ? `<p class="chat-more">${d.items.length} of ${d.total} matching deals shown. Ask for a narrower search to see others.</p>` : ''}`;
  if (d.kind === 'stores' && d.stores?.length)
    return d.stores
      .map((s) => `<div class="chat-group"><p class="chat-group-head"><span class="chat-store" style="background:${/^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#555'}">${esc(s.store)}</span>
        ${s.count} deal${s.count === 1 ? '' : 's'}${s.bestDiscount ? ` · up to -${s.bestDiscount}%` : ''}</p>
        <div class="chat-items">${s.items.map(itemRow).join('')}</div></div>`)
      .join('');
  if (d.kind === 'overview' && d.overview) {
    const o = d.overview;
    return `<p class="chat-stats"><b>${o.total}</b> deals · <b>${o.discounted}</b> discounted${o.avgDiscount ? ` · avg -${o.avgDiscount}%` : ''}${o.maxDiscount ? ` · up to -${o.maxDiscount}%` : ''}</p>
      <p class="chat-tags">${o.groups.slice(0, 8).map((g) => `<span>${esc(g.group)} ${g.count}</span>`).join('')}</p>
      <div class="chat-items">${o.items.map(itemRow).join('')}</div>`;
  }
  return '';
}

function renderMessages() {
  const intro = `<div class="chat-msg bot"><p>Hi! Ask me about this week's deals in Oulu stores, e.g. a kind of product, a store, or where to find something on sale. English or Finnish.</p>
    <p class="chat-more"> Type <b>/new</b> to start a new search. Your conversation is kept for 24 hours; type <b>/clear</b> to delete it sooner.</p>
    <p class="chat-chips">${EXAMPLES.map((q) => `<button type="button" class="chat-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</p></div>`;
  const list = messages
    .map((m) =>
      m.role === 'user'
        ? `<div class="chat-msg user"><p>${esc(m.text)}</p></div>`
        : `<div class="chat-msg ${m.role}"><p>${esc(m.text)}</p>${m.link ? `<p><a class="btn btn-sm btn-primary" href="${safeUrl(m.link.href)}" data-view-link>${esc(m.link.label)}</a></p>` : ''}${botExtras(m.data)}</div>`,
    )
    .join('');
  const typing = busy ? '<div class="chat-msg bot"><p class="chat-typing"><span class="pulse"></span>Searching the deals…</p></div>' : '';
  els.list.innerHTML = intro + list + typing;
  els.list.scrollTop = els.list.scrollHeight;
}

function renderChrome() {
  const signedOut = !user;
  els.signin.hidden = !signedOut;
  els.clear.hidden = signedOut;
  els.form.hidden = signedOut;
  els.send.disabled = busy || !els.input.value.trim();
  els.input.disabled = busy;
  els.count.textContent = `${els.input.value.length}/${MAX}`;
  els.credits.innerHTML = signedOut || !credits
    ? 'Each answered question uses 1 check'
    : credits.owner ? 'Owner: questions are free'
    : credits.unlimitedUntil ? 'Unlimited checks'
    : `<b>${credits.balance}</b> check${credits.balance === 1 ? '' : 's'} left · <a href="/pricing" data-view-link>Get more</a>`;
}

async function loadCredits() {
  const token = await idToken();
  if (!token) return;
  const r = await fetch('/api/credits', { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json()).catch(() => null);
  if (r && 'credits' in r) credits = r.credits;
  renderChrome();
}

// The saved conversation (24 hours), loaded once per sign-in when the panel first opens.
async function loadHistory() {
  historyLoaded = true;
  const token = await idToken();
  if (!token) return;
  const h = await fetch('/api/chat/history', { headers: { authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!h || messages.length) return; // something was asked meanwhile: keep it
  messages = (h.messages ?? []).filter((m) => m.role === 'user' || m.role === 'bot').map((m) => ({ role: m.role, text: m.text, data: m.data }));
  renderMessages();
}

async function clearConversation() {
  const token = await idToken();
  if (token) await fetch('/api/chat/history', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  messages = [{ role: 'bot', text: 'Conversation deleted.' }];
  renderMessages();
}

async function ask(text) {
  text = text.replace(/\s+/g, ' ').trim().slice(0, MAX);
  if (!text || busy) return;
  messages.push({ role: 'user', text });
  busy = true;
  els.input.value = '';
  renderMessages();
  renderChrome();
  els.live.textContent = 'Searching the deals…';
  try {
    const token = await idToken();
    if (!token) throw Object.assign(new Error('Please sign in to ask the assistant.'), { status: 401 });
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Only the message: the server remembers the conversation's search itself.
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(60_000),
    });
    const r = await res.json().catch(() => ({}));
    if (r.cleared) {
      messages = [{ role: 'bot', text: 'Conversation deleted.' }];
      return;
    }
    if (r.reset) {
      messages.push({ role: 'bot', text: 'OK, starting a new search. What are you looking for?' });
      return;
    }
    if (r.credits !== undefined && r.credits !== null) credits = r.credits;
    if (!res.ok) {
      const msg = { role: 'error', text: r.error ?? 'Something went wrong. Please try again.' };
      if (res.status === 402) msg.link = { href: '/pricing', label: 'Get more checks' };
      if (res.status === 429 && r.retryAfterSeconds) msg.text = `${r.error} Try again in ${Math.ceil(r.retryAfterSeconds / 60)} min.`;
      messages.push(msg);
    } else {
      messages.push({ role: 'bot', text: r.answer, data: r });
    }
  } catch (e) {
    messages.push({ role: 'error', text: e.status === 401 ? e.message : e.name === 'TimeoutError' ? 'The assistant took too long. Please try again.' : "Couldn't reach the assistant. Check your connection and try again." });
  } finally {
    busy = false;
    renderMessages();
    renderChrome();
    // Screen readers hear only the new reply, not the whole conversation redrawn.
    els.live.textContent = messages.at(-1)?.role === 'user' ? '' : messages.at(-1)?.text ?? '';
    els.input.focus();
  }
}

const phone = matchMedia('(max-width: 760px)');

function setOpen(open) {
  els.panel.hidden = !open;
  if (phone.matches) els.panel.setAttribute('aria-modal', 'true');
  else els.panel.removeAttribute('aria-modal');
  els.fab.setAttribute('aria-expanded', String(open));
  els.fab.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
  document.documentElement.classList.toggle('chat-open', open);
  if (open) {
    renderMessages();
    renderChrome();
    if (user && credits === undefined) loadCredits();
    if (user && !historyLoaded) loadHistory();
    (user ? els.input : els.signin.querySelector('button')).focus();
  }
}

// Opens the assistant with a question typed in but not sent (sending can use a check), e.g.
// "Find deals like this" on a Follow date. Signed out, the panel shows its sign-in box.
export function openChat(prefill = '') {
  if (!els) return;
  setOpen(true);
  if (!user) return;
  els.input.value = prefill.slice(0, MAX);
  renderChrome();
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}

export function mountChat() {
  const root = document.createElement('div');
  root.className = 'chat';
  root.innerHTML = `<button class="chat-fab" aria-label="Ask the deals assistant" aria-expanded="false" aria-controls="chat-panel">${ICON_CHAT}</button>
    <section class="chat-panel" id="chat-panel" role="dialog" aria-label="Deals assistant" hidden>
      <header class="chat-head">
        <div><h2>Deals assistant</h2><p class="chat-credits"></p></div>
        <span class="chat-actions">
          <button class="btn btn-icon chat-clear" aria-label="Delete conversation" title="Delete conversation">${ICON_TRASH}</button>
          <button class="btn btn-icon chat-close" aria-label="Close">${ICON_CLOSE}</button>
        </span>
      </header>
      <div class="chat-list"></div>
      <p class="visually-hidden chat-live" aria-live="polite"></p>
      <div class="chat-signin" hidden><p>Sign in to ask about deals. Each answered question uses 1 check.</p><button class="btn btn-primary">Sign in</button></div>
      <form class="chat-form">
        <textarea rows="1" maxlength="${MAX}" placeholder="Ask about deals…" aria-label="Your question"></textarea>
        <button class="btn btn-primary chat-send" type="submit">Send</button>
        <span class="chat-count"></span>
      </form>
    </section>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  els = { live: $('.chat-live'), clear: $('.chat-clear'), fab: $('.chat-fab'), panel: $('.chat-panel'), list: $('.chat-list'), form: $('.chat-form'), input: $('textarea'), send: $('.chat-send'), count: $('.chat-count'), credits: $('.chat-credits'), signin: $('.chat-signin') };

  els.fab.addEventListener('click', () => setOpen(els.panel.hidden));
  $('.chat-close').addEventListener('click', () => (setOpen(false), els.fab.focus()));
  els.signin.querySelector('button').addEventListener('click', openDialog);
  $('.chat-clear').addEventListener('click', () => !busy && clearConversation());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.panel.hidden) (setOpen(false), els.fab.focus());
    // On phones the panel covers the whole screen: Tab cycles inside it instead of the hidden page.
    if (e.key === 'Tab' && !els.panel.hidden && phone.matches) {
      const items = [...els.panel.querySelectorAll('button, a[href], textarea, input')].filter((x) => !x.disabled && x.offsetParent);
      const [first, last] = [items[0], items.at(-1)];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  });
  els.list.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) user ? ask(chip.dataset.q) : openDialog();
  });
  els.form.addEventListener('submit', (e) => (e.preventDefault(), ask(els.input.value)));
  // Enter sends, Shift+Enter makes a new line.
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), ask(els.input.value));
  });
  els.input.addEventListener('input', renderChrome);

  document.addEventListener('ibenefits:auth', (e) => {
    const changed = (e.detail?.uid ?? null) !== (user?.uid ?? null);
    user = e.detail;
    if (changed) (messages = []), (credits = undefined), (historyLoaded = false); // another account: start over
    if (!els.panel.hidden) setOpen(true);
  });
}
