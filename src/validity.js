// When a deal stops being valid. Stores give either a timestamp or just a day ("2026-10-27", Prisma);
// a bare day means "until the end of that day" in Finland, not midnight UTC (which hid deals that
// were still on sale in the morning).
const OFFSET = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Helsinki', timeZoneName: 'longOffset' });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// "2026-10-27" → "2026-10-27T20:59:59.000Z" (23:59:59 Helsinki time, summer or winter).
export function endOfDay(date) {
  const zone = OFFSET.formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value;
  return new Date(`${date}T23:59:59${zone.replace('GMT', '') || 'Z'}`).toISOString();
}

// A crawler's validUntil as stored: bare days become the end of that day, the rest stays as is.
export const normalizeValidUntil = (v) => (typeof v === 'string' && DAY.test(v) ? endOfDay(v) : v ?? null);

// Still on sale? Deals without an end date (many stores don't give one) count as live.
export function isLive(deal, now = Date.now()) {
  const v = deal.validUntil;
  if (!v) return true;
  const t = Date.parse(DAY.test(v) ? endOfDay(v) : v);
  return Number.isNaN(t) || t >= now;
}
