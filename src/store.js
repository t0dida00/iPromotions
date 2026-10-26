import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

// Data lives in small JSON files, one per sidebar section, so a page only downloads the section
// it shows:
//   data/status.json             store status, refresh history, per-section update times
//   data/deals-<segment>.json    { updatedAt, deals } for groceries / clothing / electronics
export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const LEGACY_FILE = path.join(DATA_DIR, 'deals.json'); // single-file format used before
export const segmentFile = (segment) => path.join(DATA_DIR, `deals-${segment}.json`);

export const segmentOf = (key) => config.sources[key]?.segment ?? 'groceries';
export const SEGMENTS = [...new Set(Object.keys(config.sources).map(segmentOf))];

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename it into place, so a crash mid-write never leaves a half file.
export async function writeJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export const readStatus = () => readJson(STATUS_FILE, { updatedAt: null, sources: {}, runs: [], segments: {} });
export const writeStatus = (status) => writeJson(STATUS_FILE, status);
export const readSegment = (segment) => readJson(segmentFile(segment), { updatedAt: null, deals: [] });
export const writeSegment = (segment, deals, updatedAt) => writeJson(segmentFile(segment), { updatedAt, deals });

// One-time move from the old single data/deals.json to per-section files. The old file is kept
// as deals.json.bak.
export async function migrateLegacy() {
  const legacy = await readJson(LEGACY_FILE, null);
  if (!legacy || (await readJson(STATUS_FILE, null))) return false;
  const bySegment = Object.fromEntries(SEGMENTS.map((s) => [s, []]));
  for (const d of legacy.deals ?? []) (bySegment[d.segment ?? segmentOf(d.source)] ??= []).push(d);
  const segments = {};
  for (const [seg, deals] of Object.entries(bySegment)) {
    await writeSegment(seg, deals, legacy.updatedAt);
    segments[seg] = legacy.updatedAt;
  }
  const sources = Object.fromEntries(
    Object.entries(legacy.sources ?? {}).map(([k, s]) => [k, { ...s, ...summarize(legacy.deals.filter((d) => d.source === k)) }]),
  );
  await writeStatus({ updatedAt: legacy.updatedAt, sources, runs: legacy.runs ?? [], segments });
  await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.bak`);
  return true;
}

// Per-store numbers kept in status.json so the dashboard needs no deal files.
export function summarize(deals) {
  const pcts = deals.map((d) => d.discountPct).filter((p) => p > 0);
  return {
    count: deals.length,
    avgDiscount: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
  };
}
