import express from 'express';
import { requireUser } from './auth.js';
import { dbEnabled, listFavorites, addFavorite, removeFavorite, mergeFavorites } from './db.js';
import { SEGMENTS } from './store.js';

// Favorite categories of the signed-in user (logged-out visitors keep theirs in the browser).
//   GET    /api/favorites                       → { groceries: ['Bread & bakery'], … }
//   PUT    /api/favorites/:segment/:category    → star one
//   DELETE /api/favorites/:segment/:category    → unstar one
//   POST   /api/favorites/merge  { segment: [categories] } → add the browser's stars at sign-in
export const favoritesRouter = express.Router();

const MAX_LEN = 80; // category names are short ("Clothing & shoes")
const MAX_MERGE = 300;
const validSegment = (s) => SEGMENTS.includes(s);
const validCategory = (c) => typeof c === 'string' && c.trim().length > 0 && c.length <= MAX_LEN;

favoritesRouter.use(
  '/api/favorites',
  (req, res, next) => {
    if (!dbEnabled()) return res.status(503).json({ error: 'Accounts are not set up on this server, so favorites stay in your browser.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  requireUser,
  (req, res, next) => (req.user.id == null ? res.status(503).json({ error: "Couldn't reach your saved favorites right now. Please try again in a moment." }) : next()),
);

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error('[favorites]', e.message);
    res.status(503).json({ error: "Couldn't save your favorites right now. Please try again in a moment." });
  }
};

favoritesRouter.get('/api/favorites', handle(async (req, res) => res.json(await listFavorites(req.user.id))));

for (const method of ['put', 'delete'])
  favoritesRouter[method]('/api/favorites/:segment/:category', handle(async (req, res) => {
    const { segment, category } = req.params;
    if (!validSegment(segment) || !validCategory(category)) return res.status(400).json({ error: 'Unknown section or category.' });
    await (method === 'put' ? addFavorite : removeFavorite)(req.user.id, segment, category);
    res.json(await listFavorites(req.user.id));
  }));

favoritesRouter.post('/api/favorites/merge', express.json({ limit: '32kb' }), handle(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const map = {};
  let n = 0;
  for (const [segment, cats] of Object.entries(body)) {
    if (!validSegment(segment) || !Array.isArray(cats)) continue;
    map[segment] = [...new Set(cats.filter(validCategory))];
    n += map[segment].length;
  }
  if (n > MAX_MERGE) return res.status(400).json({ error: 'Too many favorites.' });
  res.json(await mergeFavorites(req.user.id, map));
}));
