// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Toasts: short glass notes bottom-right. At most three on screen; errors use a red dot
// and are also announced assertively.

import { $, h } from './dom.js';

const MAX = 3;
const LIFE = 2600;
const LIFE_ERROR = 4600;

let reduced = () => false;
export function initToasts(isReduced) { reduced = isReduced; }

export function toast(text, opts = {}) {
  const box = $('#toasts');
  if (!box || text == null || text === '') return;
  const msg = String(text);
  const error = opts.kind === 'error';

  // same text already showing: just refresh it
  for (const t of box.children) {
    if (t.dataset.msg === msg && !t.classList.contains('leaving')) { schedule(t, error); return; }
  }

  // errors are announced through #announce (role=alert), so hide them from the polite region
  const el = h('div.toast', { 'data-msg': msg, class: error ? 'error' : null, 'aria-hidden': error ? 'true' : null },h('i', { 'aria-hidden': 'true' }), h('span', null, msg));
  box.append(el);
  while (box.children.length > MAX) box.firstElementChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  if (error) {
    const a = $('#announce');
    if (a) { a.textContent = ''; setTimeout(() => { a.textContent = msg; }, 30); }
  }
  schedule(el, error);
}

function schedule(el, error) {
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.add('leaving');
    el.classList.remove('show');
    setTimeout(() => el.remove(), reduced() ? 0 : 380);
  }, error ? LIFE_ERROR : LIFE);
}
