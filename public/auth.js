// Sign in with Google through Firebase Authentication. The sidebar shows a Login button that opens
// #login-dialog, or the signed-in user's avatar, which opens #profile-dialog. Firebase keeps the session in the
// browser; the project settings come from the server (GET /api/auth-config, filled from .env), and
// the SDK is only downloaded when they are set.
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.19.0';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const GOOGLE_G =
  '<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-3.9 7-9.8 7-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.7 10.8l7.8-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.1 1.4-4.9 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';

// Firebase errors worth showing; anything else gets a generic message.
const ERRORS = {
  'auth/popup-blocked': 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  'auth/unauthorized-domain': 'This address is not an authorized domain in the Firebase project.',
  'auth/network-request-failed': 'Could not reach Google. Check your connection and try again.',
};

let fb = null; // { auth, signInWithPopup, GoogleAuthProvider, signOut } once Firebase is loaded

// The user's photo, or their initial when Google has no photo.
const avatar = (user) =>
  user.photoURL
    ? `<img class="avatar" src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="avatar" aria-hidden="true">${esc((user.displayName || user.email || '?')[0].toUpperCase())}</span>`;

// The signed-in user's Firebase ID token, for `Authorization: Bearer …` (null when signed out).
export async function idToken() {
  return (await fb?.auth.currentUser?.getIdToken()) ?? null;
}

// What the server knows about the signed-in user: { signedIn, owner, accounts, user: { role } }.
// GET /api/me also saves the user in the database. Owner-only controls (Refresh buttons) show only
// for the owner; the server checks the role again on every refresh, so this is just display.
// app.js listens for 'ipromotion:account' to switch favorites between the browser and the account.
let me = { signedIn: false, owner: false, accounts: false };

async function checkAccount(user) {
  me = { signedIn: false, owner: false, accounts: false };
  if (user) {
    try {
      const res = await fetch('/api/me', { headers: { authorization: `Bearer ${await user.getIdToken()}` } });
      if (res.ok) me = await res.json();
    } catch {}
  }
  document.documentElement.classList.toggle('is-owner', me.owner === true);
  document.dispatchEvent(new CustomEvent('ipromotion:account', { detail: { ...me, uid: user?.uid ?? null } }));
}

function renderAccount(user) {
  checkAccount(user);
  const box = $('account');
  if (user) {
    // Avatar with the first name beside it (the collapsed sidebar shows only the avatar).
    const name = user.displayName || user.email;
    box.innerHTML = `<button class="avatar-btn" id="avatar" aria-label="Account: ${esc(name)}" title="${esc(name)}">
      ${avatar(user)}
      <span class="account-text"><span class="account-name">${esc(user.displayName?.trim().split(/\s+/)[0] || name)}</span></span>
      <svg class="account-more" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4-4 4 4M8 14l4 4 4-4"/></svg>
    </button>`;
    $('avatar').addEventListener('click', () => openProfile(user));
  } else {
    $('profile-dialog').close();
    box.innerHTML = '<button class="btn login-btn" id="login">Login</button>';
    $('login').addEventListener('click', openDialog);
  }
  box.hidden = false;
  // Sections that depend on the user (Follow your discount) listen for this.
  document.dispatchEvent(new CustomEvent('ibenefits:auth', { detail: user ?? null }));
}

export function openDialog() {
  $('login-google').innerHTML = `<button class="btn google-btn" id="google-signin" ${fb ? '' : 'disabled'}>${GOOGLE_G}<span>Sign in with Google</span></button>
    <p class="login-note" id="login-note" ${fb ? 'hidden' : ''}>Google sign-in is not configured on this server yet.</p>`;
  $('google-signin').addEventListener('click', signIn);
  $('login-dialog').showModal();
}

async function signIn() {
  const btn = $('google-signin');
  const note = $('login-note');
  btn.disabled = true;
  note.hidden = true;
  try {
    await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider());
    $('login-dialog').close(); // the sidebar updates through onAuthStateChanged
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error('[auth]', err);
      note.textContent = ERRORS[err.code] ?? 'Sign-in failed, please try again.';
      note.hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Profile dialog: avatar, name, email, location and potential postcode ─────────────────────
// The location is estimated from the browser's position (asked only when the user clicks
// "Detect my location"), turned into a place name and postcode with OpenStreetMap's Nominatim, and
// remembered in this browser per user.
const locationKey = (user) => `ibenefits.location.${user.uid}`;

function savedLocation(user) {
  try {
    return JSON.parse(localStorage.getItem(locationKey(user)));
  } catch {
    return null;
  }
}

function saveLocation(user, loc) {
  try {
    localStorage.setItem(locationKey(user), JSON.stringify(loc));
  } catch {
    // Private mode or blocked storage: the location just isn't remembered.
  }
}

function openProfile(user) {
  renderProfile(user);
  $('profile-dialog').showModal();
}

function renderProfile(user, { busy = false, error = '' } = {}) {
  const loc = savedLocation(user);
  $('profile').innerHTML = `${avatar(user)}
    <h2 id="profile-name">${esc(user.displayName ?? 'Your account')}</h2>
    <p class="sub">${esc(user.email)}</p>
    <dl class="profile-facts">
      <dt>Role</dt>
      <dd>${me.user?.role === 'owner' ? 'Owner' : 'User'}</dd>
      <dt>Location</dt>
      <dd>${loc?.place ? esc(loc.place) : '<span class="muted">Not set</span>'}</dd>
      <dt>Potential postcode</dt>
      <dd>${loc?.postcode ? `${esc(loc.postcode)}<small>estimated from your location</small>` : '<span class="muted">Unknown</span>'}</dd>
    </dl>
    ${error ? `<p class="login-note">${esc(error)}</p>` : ''}
    <div class="profile-actions">
      <button class="btn" id="detect-location" ${busy ? 'disabled' : ''}>${busy ? 'Detecting…' : loc ? 'Update my location' : 'Detect my location'}</button>
      <button class="btn" id="logout">Sign out</button>
    </div>`;
  $('detect-location').addEventListener('click', () => detectLocation(user));
  $('logout').addEventListener('click', () => fb.signOut(fb.auth));
}

const GEO_ERRORS = {
  1: 'Location permission was denied. Allow it in the browser to detect your postcode.',
  2: 'Your position is not available right now.',
  3: 'Finding your position took too long. Please try again.',
};

async function detectLocation(user) {
  if (!navigator.geolocation) return renderProfile(user, { error: 'This browser cannot share its location.' });
  renderProfile(user, { busy: true });
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15_000, maximumAge: 10 * 60_000 }),
    );
    const { latitude, longitude } = pos.coords;
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=en&lat=${latitude}&lon=${longitude}`,
    );
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const { address = {} } = await res.json();
    const area = address.suburb ?? address.quarter ?? address.neighbourhood ?? address.city_district;
    const city = address.city ?? address.town ?? address.village ?? address.municipality;
    const place = [area, city].filter(Boolean).join(', ') || address.country || null;
    saveLocation(user, { place, postcode: address.postcode ?? null, at: new Date().toISOString() });
    renderProfile(user);
  } catch (err) {
    console.error('[auth] location', err);
    renderProfile(user, { error: GEO_ERRORS[err.code] ?? 'Could not look up your location. Please try again.' });
  }
}

// Close a dialog by clicking the backdrop (not the dialog's own padding).
for (const dialog of [$('login-dialog'), $('profile-dialog')])
  dialog.addEventListener('click', (e) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close();
  });

export async function initAuth() {
  const { firebase } = await fetch('/api/auth-config').then((r) => r.json()).catch(() => ({}));
  if (!firebase) return renderAccount(null); // not configured: Login opens a dialog explaining that
  try {
    const [{ initializeApp }, authLib] = await Promise.all([import(`${FIREBASE}/firebase-app.js`), import(`${FIREBASE}/firebase-auth.js`)]);
    const auth = authLib.getAuth(initializeApp(firebase));
    fb = { auth, signInWithPopup: authLib.signInWithPopup, GoogleAuthProvider: authLib.GoogleAuthProvider, signOut: authLib.signOut };
    authLib.onAuthStateChanged(auth, renderAccount); // also fires once with the restored session
  } catch (err) {
    console.error('[auth] Could not load Firebase:', err);
    renderAccount(null);
  }
}
