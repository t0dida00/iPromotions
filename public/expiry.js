// "Follow your discount": markets often discount meat and other fresh food on its last day. The
// user photographs products, presses "Check", and the server's vision model reads each label's
// use-by or best-before date (POST /api/expiry/scan, src/expiry.js). The dates found are listed in a
// review dialog where the user fixes the product name, date and kind, adds a location, and saves
// (or cancels); "Enter manually" opens the same dialog with an empty row and no photo. Saved dates go to the user's account and are shown on a month calendar and an
// upcoming list, each downloadable as an .ics event. Signed-in users only; photos are shrunk here
// and never stored.
import { idToken, openDialog } from './auth.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MAX_SIDE = 768; // px: keeps a photo around 500 image tokens
const PARALLEL = 3;
const CLIENT_TIMEOUT_MS = 11_000; // the server gives the model 8 s; this only catches a stuck request

const PEN = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/></svg>';
const KIND = { use_by: 'Use by', best_before: 'Best before' };
const REASONS = {
  not_label: "This doesn't look like a product label.",
  no_date: 'No expiry date found in this photo.',
  packing_date_only: "Only a packing date — that one doesn't count.",
  unreadable: 'The date is hard to read. Retake it closer, in good light.',
  timeout: 'That took too long. Retake the photo closer to the label.',
  invalid_date: "The date didn't look right. Retake it closer to the label.",
};

let root = null;
let user = null;
// status: preparing → ready → checking → found (read, not saved yet) → done (saved), or failed.
// Dates typed in with "Enter manually" are rows too, with no photo (thumb null), and skip the tray.
let photos = []; // { id, thumb, data, status, result, error }
let entries = null; // saved dates from the server; null until loaded
let month = firstOfMonth(new Date());
let loadError = '';
let credits; // { balance, unlimitedUntil, nextFreeAt, owner }; null = not metered; undefined = not loaded
let dialog = null; // the review dialog (<dialog>), created on mount
const LAST_LOCATION = 'ipromotion.expiryLocation'; // suggested for new rows, in this browser only
const lastLocation = () => { try { return localStorage.getItem(LAST_LOCATION) ?? ''; } catch { return ''; } };

// ── Dates (local calendar days as YYYY-MM-DD) ────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
const daysUntil = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
const fmtDay = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
function relative(date) {
  const n = daysUntil(date);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `In ${n} days` : n === -1 ? 'Yesterday' : `${-n} days ago`;
}

// ── Server calls, as the signed-in user ──────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, timeout } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${await idToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

async function loadEntries() {
  api('/api/credits').then((r) => ((credits = r.credits), render())).catch(() => {});
  try {
    entries = (await api('/api/expiry')).entries;
    loadError = '';
  } catch (e) {
    loadError = e.message;
  }
  render();
}

// ── Photos ───────────────────────────────────────────────────────────────────────────────────
// Shrinks a photo to ≤ 768 px (respecting the camera's rotation) as a JPEG data URL.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const p = { id: crypto.randomUUID(), thumb: URL.createObjectURL(file), data: null, status: 'preparing', result: null, error: '' };
    photos.push(p);
    shrink(file)
      .then((data) => Object.assign(p, { data, status: 'ready' }))
      .catch(() => Object.assign(p, { status: 'failed', error: "This photo format can't be read here. Try a JPEG or PNG." }))
      .finally(render);
  }
  render();
}

function removePhoto(id) {
  const p = photos.find((x) => x.id === id);
  if (!p || p.status === 'checking') return;
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  photos = photos.filter((x) => x !== p);
  render();
}

// Reads one photo's date. Nothing is saved here: found dates wait for the review dialog.
async function check(p) {
  Object.assign(p, { status: 'checking', error: '', result: null });
  render();
  try {
    const r = await api('/api/expiry/scan', { method: 'POST', body: { image: p.data }, timeout: CLIENT_TIMEOUT_MS });
    if (r.credits) credits = r.credits;
    p.result = r;
    if (r.found) Object.assign(p, { status: 'found', draft: { kind: r.kind, date: r.date, product: r.product ?? '', location: lastLocation() } });
    else Object.assign(p, { status: 'failed', error: REASONS[r.reason] ?? REASONS.no_date });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    // 402 = out of checks: this photo waits (the date can still be typed in, which is free).
    Object.assign(p, { status: 'failed', error: timedOut ? REASONS.timeout : e.message, outOfChecks: e.status === 402 });
    if (e.data?.credits) credits = e.data.credits;
    if (e.status === 401) openDialog();
  }
  render();
}

// "Check": every photo not yet checked, a few at a time; then the dates found go to the review.
async function checkAll() {
  const queue = photos.filter((p) => p.status === 'ready');
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await check(queue.shift());
  }));
  openReview();
}

// A date typed in by hand for a photo the model couldn't read: reviewed like the others.
function addByHand(p, date) {
  Object.assign(p, { status: 'found', error: '', draft: { kind: 'use_by', date, product: p.result?.product ?? '', location: lastLocation() } });
  render();
  openReview();
}

// "Enter manually": a new date with no photo, straight to the review dialog.
function addManual() {
  photos.push({ id: crypto.randomUUID(), thumb: null, data: null, status: 'found', result: null, error: '', draft: { kind: 'use_by', date: today(), product: '', location: lastLocation() } });
  render();
  openReview();
}

// ── Review dialog: the dates found, editable, then Save or Cancel ─────────────────────────────
const pending = () => photos.filter((p) => p.status === 'found');

function openReview() {
  const list = pending();
  if (!list.length || !dialog) return;
  dialog.innerHTML = `<form class="review" method="dialog">
    <h2 id="review-title">${list.length > 1 ? `${list.length} dates to save` : list[0].thumb ? 'Date found' : 'New date'}</h2>
    <p class="hint">Check each date, name the product and add where you saw it. Nothing is saved until you press Save.</p>
    <ul class="review-list">${list.map(reviewRow).join('')}</ul>
    <p class="review-error" role="alert" hidden></p>
    <div class="review-actions">
      <button class="btn" type="button" data-review="cancel">Cancel</button>
      <button class="btn btn-primary" type="submit" data-review="save">Save${list.length > 1 ? ` ${list.length} dates` : ''}</button>
    </div>
  </form>`;
  if (!dialog.open) dialog.showModal();
}

function reviewRow(p) {
  const d = p.draft;
  return `<li class="review-row" data-id="${p.id}">
    ${p.thumb ? `<img class="review-thumb" src="${esc(p.thumb)}" alt="" />` : `<span class="review-thumb manual" aria-hidden="true">${PEN}</span>`}
    <div class="review-fields">
      <label class="review-field review-product"><span>Product name</span>
        <input name="product" value="${esc(d.product)}" placeholder="e.g. Chicken fillet" maxlength="60" required /></label>
      <label class="review-field"><span>Date</span>
        <input name="date" type="date" value="${esc(d.date)}" required /></label>
      <label class="review-field"><span>Type</span>
        <select name="kind">${Object.entries(KIND).map(([k, label]) => `<option value="${k}"${k === d.kind ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="review-field review-location"><span>Location</span>
        <input name="location" value="${esc(d.location)}" placeholder="e.g. Prisma Linnanmaa" maxlength="60" /></label>
    </div>
    <button class="review-x" type="button" data-review="drop" aria-label="Leave this date out" title="Leave this date out">×</button>
  </li>`;
}

// Copies what the user typed back into each photo's draft (so Cancel keeps their edits).
function readDrafts() {
  for (const row of dialog.querySelectorAll('.review-row')) {
    const p = photos.find((x) => x.id === row.dataset.id);
    if (!p) continue;
    const val = (name) => row.querySelector(`[name="${name}"]`).value.trim();
    p.draft = { product: val('product'), date: val('date'), kind: val('kind'), location: val('location') };
  }
}

async function saveReview() {
  readDrafts();
  const list = pending();
  const button = dialog.querySelector('[data-review="save"]');
  button.disabled = true;
  button.textContent = 'Saving…';
  const failed = [];
  for (const p of list) {
    try {
      const saved = await api('/api/expiry', { method: 'POST', body: p.draft });
      entries = [...(entries ?? []), saved];
      Object.assign(p, { status: 'done', result: { ...p.result, found: true, ...saved } });
    } catch (e) {
      failed.push(e.message);
      if (e.status === 401) openDialog();
    }
  }
  const location = list.map((p) => p.draft.location).find(Boolean);
  if (location) try { localStorage.setItem(LAST_LOCATION, location); } catch {}
  photos = photos.filter((p) => p.thumb || p.status !== 'done'); // typed-in dates have no tray item
  render();
  if (!failed.length) return dialog.close();
  openReview(); // only the rows that didn't save are left
  const err = dialog.querySelector('.review-error');
  err.textContent = `${failed.length === 1 ? 'One date' : `${failed.length} dates`} couldn't be saved: ${failed[0]}`;
  err.hidden = false;
}

function mountReview() {
  dialog = document.createElement('dialog');
  dialog.className = 'login-dialog review-dialog';
  dialog.setAttribute('aria-labelledby', 'review-title');
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    const act = e.target.closest('[data-review]')?.dataset.review;
    if (act === 'cancel') {
      readDrafts();
      dialog.close();
    } else if (act === 'drop') {
      readDrafts();
      // Left out = not wanted: the photo goes too (checking it again would only cost another read).
      removePhoto(e.target.closest('.review-row').dataset.id);
      if (pending().length) openReview();
      else dialog.close();
    }
  });
  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    saveReview();
  });
  dialog.addEventListener('cancel', () => readDrafts()); // Esc: same as Cancel
}

// ── Saved dates ──────────────────────────────────────────────────────────────────────────────
async function changeEntry(id, changes) {
  try {
    const saved = await api(`/api/expiry/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
    entries = entries.map((e) => (e.id === id ? saved : e));
  } catch (e) {
    loadError = e.message;
  }
  render();
}

async function deleteEntry(id) {
  try {
    await api(`/api/expiry/${encodeURIComponent(id)}`, { method: 'DELETE' });
    entries = entries.filter((e) => e.id !== id);
  } catch (e) {
    loadError = e.message;
  }
  render();
}

// .ics with all-day events and a reminder at 18:00 the evening before.
function downloadIcs(list, name) {
  const text = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const compact = (date) => date.replaceAll('-', '');
  const next = (date) => ymd(new Date(new Date(`${date}T12:00:00`).getTime() + 86_400_000));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const events = list.map((e) => [
    'BEGIN:VEVENT',
    `UID:${e.id}@ipromotion`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compact(e.date)}`,
    `DTEND;VALUE=DATE:${compact(next(e.date))}`,
    `SUMMARY:${text(`${KIND[e.kind]}: ${e.product}`)}`,
    `DESCRIPTION:${text('Last day — look for the discount sticker in the store.')}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    'BEGIN:VALARM', 'TRIGGER:-PT6H', 'ACTION:DISPLAY', `DESCRIPTION:${text(`${e.product} expires tomorrow`)}`, 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//iPromotion//Follow your discount//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────
// Sidebar badge: how many saved dates are today or later (hidden when signed out or none).
function renderCount() {
  const badge = document.getElementById('follow-count');
  const n = user && entries ? entries.filter((e) => daysUntil(e.date) >= 0).length : 0;
  badge.hidden = !n;
  badge.textContent = n;
  badge.title = `${n} upcoming date${n === 1 ? '' : 's'}`;
}

// Dashboard: the next few dates, read-only, above the crawler status. Only when signed in with
// dates coming up; editing stays on the Follow page.
const DASH_UPCOMING = 5;
function renderDashUpcoming() {
  const box = document.getElementById('dash-upcoming');
  if (!box) return;
  const next = user && entries ? entries.filter((e) => daysUntil(e.date) >= 0).sort((a, b) => a.date.localeCompare(b.date)) : [];
  box.hidden = !next.length;
  if (!next.length) return (box.innerHTML = '');
  box.innerHTML = `<div class="follow-card">
    <div class="cal-head">
      <h2>Upcoming</h2>
      <a class="btn btn-sm" href="/follow" data-view-link>${next.length > DASH_UPCOMING ? `See all ${next.length}` : 'Open Follow discounts'} →</a>
    </div>
    <ul class="upcoming dash-up">${next.slice(0, DASH_UPCOMING).map((e) => {
      const n = daysUntil(e.date);
      return `<li class="${n === 0 ? 'today' : n === 1 ? 'soon' : ''}">
        <span class="up-when"><b>${relative(e.date)}</b><span>${esc(fmtDay(e.date))}</span></span>
        <span class="up-what"><b class="dash-up-name">${esc(e.product)}</b>${e.location ? `<span class="dash-up-loc">${esc(e.location)}</span>` : ''}</span>
        <span class="chip ${e.kind}">${KIND[e.kind]}</span>
      </li>`;
    }).join('')}</ul>
  </div>`;
}

function render() {
  renderCount();
  renderDashUpcoming();
  if (!root) return;
  const body = root.querySelector('#follow');
  if (!user) {
    body.innerHTML = `<div class="follow-card follow-login">
      <h2>Log in to follow expiry dates</h2>
      <p class="hint">Snap the labels of meat, fish or dairy you want. We read the use-by or best-before date and mark it
      on your calendar, so you know which day it's likely to be discounted.</p>
      <button class="btn btn-primary" data-act="login">Login</button>
    </div>`;
    return;
  }
  // Upcoming first: the dates coming up are what people open this page for.
  body.innerHTML = `${upcomingCard()}${photoCard()}${calendarCard()}`;
}

function photoCard() {
  const tray = photos.filter((p) => p.thumb);
  const ready = photos.filter((p) => p.status === 'ready').length;
  const toReview = pending().length;
  const busy = photos.some((p) => p.status === 'checking' || p.status === 'preparing');
  return `<div class="follow-card">
    <div class="follow-head">
      <div><h2>Add products</h2><p class="hint">Photograph the label so the date is sharp and readable, or enter the date yourself. Packing dates are ignored.</p></div>
      <div class="follow-pick">
        <button class="btn" data-act="manual-add">Enter manually</button>
        <label class="btn"><input type="file" accept="image/*" capture="environment" data-act="files" hidden />Take photo</label>
        <label class="btn"><input type="file" accept="image/*" multiple data-act="files" hidden />Choose photos</label>
      </div>
    </div>
    ${tray.length ? `<ul class="tray">${tray.map(photoItem).join('')}</ul>` : '<p class="tray-empty">No photos yet.</p>'}
    ${creditsLine()}
    <div class="follow-actions">
      ${tray.length && !busy ? '<button class="btn" data-act="clear">Clear photos</button>' : ''}
      ${toReview && !busy ? `<button class="btn" data-act="review">Review &amp; save (${toReview})</button>` : ''}
      ${outOfChecks() && !busy
        ? '<a class="btn btn-primary" href="/pricing" data-view-link>Get more checks</a>'
        : `<button class="btn btn-primary" data-act="check" ${ready && !busy ? '' : 'disabled'}>${busy && !ready ? 'Checking…' : 'Check'}${ready ? ` (${ready})` : ''}</button>`}
    </div>
  </div>`;
}

// Checks left, from the server (null when checks aren't metered, e.g. locally without a database).
const outOfChecks = () => Boolean(credits && !credits.owner && !credits.unlimitedUntil && credits.balance < 1);
function creditsLine() {
  if (!credits) return '';
  const when = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const text = credits.owner
    ? 'Checks are free for the owner'
    : credits.unlimitedUntil
      ? `<b>Unlimited</b> until ${esc(when(credits.unlimitedUntil))}`
      : `<b>${credits.balance}</b> check${credits.balance === 1 ? '' : 's'} left · +1 free on ${esc(when(credits.nextFreeAt))}`;
  return `<p class="credits-line"><span>${text}. A check is used only when a date is found; typing a date is free.</span>
    <a href="/pricing" data-view-link>${outOfChecks() ? 'Get more checks' : 'Pricing'}</a></p>`;
}

function photoItem(p) {
  const r = p.result;
  const status = {
    preparing: '<span class="tray-status">Preparing…</span>',
    ready: '<span class="tray-status">Ready</span>',
    checking: '<span class="tray-status busy"><span class="spin"></span>Reading date…</span>',
    found: p.draft ? `<span class="tray-status">${KIND[p.draft.kind]} ${esc(fmtDay(p.draft.date))} · not saved</span>` : '',
    done: r ? `<span class="tray-status ok">Saved · ${KIND[r.kind]} ${esc(fmtDay(r.date))}</span>` : '',
    failed: `<span class="tray-status bad">${esc(p.error)}</span>`,
  }[p.status];
  return `<li class="tray-item ${p.status}">
    <div class="tray-thumb"><img src="${esc(p.thumb)}" alt="" />
      ${p.status !== 'checking' ? `<button class="tray-x" data-act="remove" data-id="${p.id}" aria-label="Remove photo">×</button>` : ''}</div>
    ${(p.draft?.product || r?.product) ? `<b class="tray-name">${esc(p.draft?.product || r.product)}</b>` : ''}
    ${status}
    ${p.status === 'failed' && p.data ? `<div class="tray-fix">
      ${p.outOfChecks ? '<a class="btn btn-sm btn-primary" href="/pricing" data-view-link>Get checks</a>' : `<button class="btn btn-sm" data-act="retry" data-id="${p.id}">Retry</button>`}
      <input type="date" data-act="manual" data-id="${p.id}" aria-label="Enter the date by hand" title="Enter the date by hand" />
    </div>` : ''}
  </li>`;
}

function calendarCard() {
  const byDay = {};
  for (const e of entries ?? []) (byDay[e.date] ??= []).push(e);
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7)); // back to Monday
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0); // last day of the month
  const cells = [];
  // Whole weeks, Monday to Sunday, until the month's last day is shown.
  for (let d = new Date(start); d <= end || cells.length % 7; d.setDate(d.getDate() + 1)) {
    const key = ymd(d);
    const items = byDay[key] ?? [];
    cells.push(`<div class="cal-day${d.getMonth() !== month.getMonth() ? ' other' : ''}${key === today() ? ' today' : ''}"${items.length ? ` title="${esc(items.map((e) => `${KIND[e.kind]}: ${e.product}${e.location ? ` (${e.location})` : ''}`).join('\n'))}"` : ''}>
      <span class="cal-num">${d.getDate()}</span>
      ${items.length ? `<span class="cal-dots">${items.slice(0, 4).map((e) => `<span class="chip ${e.kind}">${esc(e.product)}</span>`).join('')}</span>` : ''}
    </div>`);
  }
  const title = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return `<div class="follow-card">
    <div class="cal-head">
      <h2>${title}</h2>
      <div class="cal-nav">
        <button class="btn btn-sm" data-act="today">Today</button>
        <button class="btn btn-sm btn-icon" data-act="month" data-step="-1" aria-label="Previous month">‹</button>
        <button class="btn btn-sm btn-icon" data-act="month" data-step="1" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="cal-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
    <p class="cal-legend"><span class="chip use_by">Use by</span><span class="chip best_before">Best before</span></p>
  </div>`;
}

function upcomingCard() {
  if (entries === null)
    return `<div class="follow-card"><p class="hint">${loadError ? esc(loadError) : 'Loading your dates…'}</p></div>`;
  const list = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  return `<div class="follow-card">
    <div class="cal-head">
      <h2>Upcoming</h2>
      ${list.length ? '<button class="btn btn-sm" data-act="ics-all">Add all to calendar (.ics)</button>' : ''}
    </div>
    ${loadError ? `<p class="login-note">${esc(loadError)}</p>` : ''}
    ${list.length ? `<ul class="upcoming">${list.map((e) => {
      const n = daysUntil(e.date);
      return `<li class="${n < 0 ? 'past' : n === 0 ? 'today' : n === 1 ? 'soon' : ''}">
        <span class="up-when"><b>${relative(e.date)}</b><span>${esc(fmtDay(e.date))}</span></span>
        <span class="up-what">
          <span class="up-line">
            <input class="up-name" value="${esc(e.product)}" data-act="rename" data-id="${e.id}" aria-label="Product name" maxlength="60" />
            <span class="chip ${e.kind}">${KIND[e.kind]}</span>
          </span>
          <label class="up-loc">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
            <input value="${esc(e.location ?? '')}" data-act="relocate" data-id="${e.id}" placeholder="Add location, e.g. Prisma Linnanmaa" aria-label="Location" maxlength="60" />
          </label>
        </span>
        <span class="up-tools">
          <input type="date" value="${e.date}" data-act="redate" data-id="${e.id}" aria-label="Change date" />
          <button class="btn btn-sm" data-act="ics" data-id="${e.id}" title="Add to calendar (.ics)">.ics</button>
          <button class="btn btn-sm btn-icon" data-act="delete" data-id="${e.id}" aria-label="Delete">×</button>
        </span>
      </li>`;
    }).join('')}</ul>` : '<p class="tray-empty">No dates yet. Add photos above and press <b>Check</b>, or <b>Enter manually</b>.</p>'}
  </div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────
export function mountFollow(section) {
  root = section;
  mountReview();
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const { act, id } = el.dataset;
    if (act === 'login') openDialog();
    else if (act === 'remove') removePhoto(id);
    else if (act === 'manual-add') addManual();
    else if (act === 'clear') {
      photos.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
      photos = photos.filter((p) => !p.thumb); // keeps typed-in dates waiting for review
      render();
    } else if (act === 'check') checkAll();
    else if (act === 'review') openReview();
    else if (act === 'retry') check(photos.find((p) => p.id === id));
    else if (act === 'delete') deleteEntry(id);
    else if (act === 'ics') downloadIcs(entries.filter((x) => x.id === id), 'expiry-date.ics');
    else if (act === 'ics-all') downloadIcs(entries.filter((x) => daysUntil(x.date) >= 0), 'expiry-dates.ics');
    else if (act === 'today') {
      month = firstOfMonth(new Date());
      render();
    } else if (act === 'month') {
      month = new Date(month.getFullYear(), month.getMonth() + Number(el.dataset.step), 1);
      render();
    }
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    const { act, id } = el.dataset;
    if (act === 'files') {
      addFiles([...el.files]);
      el.value = '';
    } else if (act === 'manual' && el.value) addByHand(photos.find((p) => p.id === id), el.value);
    else if (act === 'redate' && el.value) changeEntry(id, { date: el.value });
    else if (act === 'rename' && el.value.trim()) changeEntry(id, { product: el.value.trim() });
    else if (act === 'relocate') changeEntry(id, { location: el.value.trim() });
  });
  document.addEventListener('ibenefits:auth', (e) => {
    const uid = e.detail?.uid ?? null;
    if (uid === (user?.uid ?? null)) return;
    user = e.detail;
    entries = null;
    if (user) loadEntries();
    else render();
  });
  render();
}

// Called when the section is opened.
export function showFollow() {
  if (user && entries === null) loadEntries();
  else render();
}
