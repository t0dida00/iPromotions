// Plain-language versions of technical messages shown in the UI: crawler errors and cron schedules.

// Crawler errors come from the crawlers' own `throw`s and from Playwright/fetch. Match the common
// kinds; the raw text stays available to owners as "Technical details".
const ERRORS = [
  [/timeout|timed out/i, "The store's website took too long to respond. It may be slow or down at the moment."],
  [/\b(403|429)\b|access denied|bot check|captcha/i, "The store's website turned our visit away (it limits automated visitors)."],
  [/\b5\d\d\b/, "The store's website had a problem on its side."],
  [/\b404\b/, 'A page we read on the store\'s website no longer exists, so the crawler needs an update.'],
  [/layout|not seen|not found|no \w+( \w+)? found|did not stick|not the expected|did not accept/i, "The store's website has changed, so we couldn't read its deals. The crawler needs an update."],
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket/i, "We couldn't reach the store's website (a network problem)."],
  [/hugging face|campaign analyst|model reply/i, "The AI that summarizes campaigns didn't answer."],
];

export function friendlyError(raw) {
  const hit = ERRORS.find(([re]) => re.test(raw ?? ''));
  return hit ? hit[1] : "Something went wrong while reading this store's deals.";
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// "0 6 * * 3" → "Every Wednesday at 06:00". Handles the usual "minute hour * * days" shapes
// (lists, ranges, *); anything fancier falls back to "On a custom schedule".
export function describeCron(expr) {
  const [min, hour, dom, mon, dow] = String(expr ?? '').trim().split(/\s+/);
  if (!/^\d+$/.test(min ?? '') || !/^\d+$/.test(hour ?? '') || dom !== '*' || mon !== '*' || dow == null) return 'On a custom schedule';
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dow === '*') return `Every day at ${time}`;
  const days = new Set();
  for (const part of dow.split(',')) {
    const [a, b = a] = part.split('-').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return 'On a custom schedule';
    for (let d = a; d <= b; d++) days.add(d % 7);
  }
  const sorted = [...days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)); // Monday first
  if (sorted.length === 5 && !days.has(0) && !days.has(6)) return `Every weekday at ${time}`;
  return `Every ${list(sorted.map((d) => DAYS[d]))} at ${time}`;
}
