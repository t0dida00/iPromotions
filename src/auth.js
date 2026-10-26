import crypto from 'node:crypto';
import express from 'express';
import { dbEnabled, upsertUser, getUserByUid } from './db.js';

// Sign in with Google runs in the browser with Firebase Authentication (public/auth.js). The server
// only hands out the Firebase web app settings, which are public by design (they identify the
// project; access is controlled by Firebase's authorized domains). Set in .env, from Firebase
// console → Project settings → Your apps → Web app:
//   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_APP_ID
const firebaseConfig = () =>
  process.env.FIREBASE_API_KEY && process.env.FIREBASE_AUTH_DOMAIN && process.env.FIREBASE_PROJECT_ID
    ? {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        appId: process.env.FIREBASE_APP_ID || undefined,
      }
    : null;

export const authRouter = express.Router();

authRouter.get('/api/auth-config', (_req, res) => res.json({ firebase: firebaseConfig() }));

// ── Who is calling: Firebase ID tokens ──────────────────────────────────────────────────────────
// The browser sends the signed-in user's Firebase ID token as `Authorization: Bearer <token>`. It
// is a JWT signed by Google; we check the signature against Google's published certificates and the
// standard claims (https://firebase.google.com/docs/auth/admin/verify-id-tokens), so a visitor can't
// just claim to be someone else. No firebase-admin needed: only FIREBASE_PROJECT_ID.
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = { keys: {}, expires: 0 };

async function googleCerts(force = false) {
  if (!force && Date.now() < certs.expires) return certs.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google certificates ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  certs = { keys: await res.json(), expires: Date.now() + maxAge * 1000 };
  return certs.keys;
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// The token's claims if it is a valid, unexpired ID token for this project; otherwise throws.
export async function verifyIdToken(token) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('Sign-in is not configured');
  const [h, p, sig] = String(token).split('.');
  if (!sig) throw new Error('Malformed token');
  const header = decode(h);
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  // A new signing key appears now and then; refetch once if the kid is unknown.
  const pem = (await googleCerts())[header.kid] ?? (await googleCerts(true))[header.kid];
  if (!pem) throw new Error('Unknown signing key');
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), new crypto.X509Certificate(pem).publicKey, Buffer.from(sig, 'base64url'));
  if (!valid) throw new Error('Bad signature');
  const claims = decode(p);
  const now = Date.now() / 1000;
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Token is for another project');
  if (!(claims.exp > now) || !(claims.iat <= now + 300) || !claims.sub) throw new Error('Token expired or invalid');
  return claims;
}

// Role rule: the account whose Google-verified email is OWNER_EMAIL is the one owner, everyone else
// a user. With a database the role is stored on the user row (src/db.js applies the same rule);
// without one (or while it's unreachable) it is worked out from the token, so the owner can still
// refresh.
// Without OWNER_EMAIL nobody is owner (no default address, so none is published in the code).
const ownerEmail = () => (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
const roleFromClaims = (claims) =>
  claims?.email_verified && ownerEmail() && String(claims.email ?? '').toLowerCase() === ownerEmail() ? 'owner' : 'user';

// The signed-in user: { uid, email, name, role, id } where id is the users-table row (null when
// there is no database). Created in the table on first sight.
async function userOf(claims) {
  const base = { uid: claims.sub, email: claims.email ?? null, name: claims.name ?? null, role: roleFromClaims(claims), id: null };
  if (!dbEnabled()) return base;
  try {
    const row = (await getUserByUid(claims.sub)) ?? (await upsertUser(claims));
    return { ...base, id: row.id, name: row.name, role: row.role };
  } catch (e) {
    console.error('[auth] database unavailable, using token details:', e.message);
    return base;
  }
}

// The caller's verified claims, or null when there is no (valid) token.
export async function callerOf(req) {
  const token = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    return await verifyIdToken(token);
  } catch (e) {
    console.warn(`[auth] rejected token from ${req.ip}: ${e.message}`);
    return null;
  }
}

// Route guard: 401 when not signed in; otherwise req.user = { uid, email, name, role, id }.
export async function requireUser(req, res, next) {
  const claims = await callerOf(req);
  if (!claims) return res.status(401).json({ error: 'Please log in first.', auth: 'required' });
  req.user = await userOf(claims);
  next();
}

// Route guard: like requireUser, plus 403 unless the user's role is owner.
export function requireOwner(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can refresh.', auth: 'forbidden' });
    next();
  });
}

// Called by the page after sign-in: saves the user (name, photo, last login, role) and says whether
// to show owner-only controls. The server still checks the role on every refresh.
authRouter.get('/api/me', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const claims = await callerOf(req);
  if (!claims) return res.json({ signedIn: false, owner: false, accounts: dbEnabled() });
  let user;
  try {
    user = dbEnabled() ? { ...(await upsertUser(claims)), uid: claims.sub } : await userOf(claims);
  } catch (e) {
    console.error('[auth] could not save user:', e.message);
    user = await userOf(claims); // still answer with the role from the token
  }
  res.json({ signedIn: true, owner: user.role === 'owner', accounts: dbEnabled() && user.id != null, user: { name: user.name, email: user.email, role: user.role } });
});
