// /pricing: AI checks — photo checks in "Follow your discount" and deals assistant questions. Free checks (3 to start, +1 a week), packs
// and a 30-day Unlimited pass, bought through Stripe Checkout (POST /api/billing/checkout →
// Stripe's page → back to /pricing?paid=…, where we wait for the webhook to add the checks).
import { idToken, openDialog } from './auth.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const euro = (cents) => `€${(cents / 100).toFixed(2)}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

let root = null;
let user = null;
let info = null; // GET /api/plans
let credits; // undefined = not loaded, null = not metered
let notice = null; // { kind: ok|bad|info, text }
let buying = null; // plan key while the payment page is being opened

async function api(path, opts = {}) {
  const token = await idToken();
  const res = await fetch(path, { ...opts, headers: { ...opts.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

async function loadCredits() {
  if (!user) return (credits = undefined);
  try {
    credits = (await api('/api/credits')).credits;
  } catch {
    credits = undefined;
  }
  return credits;
}

async function buy(plan) {
  if (!user) return openDialog();
  buying = plan;
  notice = null;
  render();
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) });
    location.href = url; // Stripe's payment page
  } catch (e) {
    buying = null;
    notice = { kind: 'bad', text: e.message };
    render();
  }
}

// Back from Stripe: the webhook usually lands within seconds; poll until the checks show up.
async function afterPayment() {
  history.replaceState(null, '', '/pricing');
  notice = { kind: 'info', text: 'Payment received. Adding your checks…' };
  render();
  const key = (c) => `${c?.balance}|${c?.unlimitedUntil}`;
  const before = key(credits);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (key(await loadCredits()) !== before && i > 0) break;
  }
  notice = { kind: 'ok', text: "Thanks! Your checks are ready. If they don't show within a few minutes, please contact us." };
  render();
}

function balanceLine() {
  if (!user) return '<p class="price-balance">Log in to see your checks.</p>';
  if (credits === undefined) return '<p class="price-balance">Loading your checks…</p>';
  if (credits === null) return '';
  if (credits.owner) return '<p class="price-balance"><b>Owner</b> · checks are free for you</p>';
  if (credits.unlimitedUntil) return `<p class="price-balance"><b>Unlimited</b> until ${esc(day(credits.unlimitedUntil))}</p>`;
  return `<p class="price-balance"><b>${credits.balance}</b> check${credits.balance === 1 ? '' : 's'} left · next free check ${esc(day(credits.nextFreeAt))}</p>`;
}

function planCard(p) {
  const best = p.key === 'pack25';
  const per = p.checks ? `${euro(Math.round(p.cents / p.checks))} per check` : `${p.days} days · up to ${info.unlimitedPerDay} checks a day`;
  const points = p.checks
    ? [`${p.checks} photo checks`, 'Only used when a date is found', 'Never expire', 'Added on top of your free checks']
    : [`Unlimited checks for ${p.days} days`, `Fair use: ${info.unlimitedPerDay} a day`, 'One payment, no automatic renewal', 'Buying again adds 30 days'];
  const label = !user ? 'Log in to buy' : buying === p.key ? 'Opening payment…' : 'Buy';
  return `<article class="price-card${best ? ' best' : ''}">
    ${best ? '<span class="price-badge">Best value</span>' : ''}
    <h2>${esc(p.checks ? `${p.checks} checks` : 'Unlimited')}</h2>
    <p class="price-amount">${euro(p.cents)}${p.days ? '<small> / 30 days</small>' : ''}</p>
    <p class="price-per">${esc(per)}</p>
    <ul class="price-points">${points.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <button class="btn ${best ? 'btn-primary' : ''} price-buy" data-plan="${p.key}" ${buying || (user && !info.payments) ? 'disabled' : ''}>${esc(label)}</button>
  </article>`;
}

function render() {
  if (!root) return;
  const body = root.querySelector('#pricing');
  if (!info) {
    body.innerHTML = '<p class="hint">Loading prices…</p>';
    return;
  }
  body.innerHTML = `
    <div class="price-intro">
      <h2>Snap labels, get the last-day date</h2>
      <p class="hint">Every check reads a product's use-by or best-before date from your photo. <b>A check is used only when a date is found</b>; blurry photos and non-labels are free.</p>
      ${balanceLine()}
    </div>
    <div class="price-scope">
      <p><b>What you pay for:</b> only the AI features: photo checks in <a href="/follow" data-view-link>Follow your discount</a>
        and questions to the deals assistant (the chat button at the bottom-right). Each runs a paid AI service, and checks cover that cost.
        A question uses a check only when it finds deals.</p>
      <p><b>Everything else is free:</b> Market, Cloth, Electronics and Food Promotions, Favorites and the
        Dashboard are collected automatically by our own crawlers, so there's nothing to charge. No checks,
        and no account needed.</p>
    </div>
    ${notice ? `<p class="price-notice ${notice.kind}" role="status">${esc(notice.text)}</p>` : ''}
    ${user && !info.payments ? '<p class="price-notice info" role="status">Buying checks opens soon. Your free checks work already.</p>' : ''}
    <div class="price-grid">
      <article class="price-card">
        <h2>Free</h2>
        <p class="price-amount">€0</p>
        <p class="price-per">for every account</p>
        <ul class="price-points">
          <li>${info.freeChecks} checks to start</li>
          <li>+${info.weeklyChecks} free check every week</li>
          <li>Unused weekly checks add up</li>
          <li>Calendar view and .ics export to your phone's calendar</li>
        </ul>
        ${user ? '<a class="btn price-buy" href="/follow" data-view-link>Start checking</a>' : '<button class="btn price-buy" data-login>Log in to start</button>'}
      </article>
      ${info.plans.map(planCard).join('')}
    </div>
    <p class="price-trust">Secure payment by Stripe · Prices include VAT · One-time payments, no subscription</p>
    <div class="price-faq">
      <h2>Questions</h2>
      <details><summary>Why do AI checks cost money when the rest is free?</summary><p>Deals are collected once by our crawlers and shared with everyone, so showing them costs almost nothing. Reading a date from your photo, or answering your question about deals, runs a paid AI model for you each time, so those use checks. The free checks each week keep it free for occasional use.</p></details>
      <details><summary>What counts as a check?</summary><p>One photo where we find a use-by or best-before date, or one assistant question that finds deals. If no date is found, the photo isn't a label, the question isn't about deals or finds nothing, or something fails, nothing is used.</p></details>
      <details><summary>Do checks expire?</summary><p>No. Bought checks and saved free checks stay on your account. Unlimited lasts 30 days from purchase; buying it again adds 30 more days.</p></details>
      <details><summary>What does "fair use" mean for Unlimited?</summary><p>Up to ${info.unlimitedPerDay} checks a day, which is far more than a shopping trip needs. It keeps the service affordable for everyone.</p></details>
      <details><summary>Can I get a refund?</summary><p>Checks are added right away, so the 14-day right of withdrawal ends when you buy (you agree to this at checkout). If something went wrong on our side, <a href="/contact" data-view-link>contact us</a> and we'll sort it out.</p></details>
      <details><summary>What do you store about payments?</summary><p>Only what you bought and when. Card details are handled by Stripe and never reach us. See the <a href="/privacy" data-view-link>privacy policy</a>.</p></details>
    </div>`;
}

export function mountPricing(section) {
  root = section;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan], [data-login]');
    if (!b || b.disabled) return;
    if (b.dataset.login !== undefined) openDialog();
    else buy(b.dataset.plan);
  });
  document.addEventListener('ibenefits:auth', async (e) => {
    user = e.detail;
    credits = undefined;
    render();
    if (user && !root.hidden) {
      await loadCredits();
      render();
    }
  });
}

// Called when the page is opened.
export async function showPricing() {
  if (!info) info = await fetch('/api/plans').then((r) => r.json()).catch(() => null);
  const params = new URLSearchParams(location.search);
  if (params.has('canceled')) {
    history.replaceState(null, '', '/pricing');
    notice = { kind: 'info', text: 'Payment cancelled. Nothing was charged.' };
  }
  render();
  if (user) {
    await loadCredits();
    render();
  }
  if (params.has('paid')) afterPayment();
}
