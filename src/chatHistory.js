import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, readJson, writeJson, removeJson, purgeExpired } from './store.js';

// Deals assistant conversations, one JSON file per user: data/chat-<hash of uid>.json locally, a
// kv row of the same name online (src/store.js). A conversation is deleted 24 hours after it
// started (`expiresAt`, not moved by new messages), or earlier when the user types /clear or asks
// to clear it. Expired files are removed when read and by a sweep every few minutes.

const TTL_MS = 24 * 60 * 60_000;
const MAX_MESSAGES = 60; // oldest dropped first
const PREFIX = 'chat-';
const SWEEP_MS = 10 * 60_000;
let sweptAt = 0;

// The uid isn't written into the file name, only a hash of it.
const fileOf = (uid) => path.join(DATA_DIR, `${PREFIX}${crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 32)}.json`);
const live = (h) => h && Date.parse(h.expiresAt) > Date.now();

// Delete other users' expired conversations now and then (cheap: one query or one directory read).
function sweep() {
  if (Date.now() - sweptAt < SWEEP_MS) return;
  sweptAt = Date.now();
  purgeExpired(PREFIX).catch((e) => console.error('[chat] history sweep:', e.message));
}

// → { messages, context, expiresAt } (empty when there is none or it expired).
export async function getHistory(uid) {
  sweep();
  const h = await readJson(fileOf(uid), null);
  if (live(h)) return { messages: h.messages, context: h.context ?? null, expiresAt: h.expiresAt };
  if (h) await removeJson(fileOf(uid)).catch(() => {});
  return { messages: [], context: null, expiresAt: null };
}

// Appends one question and its answer; starts a new 24-hour conversation when there is none.
export async function appendExchange(uid, question, reply) {
  const file = fileOf(uid);
  const old = await readJson(file, null);
  const now = new Date();
  const h = live(old) ? old : { createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString(), messages: [] };
  const { context, credits, ...data } = reply;
  h.messages.push({ role: 'user', text: question, at: now.toISOString() }, { role: 'bot', text: reply.answer, data, at: now.toISOString() });
  h.messages = h.messages.slice(-MAX_MESSAGES);
  h.context = context ?? h.context ?? null;
  await writeJson(file, h);
}

export const clearHistory = (uid) => removeJson(fileOf(uid));

// "/new": forget the remembered search (follow-ups start from scratch) but keep the messages.
export async function resetContext(uid) {
  const h = await readJson(fileOf(uid), null);
  if (live(h) && h.context) await writeJson(fileOf(uid), { ...h, context: null });
}

// The user's last questions, for the model to read follow-ups ("and there?") in context.
export const recentQuestions = (history, n = 2) => history.messages.filter((m) => m.role === 'user').slice(-n).map((m) => m.text);

// "/clear", "clear the chat", "delete my history", "tyhjennä keskustelu"… (the whole message).
const CLEAR = /^\s*(\/clear|(please\s+)?(clear|delete|reset|erase|remove|forget)(\s+(the|my|this|our))?\s+(chat|conversation|history|messages)(\s+history)?(\s+please)?|tyhjennä(\s+(keskustelu|historia|chatti))?|poista\s+(keskustelu|historia))\s*[.!]?\s*$/i;
export const isClearCommand = (text) => typeof text === 'string' && CLEAR.test(text);

// "/new", "new search", "start over", "uusi haku" (the whole message).
const NEW = /^\s*(\/new|(a\s+)?new\s+search|start\s+(over|again)|uusi\s+haku|aloita\s+alusta)\s*[.!]?\s*$/i;
export const isNewSearchCommand = (text) => typeof text === 'string' && NEW.test(text);
