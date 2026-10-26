// Dashboard section: crawler ("service") health, refresh times and run history from /api/status.
import { friendlyError, describeCron } from './friendly.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDur = (ms) => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function relative(iso) {
  if (!iso) return '';
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 3_600_000 ? [Math.round(abs / 60_000), 'minute'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'hour'] : [Math.round(abs / 86_400_000), 'day'];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(diff < 0 ? -n : n, unit);
}

function uptime(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const TRIGGERS = { schedule: 'Scheduled', manual: 'Refresh button', startup: 'Server start', cli: 'Command line' };

let timer = null;
// Refresh history is paged in the browser; the page stays put across the periodic re-renders.
const RUNS_PER_PAGE = 10;
let runsPage = 0;
let last = null;

// "Refresh section" buttons ask app.js to start the crawl, so the whole page shows it as busy.
document.getElementById('dash').addEventListener('click', (e) => {
  const p = e.target.closest('[data-runs-page]');
  if (p) {
    runsPage = Number(p.dataset.runsPage);
    clearTimeout(timer);
    render(last);
    return;
  }
  const b = e.target.closest('[data-refresh-seg]');
  if (!b) return;
  b.disabled = true;
  document.dispatchEvent(new CustomEvent('ipromotion:crawl', { detail: `?segment=${encodeURIComponent(b.dataset.refreshSeg)}` }));
});

export function showDashboard() {
  clearTimeout(timer);
  refresh();
}

export function hideDashboard() {
  clearTimeout(timer);
  timer = null;
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 429) {
      timer = setTimeout(refresh, (Number(res.headers.get('Retry-After')) || 30) * 1000);
      return;
    }
    render(await res.json());
  } catch {
    document.getElementById('dash').innerHTML = '<p class="hint">Could not reach the server.</p>';
  }
}

function render(s) {
  last = s;
  const crawlable = s.stores.filter((x) => x.hasDeals);
  const healthy = crawlable.filter((x) => x.status?.ok).length;
  const failing = crawlable.filter((x) => x.status && !x.status.ok);
  const c = s.crawling;

  const banner = c
    ? `<div class="dash-banner running"><span class="pulse"></span><span>Refreshing now: ${
        c.running.length
          ? `crawling <b>${c.running.map((k) => esc(s.stores.find((x) => x.key === k)?.name ?? k)).join(', ')}</b>${c.running.length > 1 ? ' in parallel' : ''}`
          : 'starting'
      } · ${c.done.length}/${(c.scope ?? crawlable).length} done · started ${relative(c.startedAt)}</span></div>`
    : failing.length
      ? `<div class="dash-banner bad">${failing.length} service${failing.length > 1 ? 's' : ''} failed on the last refresh: ${failing
          .map((x) => esc(x.name))
          .join(', ')}. Their previous deals are still shown.</div>`
      : '';

  const tiles = [
    ['Services online', `${healthy}<small>/${crawlable.length}</small>`, healthy === crawlable.length ? 'All crawlers healthy' : `${crawlable.length - healthy} need attention`, healthy === crawlable.length ? 'ok' : 'bad'],
    ['Latest refresh', s.updatedAt ? relative(s.updatedAt) : 'Never', fmtDate(s.updatedAt)],
    ['Next refresh', s.schedule.nextRun ? relative(s.schedule.nextRun) : '—', `${fmtDate(s.schedule.nextRun)}<br>${s.schedule.label ? `${esc(s.schedule.label)}: ` : ''}${esc(describeCron(s.schedule.cron))}`],
    ['Deals tracked', s.totalDeals.toLocaleString('en-GB'), `across ${crawlable.length} stores`],
    ['Server uptime', uptime(s.server.startedAt), `since ${fmtDate(s.server.startedAt)}`],
  ];

  // A failed store: what went wrong in plain words, and the raw error for owners only.
  const errorNote = (raw) => `<div class="err">${esc(friendlyError(raw))} Its previous deals are still shown, and it will be tried again on the next refresh.</div>
    <details class="err-details"><summary>Technical details</summary><code>${esc(raw)}</code></details>`;

  const statusPill = (x) => {
    if (!x.hasDeals) return '<span class="pill muted">Brochure only</span>';
    if (c?.running.includes(x.key)) return '<span class="pill run">Crawling…</span>';
    if (c?.scope?.includes(x.key) && !c.done.includes(x.key)) return '<span class="pill run">Waiting…</span>';
    if (c?.queued?.includes(x.key)) return '<span class="pill run">Queued</span>';
    if (c?.done.includes(x.key) && x.status?.ok) return '<span class="pill ok">Done</span>';
    if (!x.status) return '<span class="pill muted">Never run</span>';
    return x.status.ok ? '<span class="pill ok">Online</span>' : '<span class="pill bad">Failed</span>';
  };

  const SEGMENTS = { groceries: 'Market Promotions', clothing: 'Cloth Promotions', electronics: 'Electronics Promotions', food: 'Food Promotions' };
  const services = Object.entries(SEGMENTS)
    .map(([seg, title]) => {
      const rows = s.stores.filter((x) => (x.segment ?? 'groceries') === seg);
      if (!rows.length) return '';
      // "Refresh section" fetches every store in this section; busy while any of them runs.
      const keys = rows.filter((x) => x.hasDeals).map((x) => x.key);
      const busy = keys.some((k) => (c?.scope?.includes(k) && !c.done.includes(k)) || c?.queued?.includes(k));
      const waits = rows.filter((x) => x.hasDeals).map((x) => x.cooldownUntil);
      const cooling = waits.length && waits.every(Boolean);
      const btn = keys.length
        ? `<button class="btn btn-sm" data-refresh-seg="${seg}" ${busy || cooling ? 'disabled' : ''}>${
            busy ? 'Refreshing…' : cooling ? `Again at ${hhmm(waits.sort()[0])}` : 'Refresh section'
          }</button>`
        : '';
      return `<tr class="seg-row"><td colspan="6"><div class="seg-head"><span>${title}</span>${btn}</div></td></tr>` + serviceRows(rows);
    })
    .join('');

  function serviceRows(list) {
    return list
    .map(
      (x) => `<tr>
        <td><div class="svc">${x.logo ? `<img src="${esc(x.logo)}" alt="${esc(x.name)}" />` : `<b>${esc(x.name)}</b>`}<span>${esc(x.label)}</span></div></td>
        <td>${statusPill(x)}${x.status && !x.status.ok ? errorNote(x.status.error) : ''}</td>
        <td class="num">${x.hasDeals ? x.deals.toLocaleString('en-GB') : '—'}</td>
        <td class="num">${x.avgDiscount != null ? `−${x.avgDiscount}%` : '—'}</td>
        <td>${x.status?.crawledAt ? `${relative(x.status.crawledAt)}<div class="muted">${fmtDate(x.status.crawledAt)}</div>` : '—'}</td>
        <td class="num">${fmtDur(x.status?.durationMs)}</td>
      </tr>`,
    )
    .join('');
  }

  const pages = Math.max(1, Math.ceil(s.runs.length / RUNS_PER_PAGE));
  runsPage = Math.min(runsPage, pages - 1);
  const from = runsPage * RUNS_PER_PAGE;
  const pager =
    pages > 1
      ? `<div class="pager">
          <button class="btn btn-sm btn-icon" data-runs-page="${runsPage - 1}" aria-label="Newer" title="Newer" ${runsPage === 0 ? 'disabled' : ''}>‹</button>
          <span class="muted">${from + 1}–${Math.min(from + RUNS_PER_PAGE, s.runs.length)} of ${s.runs.length}</span>
          <button class="btn btn-sm btn-icon" data-runs-page="${runsPage + 1}" aria-label="Older" title="Older" ${runsPage === pages - 1 ? 'disabled' : ''}>›</button>
        </div>`
      : '';

  const runs = s.runs.length
    ? s.runs
        .slice(from, from + RUNS_PER_PAGE)
        .map(
          (r) => `<tr>
            <td>${fmtDate(r.startedAt)}<div class="muted">${relative(r.startedAt)}</div></td>
            <td>${esc(TRIGGERS[r.trigger] ?? r.trigger)}<div class="muted">${r.stores ? esc(r.stores.map((k) => s.stores.find((x) => x.key === k)?.name ?? k).join(', ')) : 'All stores'}</div></td>
            <td class="num">${fmtDur(r.durationMs)}</td>
            <td class="num">${r.deals.toLocaleString('en-GB')}</td>
            <td>${r.failed.length ? `<span class="pill bad">${r.failed.length} failed</span> <span class="muted">${esc(r.failed.join(', '))}</span>` : '<span class="pill ok">All OK</span>'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No refreshes recorded yet — history starts with the next refresh.</td></tr>';

  document.getElementById('dash').innerHTML = `
    ${banner}
    <div class="tiles">${tiles
      .map(([label, value, note, tone]) => `<div class="tile ${tone ?? ''}"><span class="tlabel">${label}</span><span class="tvalue">${value}</span><span class="tnote">${note}</span></div>`)
      .join('')}</div>

    <h2>Services</h2>
    <div class="table-wrap"><table class="dtable">
      <thead><tr><th>Store</th><th>Status</th><th class="num">Deals</th><th class="num">Avg. discount</th><th>Last crawl</th><th class="num">Took</th></tr></thead>
      <tbody>${services}</tbody>
    </table></div>

    <h2>Refresh history</h2>
    <div class="table-wrap"><table class="dtable">
      <thead><tr><th>Started</th><th>Triggered by</th><th class="num">Took</th><th class="num">Deals</th><th>Result</th></tr></thead>
      <tbody>${runs}</tbody>
    </table></div>
    ${pager}`;

  // Poll quickly while a crawl runs, otherwise just keep the relative times fresh.
  timer = setTimeout(refresh, c ? 3000 : 30000);
}
