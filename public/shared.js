// "Shared by buddy": deals other shoppers spotted and shared (GET/POST/DELETE /api/shared,
// src/shared.js). Anyone can read them; "Share a deal" needs a login and opens a small form. A post
// shows until the end of its "valid until" day; its author (or the owner) can delete it.
import { idToken, openDialog } from './auth.js';
import { toast } from './toast.js';
import { dateField, installDateFields, toDmy } from './datefield.js';

let root = null;
let dialog = null;
let posts = null; // null until loaded
let loadError = null;
let signedIn = false;
let loadedAt = 0; // reopening the page within FRESH_MS reuses the posts
const FRESH_MS = 15_000;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const euro = (n) => (n == null ? '' : `${Number(n).toFixed(2).replace('.', ',')} €`);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const isoDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date(t));

function ago(t) {
  const min = Math.round((Date.now() - Date.parse(t)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// "Until today", "Until tomorrow", "Until 05/11/2026".
function until(validUntil) {
  const day = isoDay(validUntil);
  const today = isoDay(Date.now());
  const tomorrow = isoDay(Date.now() + 86_400_000);
  return day === today ? 'Until today' : day === tomorrow ? 'Until tomorrow' : `Until ${toDmy(day)}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await idToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine === false ? "You're offline. Connect and try again." : "Couldn't reach the server. Check your connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

async function load() {
  try {
    const r = await api('/api/shared');
    posts = r.posts;
    loadError = null;
    loadedAt = Date.now();
  } catch (e) {
    loadError = e.message;
  }
  render();
}

function card(p) {
  const url = safeUrl(p.url);
  return `<article class="buddy-card">
    <div class="buddy-top">
      <span class="buddy-store">${esc(p.store)}</span>
      ${p.discountPct > 0 ? `<span class="buddy-pct">−${p.discountPct}%</span>` : ''}
    </div>
    <h3>${esc(p.title)}</h3>
    ${p.price != null ? `<p class="buddy-price"><b>${euro(p.price)}</b>${p.regularPrice ? ` <s>${euro(p.regularPrice)}</s>` : ''}</p>` : ''}
    ${p.note ? `<p class="buddy-note">${esc(p.note)}</p>` : ''}
    <p class="buddy-meta">${until(p.validUntil)} · shared by ${esc(p.author)}, ${ago(p.createdAt)}</p>
    ${url || p.canDelete ? `<div class="buddy-actions">
      ${url ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">Open link ↗</a>` : ''}
      ${p.canDelete ? `<button class="btn btn-sm buddy-delete" data-delete="${esc(p.id)}">Delete</button>` : ''}
    </div>` : ''}
  </article>`;
}

function render() {
  if (!root) return;
  const list = posts ?? [];
  root.innerHTML = `
    <div class="buddy-head">
      <p class="hint">Spotted a good deal in a shop? Share it so others in Oulu can get it too. Shared deals disappear when they end.</p>
      <button class="btn btn-primary" data-share>Share a deal</button>
    </div>
    ${loadError ? `<p class="empty">${esc(loadError)} <button class="btn btn-sm" data-retry>Try again</button></p>`
      : posts == null ? '<p class="hint">Loading shared deals…</p>'
      : list.length ? `<p class="count">${list.length} shared deal${list.length === 1 ? '' : 's'}</p><div class="buddy-grid">${list.map(card).join('')}</div>`
      : '<p class="empty">No shared deals right now. Be the first: press <b>Share a deal</b>.</p>'}`;
}

// ── Share form ────────────────────────────────────────────────────────────────────────────────
function openForm() {
  if (!signedIn) {
    toast('Log in to share a deal.');
    openDialog();
    return;
  }
  dialog.innerHTML = `<form class="review buddy-form" novalidate>
    <h2>Share a deal</h2>
    <p class="hint">What did you find, and where? Everyone can see shared deals, with your first name.</p>
    <div class="buddy-fields">
      <label class="review-field buddy-wide">What's on offer
        <input name="title" required maxlength="80" placeholder="e.g. Salmon fillet −40 %" autocomplete="off" /></label>
      <label class="review-field buddy-wide">Store
        <input name="store" required maxlength="60" placeholder="e.g. Prisma Linnanmaa" autocomplete="off" /></label>
      <label class="review-field">Price (€)
        <input name="price" inputmode="decimal" maxlength="9" placeholder="4,99" autocomplete="off" /></label>
      <label class="review-field">Normal price (€)
        <input name="regularPrice" inputmode="decimal" maxlength="9" placeholder="7,99" autocomplete="off" /></label>
      <label class="review-field">Valid until (optional)
        ${dateField('', { name: 'validUntil', 'aria-label': 'Valid until' })}</label>
      <label class="review-field">Link (optional)
        <input name="url" type="url" maxlength="500" placeholder="https://…" autocomplete="off" /></label>
      <label class="review-field buddy-wide">Note (optional)
        <textarea name="note" rows="2" maxlength="280" placeholder="e.g. Only at the fish counter, until stock lasts"></textarea></label>
    </div>
    <p class="review-error" role="alert" hidden></p>
    <div class="review-actions">
      <button class="btn" type="button" data-cancel>Cancel</button>
      <button class="btn btn-primary" type="submit">Share</button>
    </div>
  </form>`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[name="title"]').focus();
}

// Prices: digits and one decimal comma (or dot) with at most 2 decimals, so no minus sign or letters.
const PRICE = /^\d{1,6}([.,]\d{1,2})?$/;
const toNumber = (s) => Number(s.replace(',', '.'));
function cleanPrice(input) {
  let v = input.value.replace(/[^\d.,]/g, '');
  const sep = v.search(/[.,]/);
  if (sep >= 0) v = v.slice(0, sep + 1) + v.slice(sep + 1).replace(/[.,]/g, '').slice(0, 2);
  if (v !== input.value) input.value = v;
}

// What's wrong with the form, per field name (empty when it can be sent).
function problems(form) {
  const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
  const out = {};
  if (v('title').length < 3) out.title = 'Say what the deal is (at least 3 characters).';
  if (!v('store')) out.store = 'Say which store has the deal.';
  const price = v('price');
  const regular = v('regularPrice');
  if (price && !PRICE.test(price)) out.price = 'Enter a price like 4,99.';
  if (regular && !PRICE.test(regular)) out.regularPrice = 'Enter a price like 7,99.';
  else if (regular && !price) out.price = 'Add the deal price too.';
  else if (regular && PRICE.test(price) && toNumber(regular) <= toNumber(price)) out.regularPrice = 'The normal price should be higher than the deal price.';
  const date = form.querySelector('[name="validUntil"]');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  if (date.value && !date.dataset.iso) out.validUntil = 'Enter a real date as dd/mm/yyyy, or leave it empty.';
  else if (date.dataset.iso && date.dataset.iso < today) out.validUntil = 'That date has already passed.';
  if (v('url') && !/^https?:\/\/[^\s/]+\.\S+$/i.test(v('url'))) out.url = 'The link should start with https://.';
  return out;
}

// Shows a problem under its field and marks the field red; no text clears it.
function markField(form, name, text) {
  const input = form.querySelector(`[name="${name}"]`);
  const label = input.closest('.review-field');
  let note = label.querySelector('.field-error');
  if (!text) {
    input.removeAttribute('aria-invalid');
    note?.remove();
    return;
  }
  input.setAttribute('aria-invalid', 'true');
  if (!note) {
    note = document.createElement('span');
    note.className = 'field-error';
    label.append(note);
  }
  note.textContent = text;
}

async function submit(form) {
  const err = form.querySelector('.review-error');
  const field = (n) => form.querySelector(`[name="${n}"]`);
  err.hidden = true;
  const found = problems(form);
  for (const name of ['title', 'store', 'price', 'regularPrice', 'validUntil', 'url']) markField(form, name, found[name]);
  const first = Object.keys(found)[0];
  if (first) return field(first).focus();
  const date = field('validUntil');
  const body = {
    title: field('title').value,
    store: field('store').value,
    price: field('price').value,
    regularPrice: field('regularPrice').value,
    validUntil: date.dataset.iso || '',
    url: field('url').value.trim(),
    note: field('note').value,
  };
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const { post } = await api('/api/shared', { method: 'POST', body });
    posts = [post, ...(posts ?? [])];
    dialog.close();
    render();
    toast('Thanks! Your deal is shared.');
  } catch (e) {
    if (e.status === 401) {
      dialog.close();
      openDialog();
      return;
    }
    showError(err, e.message);
  } finally {
    button.disabled = false;
  }
}

function showError(el, text) {
  el.textContent = text;
  el.hidden = false;
}

async function remove(id) {
  if (!confirm('Delete this shared deal?')) return;
  try {
    await api(`/api/shared/${encodeURIComponent(id)}`, { method: 'DELETE' });
    posts = (posts ?? []).filter((p) => p.id !== id);
    render();
    toast('Deleted.');
  } catch (e) {
    toast(e.message);
  }
}

export function mountShared(section) {
  root = section?.querySelector('#buddy');
  if (!root) return;
  installDateFields();
  dialog = document.createElement('dialog');
  dialog.className = 'login-dialog review-dialog';
  dialog.setAttribute('aria-label', 'Share a deal');
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]') || e.target === dialog) dialog.close();
  });
  dialog.addEventListener('input', (e) => {
    const input = e.target.closest('input, textarea');
    if (!input?.name) return;
    if (input.name === 'price' || input.name === 'regularPrice') cleanPrice(input);
    if (input.hasAttribute('aria-invalid')) markField(input.form, input.name, null);
  });
  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(e.target);
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-share]')) openForm();
    else if (e.target.closest('[data-retry]')) load();
    const del = e.target.closest('[data-delete]');
    if (del) remove(del.dataset.delete);
  });
  // Signing in or out changes which posts this person may delete.
  document.addEventListener('ipromotion:account', (e) => {
    signedIn = Boolean(e.detail?.signedIn);
    if (posts != null) load();
  });
}

export function showShared() {
  if (posts != null && Date.now() - loadedAt < FRESH_MS) render();
  else load();
}
