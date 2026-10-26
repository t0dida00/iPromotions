// Per-IP rate limiting (fixed window, in memory) so bots can't spam the API or the refresh
// endpoint. Each limiter counts requests per client IP; over the limit the reply is
// `429 Too Many Requests` with `Retry-After`. Counts reset when the server restarts.
//
// Behind a reverse proxy (nginx, Cloudflare…) set `app.set('trust proxy', 1)` so req.ip is the
// visitor's address, not the proxy's.
export function rateLimit({ name, windowMs, max, message = 'Too many requests, please slow down.' }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Forget finished windows now and then so the map doesn't grow forever.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) hits.set(ip, (h = { count: 0, resetAt: now + windowMs }));
    h.count++;

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
