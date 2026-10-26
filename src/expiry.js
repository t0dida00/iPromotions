import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.js';
import { dbEnabled, ensureDb, query } from './db.js';
import { parseJson } from './analyst.js';

// "Follow your discount": a signed-in user photographs products (markets often discount meat and
// other fresh food on its last day) and a vision model reads the expiry date from each label. The
// dates are kept per Firebase user in the expiry_entries table (with DATABASE_URL), otherwise in
// data/expiry.json; photos are never stored.
//
// Each check is kept small on purpose, so a photo of something else can't run up time or tokens:
// the browser shrinks the photo to ≤ 768 px (~500 image tokens), the reply is capped at 100 tokens,
// and the request is cut off after 8 s. Model: NUXT_HF_VISION_MODEL, through the same Hugging Face
// router and NUXT_HF_TOKEN as the campaign analyst.
const API = 'https://router.huggingface.co/v1/chat/completions';
const MODEL = () => process.env.NUXT_HF_VISION_MODEL || 'Qwen/Qwen3-VL-30B-A3B-Instruct:fastest';
const TIMEOUT_MS = 8000; // the HF provider usually answers in 1–2 s but has slow moments
const FILE = path.join(DATA_DIR, 'expiry.json');
const MAX_ENTRIES = 300; // per user

const SYSTEM = `You read the expiry date on a food package label (usually Finnish). Today is {TODAY}.
Count only:
- use_by: "Viimeinen käyttöpäivä", "Käytettävä viimeistään", "Use by", "Exp", "Sista förbrukningsdag"
- best_before: "Parasta ennen", "Best before", "Bäst före"
Never return packed or made dates: "Pakattu", "Pakkauspäivä", "Valmistettu", "Valmistuspäivä",
"Packed", "Produced", "Prod.". Ignore prices and batch codes.
Dates look like DD.MM.YYYY, DD.MM.YY or DD.MM. (no year: the nearest such date not before today).
If the date is unreadable, or it is not a product label, do not guess.
"label" is the words printed right before the date you chose, copied exactly (e.g. "Parasta ennen").
"product" is the product name exactly as printed on the label (do not translate), or null.
Answer JSON only:
{"found":bool,"label":string|null,"date":"YYYY-MM-DD"|null,"product":string|null,
"reason":null|"not_label"|"no_date"|"packing_date_only"|"unreadable"}`;

// The kind of date is decided here from the printed words, not by the model (small vision models
// mix up use-by and best-before, but copy the words reliably). A date with no recognisable words
// next to it is treated as use-by, the usual case on meat and fish labels.
const KINDS = [
  ['packed', /pakat|pakkaus|valmist|packed|produced|\bprod\b|tillverk/i],
  ['best_before', /parasta|best\s*before|bäst|\bbb\b|bbe/i],
  ['use_by', /viimei|käytettävä|use\s*by|\bexp|förbruk/i],
];
const kindOf = (label) => KINDS.find(([, re]) => re.test(label ?? ''))?.[0] ?? 'use_by';

export const scanEnabled = () => Boolean(process.env.NUXT_HF_TOKEN);

// dataUrl: "data:image/jpeg;base64,…" → { found, kind, date, product, reason, ms, tokens }.
// "reason" explains a miss: not_label, no_date, packing_date_only, unreadable, timeout, invalid_date.
export async function scanLabel(dataUrl) {
  const today = new Date().toISOString().slice(0, 10);
  const started = Date.now();
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.NUXT_HF_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(),
        temperature: 0,
        max_tokens: 100,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM.replace('{TODAY}', today) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'Expiry date?' }] },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return miss('timeout', started);
    throw e;
  }
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const tokens = body.usage?.total_tokens ?? null;
  const a = parseJson(body.choices?.[0]?.message?.content ?? '') ?? {};
  if (!a.found) return miss(a.reason || 'no_date', started, tokens, a.product);
  const kind = kindOf(a.label);
  if (kind === 'packed') return miss('packing_date_only', started, tokens, a.product);
  if (!plausible(a.date, today)) return miss('invalid_date', started, tokens, a.product);
  return { found: true, kind, date: a.date, product: clean(a.product), reason: null, ms: Date.now() - started, tokens };
}

const miss = (reason, started, tokens = null, product = null) => ({
  found: false, kind: null, date: null, product: clean(product), reason, ms: Date.now() - started, tokens,
});
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 60) : null);

// A real calendar date from 30 days ago to ~13 months ahead (anything else is a misread).
function plausible(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d) || d.toISOString().slice(0, 10) !== date) return false;
  const days = (d - new Date(`${today}T00:00:00Z`)) / 86_400_000;
  return days >= -30 && days <= 400;
}

// ── Saved dates, per user ─────────────────────────────────────────────────────────────────────
// With a database each date is its own row, so requests on different server instances can't
// overwrite each other. Without one, everything is in data/expiry.json and writes are chained so
// two requests can't overwrite each other's changes.
let writing = Promise.resolve();
const update = (fn) => (writing = writing.then(async () => {
  const all = await readJson(FILE, {});
  const result = fn(all);
  await writeJson(FILE, all);
  return result;
}));

const byDate = (a, b) => a.date.localeCompare(b.date) || a.addedAt.localeCompare(b.addedAt);

// Rows in the same shape as the file entries (dates as YYYY-MM-DD, no time zone shifts).
const COLUMNS = `id, kind, to_char(date, 'YYYY-MM-DD') as date, product, location,
  to_char(added_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "addedAt"`;
const sql = async (text, params) => (await ensureDb(), (await query(text, params)).rows);

export async function listEntries(uid) {
  if (dbEnabled()) return sql(`select ${COLUMNS} from expiry_entries where firebase_uid = $1 order by date, added_at`, [uid]);
  return ((await readJson(FILE, {}))[uid] ?? []).sort(byDate);
}

// Validates and normalises what the browser sends; null when it isn't a usable entry.
export function entryFrom(body) {
  const today = new Date().toISOString().slice(0, 10);
  if (!['use_by', 'best_before'].includes(body?.kind) || !plausible(body?.date, today)) return null;
  // `location` is typed by the user (which store or shelf); empty clears it.
  return { kind: body.kind, date: body.date, product: clean(body.product) ?? 'Product', location: clean(body.location) };
}

export async function addEntry(uid, entry) {
  if (dbEnabled()) {
    // Make room first: keep the user's newest MAX_ENTRIES - 1 dates (drops the oldest date).
    await sql(
      `delete from expiry_entries where id in (
         select id from expiry_entries where firebase_uid = $1 order by date desc, added_at desc offset $2)`,
      [uid, MAX_ENTRIES - 1],
    );
    const [saved] = await sql(
      `insert into expiry_entries (id, firebase_uid, kind, date, product, location)
       values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
      [crypto.randomUUID(), uid, entry.kind, entry.date, entry.product, entry.location ?? null],
    );
    return saved;
  }
  return update((all) => {
    const list = (all[uid] ??= []);
    if (list.length >= MAX_ENTRIES) list.sort(byDate).shift(); // drop the oldest date
    const saved = { id: crypto.randomUUID(), ...entry, addedAt: new Date().toISOString() };
    list.push(saved);
    return saved;
  });
}

export async function changeEntry(uid, id, changes) {
  if (dbEnabled()) {
    const [e] = await sql(
      `update expiry_entries set kind = $3, date = $4, product = $5, location = $6
       where firebase_uid = $1 and id = $2 returning ${COLUMNS}`,
      [uid, id, changes.kind, changes.date, changes.product, changes.location ?? null],
    );
    return e ?? null;
  }
  return update((all) => {
    const e = (all[uid] ?? []).find((x) => x.id === id);
    if (e) Object.assign(e, changes);
    return e ?? null;
  });
}

export async function removeEntry(uid, id) {
  if (dbEnabled()) return (await sql('delete from expiry_entries where firebase_uid = $1 and id = $2 returning id', [uid, id])).length > 0;
  return update((all) => {
    const list = all[uid] ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return i >= 0;
  });
}

// One-off (scripts/import-data.js): copies { uid: [entries] } from an old expiry.json into the table.
// Entries already there are kept.
export async function importEntries(all) {
  let n = 0;
  for (const [uid, list] of Object.entries(all ?? {}))
    for (const e of list) {
      await sql(
        `insert into expiry_entries (id, firebase_uid, kind, date, product, location, added_at)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
        [e.id, uid, e.kind, e.date, e.product ?? 'Product', e.location ?? null, e.addedAt ?? new Date().toISOString()],
      );
      n++;
    }
  return n;
}
