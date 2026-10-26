// "Follow your discount": markets often discount meat and other fresh food on its last day. The
// user photographs products, presses "Mark the dates", and the server's vision model reads each
// label's use-by or best-before date (POST /api/expiry/scan, src/expiry.js). Found dates are saved
// to the user's account and shown on a month calendar and an upcoming list, each downloadable as an
// .ics event. Signed-in users only; photos are shrunk here and never stored.
import { idToken, openDialog } from './auth.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MAX_SIDE = 768; // px: keeps a photo around 500 image tokens
const PARALLEL = 3;
const CLIENT_TIMEOUT_MS = 11_000; // the server gives the model 8 s; this only catches a stuck request

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
let photos = []; // { id, thumb, data, status: preparing|ready|checking|done|failed, result, error }
let entries = null; // saved dates from the server; null until loaded
let month = firstOfMonth(new Date());
let loadError = '';

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
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

async function loadEntries() {
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
  URL.revokeObjectURL(p.thumb);
  photos = photos.filter((x) => x !== p);
  render();
}

// Checks one photo; a found date is saved to the calendar right away.
async function check(p) {
  Object.assign(p, { status: 'checking', error: '', result: null });
  render();
  try {
    const r = await api('/api/expiry/scan', { method: 'POST', body: { image: p.data }, timeout: CLIENT_TIMEOUT_MS });
    p.result = r;
    if (r.found) {
      const saved = await api('/api/expiry', { method: 'POST', body: { kind: r.kind, date: r.date, product: r.product } });
      entries = [...(entries ?? []), saved];
      p.status = 'done';
    } else {
      Object.assign(p, { status: 'failed', error: REASONS[r.reason] ?? REASONS.no_date });
    }
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    Object.assign(p, { status: 'failed', error: timedOut ? REASONS.timeout : e.message });
    if (e.status === 401) openDialog();
  }
  render();
}

// "Mark the dates": every photo not yet checked, a few at a time.
async function markAll() {
  const queue = photos.filter((p) => p.status === 'ready');
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await check(queue.shift());
  }));
}

// A date typed in by hand for a photo the model couldn't read.
async function addByHand(p, date) {
  try {
    const saved = await api('/api/expiry', { method: 'POST', body: { kind: 'use_by', date, product: p.result?.product } });
    entries = [...(entries ?? []), saved];
    Object.assign(p, { status: 'done', error: '', result: { found: true, kind: 'use_by', date, product: saved.product } });
  } catch (e) {
    p.error = e.message;
  }
  render();
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

function render() {
  renderCount();
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
  body.innerHTML = `${photoCard()}<div class="follow-split">${calendarCard()}${upcomingCard()}</div>`;
}

function photoCard() {
  const ready = photos.filter((p) => p.status === 'ready').length;
  const busy = photos.some((p) => p.status === 'checking' || p.status === 'preparing');
  return `<div class="follow-card">
    <div class="follow-head">
      <div><h2>Add products</h2><p class="hint">Photograph the label so the date is sharp and readable. Packing dates are ignored.</p></div>
      <div class="follow-pick">
        <label class="btn"><input type="file" accept="image/*" capture="environment" data-act="files" hidden />Take photo</label>
        <label class="btn"><input type="file" accept="image/*" multiple data-act="files" hidden />Choose photos</label>
      </div>
    </div>
    ${photos.length ? `<ul class="tray">${photos.map(photoItem).join('')}</ul>` : '<p class="tray-empty">No photos yet.</p>'}
    <div class="follow-actions">
      ${photos.length && !busy ? '<button class="btn" data-act="clear">Clear photos</button>' : ''}
      <button class="btn btn-primary" data-act="mark" ${ready && !busy ? '' : 'disabled'}>Mark the dates${ready ? ` (${ready})` : ''}</button>
    </div>
  </div>`;
}

function photoItem(p) {
  const r = p.result;
  const status = {
    preparing: '<span class="tray-status">Preparing…</span>',
    ready: '<span class="tray-status">Ready</span>',
    checking: '<span class="tray-status busy"><span class="spin"></span>Reading date…</span>',
    done: r ? `<span class="tray-status ok">${KIND[r.kind]} ${esc(fmtDay(r.date))}</span>` : '',
    failed: `<span class="tray-status bad">${esc(p.error)}</span>`,
  }[p.status];
  return `<li class="tray-item ${p.status}">
    <div class="tray-thumb"><img src="${esc(p.thumb)}" alt="" />
      ${p.status !== 'checking' ? `<button class="tray-x" data-act="remove" data-id="${p.id}" aria-label="Remove photo">×</button>` : ''}</div>
    ${r?.product ? `<b class="tray-name">${esc(r.product)}</b>` : ''}
    ${status}
    ${p.status === 'failed' && p.data ? `<div class="tray-fix">
      <button class="btn btn-sm" data-act="retry" data-id="${p.id}">Retry</button>
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
    }).join('')}</ul>` : '<p class="tray-empty">No dates yet. Add photos above and press <b>Mark the dates</b>.</p>'}
  </div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────
export function mountFollow(section) {
  root = section;
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const { act, id } = el.dataset;
    if (act === 'login') openDialog();
    else if (act === 'remove') removePhoto(id);
    else if (act === 'clear') {
      photos.forEach((p) => URL.revokeObjectURL(p.thumb));
      photos = [];
      render();
    } else if (act === 'mark') markAll();
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
