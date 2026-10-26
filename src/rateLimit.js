// Per-IP rate limiting (fixed window, in memory) so bots can't spam the API or the refresh
// endpoint. Each limiter counts requests per client IP; over the limit the reply is
// `429 Too Many Requests` with `Retry-After`. Counts reset when the server restarts.
//
// `shared: true` keeps the counts in the database instead (src/db.js `hit`), so every server
// instance sees the same numbers — on Vercel many instances run at once. Used for the limits that
// guard costly work; falls back to memory without DATABASE_URL or if the database fails.
//
// Behind a reverse proxy (nginx, Cloudflare…) set `app.set('trust proxy', 1)` so req.ip is the
// visitor's address, not the proxy's.
import { dbEnabled, hit } from './db.js';

export function rateLimit({ name, windowMs, max, shared = false, message = 'Too many requests, please slow down.' }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Forget finished windows now and then so the map doesn't grow forever.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  const count = async (ip, now) => {
    if (shared && dbEnabled()) {
      try {
        return await hit(`${name}:${ip}`, windowMs);
      } catch (e) {
        console.error(`[rate-limit] ${name}: database unavailable, counting in memory:`, e.message);
      }
    }
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) hits.set(ip, (h = { count: 0, resetAt: now + windowMs }));
    h.count++;
    return h;
  };

  return async (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const h = await count(ip, now);

    const retryAfter = Math.ceil((h.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - h.count));
    res.setHeader('RateLimit-Reset', retryAfter);
    if (h.count <= max) return next();

    if (h.count === max + 1) console.warn(`[rate-limit] ${name}: ${ip} exceeded ${max} requests / ${windowMs / 1000}s`);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({ error: message, rateLimited: true, retryAfterSeconds: retryAfter });
  };
}
