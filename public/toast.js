// Short message at the bottom of the screen, optionally with one action button ("Undo"). One at a
// time: a new toast replaces the old one. While a modal <dialog> is open the rest of the page can't
// be clicked, so the toast goes inside that dialog instead.
export function toast(text, { action, onAction, ms = 4000 } = {}) {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: 'toast' });
  t.setAttribute('role', 'status');
  t.append(text);
  let timer;
  const close = () => (clearTimeout(timer), t.remove());
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-action', textContent: action });
    b.addEventListener('click', () => (close(), onAction?.()));
    t.append(b);
  }
  (document.querySelector('dialog[open]') ?? document.body).append(t);
  timer = setTimeout(close, ms);
  return close;
}
