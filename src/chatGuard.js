import config from '../config.js';

// Security check for the deals assistant (POST /api/chat), run on every question before anything
// else: no model call, no credit and no search happens for a question that fails here.
//
// The assistant only searches our own deal data, the model has no tools and its output is never
// executed, so the risks are prompt injection (making the model ignore its instructions or reveal
// them) and abuse (code, huge inputs, using it as a free general chatbot). Rejected questions get
// one friendly message; which rule fired is not told to the user.

const MAX = config.chat?.maxChars ?? 300;

// Code, markup and command syntax. Nobody needs these to ask about deals.
export const CODE = [
  /```|`[^`]*`/, // code blocks / inline code
  /<\s*\/?\s*[a-z!?][^>]*>/i, // HTML / XML tags
  /\b(java|vb)script\s*:/i,
  /\{\{|\}\}|\$\{/, // template syntax
  /\b(eval|require|exec|spawn|fetch|setTimeout|Function)\s*\(/i,
  /\bimport\s+[\w{*]/i,
  /\bunion\s+(all\s+)?select\b|;\s*(drop|delete|insert|update|alter|truncate)\b/i,
  /--\s*$|\/\*|\*\//, // SQL comments
  /\$\(|&&|\|\||\brm\s+-|\bsudo\b|\bcurl\s+|\bwget\s+|\.\.\/|\\x[0-9a-f]{2}/i,
  /[;|]\s*\w+\s+-\w/, // "; cmd -flag", "| cmd -flag"
];

// Attempts to change the assistant's rules or get at secrets (English and Finnish).
export const INJECTION = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|above|earlier|prior|all|your|the)\b.{0,30}\b(instructions?|rules?|prompts?|messages?|guidelines?)/i,
  /\b(system|developer|hidden|initial|original)\s+(prompt|message|instructions?)\b/i,
  /\b(reveal|show|print|repeat|output|leak|tell me)\b.{0,30}\b(instructions?|prompt|rules|configuration|config|secrets?)\b/i,
  /\b(developer|god|admin|debug|dan)\s+mode\b|\bjailbreak|\bprompt\s*injection/i,
  /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+(to\s+be|you)\b|\brole\s*-?\s*play\b|\bfrom\s+now\s+on\b/i,
  /\b(api|secret|access|private)[\s_-]*keys?\b|\b(auth|bearer|access|id)[\s_-]*tokens?\b|\bpasswords?\b|\bcredentials?\b|\.env\b|\benv(ironment)?\s+var/i,
  /\b(your\s+)?(database|sql\s+quer(y|ies)|source\s+code|backend|admin\s+panel|other\s+users?|user\s+emails?)\b/i,
  /\b(unohda|ohita)\b.{0,30}\b(ohjeet|ohjeesi|säännöt)\b|\bjärjestelmäkehote\b|\bsalasana/i,
];

// Clearly not about shopping. Answered with a short refusal, without calling the model (the model
// still refuses anything else that is off-topic).
export const OFF_TOPIC = [
  /\b(weather|forecast)\b|\bsää(tä|ennuste)?\b/i, // not \"snow\" or \"rain\": snow boots, rain jackets
  /\bwhat\s+(time|day|date)\s+is\s+it\b|\bcurrent\s+(time|date)\b|\bkello\s+on\b|\bmikä\s+päivä\b/i,
  /\b(news|politics|election|president|prime\s+minister|war)\b|\buutiset\b/i,
  /\b(joke|poem|story|song|essay|homework|translate)\b|\bvitsi\b/i,
  /\b(write|debug|fix)\b.{0,20}\b(code|program|script|function)\b|\b(python|javascript|java|c\+\+|html|css)\b/i,
  /\b(who\s+are\s+you|what\s+model|which\s+(llm|model)|are\s+you\s+(gpt|chatgpt|claude|human))\b/i,
  /^\s*[\d\s+\-*/().^=]+\s*$/, // bare arithmetic
  /\b(calculate|solve)\b.{0,20}\d/i,
];

export const MESSAGES = {
  type: 'Please type a question about deals.',
  short: 'Please ask a little more, e.g. "discounted meat" or "what is on sale at Lidl?".',
  long: `Please keep your question under ${MAX} characters.`,
  blocked: 'I can only help find deals and promotions. Please ask about products, prices or stores.',
  offTopic: 'I can only help with deals and promotions in our stores, e.g. "drinks on sale" or "where can I get a discounted burger?".',
};

// NFKC folds look-alike characters (full-width letters, ligatures) so the patterns see plain text.
const clean = (s) =>
  s
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '') // control characters
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '') // zero-width and direction marks
    .replace(/\s+/g, ' ')
    .trim();

// → { ok: true, text } or { ok: false, reason, error } (reason is for logs, error for the user).
export function guard(message) {
  if (typeof message !== 'string') return { ok: false, reason: 'type', error: MESSAGES.type };
  if (message.length > MAX * 2) return { ok: false, reason: 'long', error: MESSAGES.long }; // before any work
  const text = clean(message);
  if (text.length < 2) return { ok: false, reason: 'short', error: MESSAGES.short };
  if (text.length > MAX) return { ok: false, reason: 'long', error: MESSAGES.long };
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 2 || letters / text.replace(/\s/g, '').length < 0.5) return { ok: false, reason: 'symbols', error: MESSAGES.blocked };
  if (CODE.some((r) => r.test(text))) return { ok: false, reason: 'code', error: MESSAGES.blocked };
  if (INJECTION.some((r) => r.test(text))) return { ok: false, reason: 'injection', error: MESSAGES.blocked };
  if (OFF_TOPIC.some((r) => r.test(text))) return { ok: false, reason: 'off-topic', error: MESSAGES.offTopic };
  return { ok: true, text };
}
