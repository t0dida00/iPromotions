// A date input that always shows dd/mm/yyyy. A native <input type="date"> shows the browser's own
// format (28.10.2026 in Finnish, 10/28/2026 on a US phone), so the visible field is plain text and
// a transparent native date input over the calendar icon opens the device's picker.
// The value for the code is the ISO date (YYYY-MM-DD) in the text input's `data-iso`; empty while
// the typed text isn't a real date. Listeners on the text input's `change` see it already updated.

const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const attr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const toDmy = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.split('-').reverse().join('/') : '');

// "28/10/2026" → "2026-10-28"; null unless it is a real calendar date.
export function toIso(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy ?? '');
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// The field's HTML. `attrs` go on the text input (name, data-act, aria-label…).
export function dateField(iso = '', attrs = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${attr(v)}"`))
    .join('');
  return `<span class="date-field"><input type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/yyyy" maxlength="10" value="${attr(toDmy(iso))}" data-iso="${attr(toDmy(iso) ? iso : '')}"${extra} />${CAL}<input type="date" class="date-native" value="${attr(toDmy(iso) ? iso : '')}" tabindex="-1" aria-hidden="true" /></span>`;
}

// 2810 → 28/10, 28102026 → 28/10/2026, while typing.
function mask(text) {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

function sync(input) {
  const iso = toIso(input.value);
  input.dataset.iso = iso ?? '';
  input.setCustomValidity(iso || (!input.value && !input.required) ? '' : 'Enter a date as dd/mm/yyyy');
  const native = input.parentElement.querySelector('.date-native');
  if (native && iso) native.value = iso;
}

const textOf = (el) => (el instanceof HTMLInputElement && el.type === 'text' && el.parentElement?.classList.contains('date-field') ? el : null);

// Once per page: typing, the picker and validation for every date field, present or future.
let installed = false;
export function installDateFields() {
  if (installed) return;
  installed = true;
  document.addEventListener('input', (e) => {
    const input = textOf(e.target);
    if (!input) return;
    const deleting = e.inputType?.startsWith('delete');
    if (!deleting) input.value = mask(input.value);
    sync(input);
  });
  // Capture: runs before the page's own change listeners, so they read an up-to-date data-iso.
  document.addEventListener('change', (e) => {
    const input = textOf(e.target);
    if (input) return sync(input);
    const native = e.target.closest?.('.date-native');
    if (!native?.value) return;
    const text = native.parentElement.querySelector('input[type="text"]');
    text.value = toDmy(native.value);
    sync(text);
    text.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);
  // Desktop browsers open their picker only from its own icon; ask for it directly when we can.
  document.addEventListener('click', (e) => {
    const native = e.target.closest?.('.date-native');
    if (native?.showPicker) try { native.showPicker(); } catch {}
  });
}
