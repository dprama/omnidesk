// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// The command bar (Ctrl+K / Cmd+K) and its registry.
//
// A command is { id, title, keywords, group, run(api), when?(state), icon?, accent? }.
// run(api) only calls window.omnidesk methods (passed in as `api`) and may return a
// string (or a Promise of one) that is shown as a toast. If it rejects, the error's
// plain-English `message` is shown instead. `when(state)` hides a command when it
// doesn't make sense right now. Pages add their own via shell.registerCommands([...]).

import { $, h } from './dom.js';
import { icon } from './icons.js';
import { PAGES } from './registry.js';
import {
  state, refresh, patch, macBook, clipboardOn, mouseOn, cursorLocked, multiOn, cameraShared, screenSessions
} from './state.js';

/* ---------- registry ---------- */

const extra = new Map();     // id -> command (page-registered)
let ctx = null;              // { api, go, toast, reduced() }

export function registerCommands(cmds) {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  const ids = [];
  for (const c of list) {
    if (!c || typeof c.run !== 'function' || !c.title) { console.warn('[shell] ignored command without title/run', c); continue; }
    const id = c.id || 'page:' + c.title;
    extra.set(id, { ...c, id });
    ids.push(id);
  }
  return () => { for (const id of ids) extra.delete(id); };
}

const errMsg = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong.';

function builtins() {
  const L = [];
  const add = (c) => L.push(c);

  add({
    id: 'clipboard.on', title: 'Turn on clipboard', keywords: 'clipboard copy paste share enable',
    group: 'clipboard', icon: 'clipboard', accent: 'var(--c-clip)',
    when: () => !clipboardOn(),
    async run(api) { const r = await api.clipboard.set({ enabled: true }); patch('clipboard', r); return 'Clipboard is on'; }
  });
  add({
    id: 'clipboard.off', title: 'Turn off clipboard', keywords: 'clipboard copy paste share disable',
    group: 'clipboard', icon: 'clipboard', accent: 'var(--c-clip)',
    when: () => clipboardOn(),
    async run(api) { const r = await api.clipboard.set({ enabled: false }); patch('clipboard', r); return 'Clipboard is off'; }
  });
  add({
    id: 'mouse.on', title: 'Turn on mouse sharing', keywords: 'mouse keyboard share cursor enable',
    group: 'mouse', icon: 'mouse', accent: 'var(--c-mouse)',
    when: () => !mouseOn(),
    async run(api) { const r = await api.mouse.set({ enabled: true }); patch('mouse', r); return 'Mouse sharing is on'; }
  });
  add({
    id: 'mouse.off', title: 'Turn off mouse sharing', keywords: 'mouse keyboard share cursor disable',
    group: 'mouse', icon: 'mouse', accent: 'var(--c-mouse)',
    when: () => mouseOn(),
    async run(api) { const r = await api.mouse.set({ enabled: false }); patch('mouse', r); return 'Mouse sharing is off'; }
  });
  add({
    id: 'mouse.lock', title: 'Lock cursor to this screen', keywords: 'lock cursor hotkey stay',
    group: 'mouse', icon: 'lock', accent: 'var(--c-mouse)',
    when: () => !cursorLocked(),
    async run(api) { const r = await api.mouse.set({ locked: true }); patch('mouse', r); return 'Cursor locked to this screen'; }
  });
  add({
    id: 'mouse.unlock', title: 'Unlock cursor', keywords: 'unlock cursor hotkey free',
    group: 'mouse', icon: 'unlock', accent: 'var(--c-mouse)',
    when: () => cursorLocked(),
    async run(api) { const r = await api.mouse.set({ locked: false }); patch('mouse', r); return 'Cursor unlocked'; }
  });

  const mac = macBook();
  const macName = mac ? mac.name : 'MacBook';
  add({
    id: 'screen.start-macbook', title: `Start second screen on ${macName}`, keywords: 'second screen display monitor extend macbook',
    group: 'screen', icon: 'screen', accent: 'var(--c-screen)',
    when: () => !!macBook() && !screenSessions().some((s) => s.targetId === macBook().id),
    async run(api) {
      const target = macBook();
      if (!target) throw { code: 'no-macbook', message: 'Pair the MacBook first.' };
      await api.screen.start({ sourceId: 'this', targetId: target.id, resolution: '1920x1080', refresh: 60, quality: 'balanced' });
      ctx.go('screen');
      return `Second screen is on the ${target.name}`;
    }
  });
  add({
    id: 'screen.stop', title: 'Stop second screen', keywords: 'second screen display monitor off end',
    group: 'screen', icon: 'power', accent: 'var(--c-screen)',
    when: () => screenSessions().length > 0,
    async run(api) {
      await Promise.all(screenSessions().map((s) => api.screen.stop(s.id)));
      return 'Second screen stopped';
    }
  });

  add({
    id: 'camera.share', title: 'Share my camera', keywords: 'camera webcam video share start',
    group: 'camera', icon: 'camera', accent: 'var(--c-cam)',
    when: () => !cameraShared(),
    async run(api) { const r = await api.camera.setShared(true); patch('camera', r || { shared: true }); return 'Camera is shared'; }
  });
  add({
    id: 'camera.stop', title: 'Stop sharing camera', keywords: 'camera webcam video stop off',
    group: 'camera', icon: 'camera', accent: 'var(--c-cam)',
    when: () => cameraShared(),
    async run(api) { const r = await api.camera.setShared(false); patch('camera', r || { shared: false }); return 'Camera sharing is off'; }
  });

  add({
    id: 'multi.on', title: 'Turn on multi-device mode', keywords: 'multi device mode many computers enable',
    group: 'devices', icon: 'devices', accent: 'var(--c-multi)',
    when: () => !multiOn(),
    async run(api) { const r = await api.multi.set({ enabled: true }); patch('multi', r || { enabled: true }); return 'Multi-device mode is on'; }
  });
  add({
    id: 'multi.off', title: 'Turn off multi-device mode', keywords: 'multi device mode two computers disable',
    group: 'devices', icon: 'devices', accent: 'var(--c-multi)',
    when: () => multiOn(),
    async run(api) { const r = await api.multi.set({ enabled: false }); patch('multi', r || { enabled: false }); return 'Multi-device mode is off'; }
  });

  add({
    id: 'connection.pair', title: 'Pair a new device', keywords: 'pair add code connect join new device',
    group: 'connection', icon: 'plus', accent: 'var(--c-conn)', goes: true,
    // Only navigates: the Connection page shows the code and registers
    // "Show a new pairing code" / "Copy pairing code" itself.
    run() { ctx.go('connection'); return null; }
  });

  for (const p of PAGES) {
    add({
      id: 'go.' + p.id, title: 'Go to ' + p.label, keywords: `page open ${p.tab} ${p.id}`,
      group: 'pages', icon: p.icon, accent: p.accent, nav: true,
      run() { ctx.go(p.id); return null; }
    });
  }
  return L;
}

function available() {
  const all = [...builtins(), ...extra.values()];
  return all.filter((c) => {
    if (typeof c.when !== 'function') return true;
    try { return !!c.when(state); } catch { return false; }
  });
}

/* ---------- fuzzy match ---------- */

export function fuzzy(q, s) {
  q = q.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, idx: [] };
  const t = s.toLowerCase();
  let i = 0, score = 0, last = -2;
  const idx = [];
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      idx.push(j);
      score += (j === last + 1 ? 3 : 1) + ((j === 0 || t[j - 1] === ' ') ? 2 : 0);
      last = j; i++;
    }
  }
  return i === q.length ? { score: score - t.length * 0.01, idx } : null;
}

/* ---------- the bar ---------- */

let items = [];
let sel = 0;
let lastFocus = null;
let typingT = 0;
let closeT = 0;
let running = false;
let trapping = false;   // true from open until close starts (the scrim stays visible while it fades)

const scrim = () => $('#cmdScrim');
const input = () => $('#cmdInput');
const list = () => $('#cmdList');
export const isOpen = () => trapping;

function filter() {
  const q = input().value;
  items = available().map((c) => {
    const title = String(c.title);
    const r = fuzzy(q, title + ' ' + (c.keywords || '') + ' ' + (c.group || ''));
    return r ? { c, title, score: r.score, idx: r.idx.filter((i) => i < title.length) } : null;
  }).filter(Boolean);
  if (q.trim()) items.sort((a, b) => b.score - a.score);
  else items.sort((a, b) => (a.c.nav ? 1 : 0) - (b.c.nav ? 1 : 0));   // actions first, then pages
  sel = Math.min(sel, Math.max(0, items.length - 1));
  draw();
}

function highlight(title, idx) {
  const set = new Set(idx);
  const out = [];
  let buf = '';
  let inMark = false;
  const flush = () => { if (!buf) return; out.push(inMark ? h('mark', null, buf) : buf); buf = ''; };
  for (let i = 0; i < title.length; i++) {
    const m = set.has(i);
    if (m !== inMark) { flush(); inMark = m; }
    buf += title[i];
  }
  flush();
  return out;
}

function draw() {
  const ul = list();
  const inp = input();
  if (!items.length) {
    ul.replaceChildren(h('li.empty', { role: 'presentation' }, 'No command matches. Try “clip”, “screen” or “go”.'));
    inp.removeAttribute('aria-activedescendant');
    $('#cmd').style.setProperty('--a', 'var(--c-home)');
    return;
  }
  ul.replaceChildren(...items.map((it, i) => {
    const li = h('li', { id: 'cmd-' + i, role: 'option', 'aria-selected': String(i === sel), 'data-i': i },
      h('span.ci', { 'aria-hidden': 'true' }, icon(it.c.icon || 'spark')),
      h('span.t', null, highlight(it.title, it.idx)),
      h('span.k', { 'aria-hidden': 'true' }, it.c.nav ? 'Page' : 'Action'));
    li.style.setProperty('--a', it.c.accent || 'var(--c-home)');
    return li;
  }));
  inp.setAttribute('aria-activedescendant', 'cmd-' + sel);
  $('#cmd').style.setProperty('--a', items[sel].c.accent || 'var(--c-home)');
  const s = document.getElementById('cmd-' + sel);
  if (s) s.scrollIntoView({ block: 'nearest' });
}

function move(d) {
  if (!items.length) return;
  sel = (sel + d + items.length) % items.length;
  for (const li of list().querySelectorAll('li[role=option]')) li.setAttribute('aria-selected', String(+li.dataset.i === sel));
  input().setAttribute('aria-activedescendant', 'cmd-' + sel);
  $('#cmd').style.setProperty('--a', items[sel].c.accent || 'var(--c-home)');
  const s = document.getElementById('cmd-' + sel);
  if (s) s.scrollIntoView({ block: 'nearest' });
}

export function openCommandBar(query) {
  const sc = scrim();
  const inp = input();
  if (!trapping) {
    trapping = true;
    lastFocus = document.activeElement;
    clearTimeout(closeT);
    sc.hidden = false;
    $('#app').inert = true;
    if (ctx.reduced()) sc.classList.add('open');
    else requestAnimationFrame(() => requestAnimationFrame(() => { if (trapping) sc.classList.add('open'); }));
  }
  inp.value = typeof query === 'string' ? query : '';
  sel = 0;
  filter();
  inp.focus();
  if (inp.value) pulseTyping();
  // refresh values we can't subscribe to, then re-filter so the list is accurate
  refresh().then(() => { if (isOpen()) filter(); });
}

export function closeCommandBar(restoreFocus = true) {
  const sc = scrim();
  if (!isOpen()) return;
  trapping = false;
  sc.classList.remove('open');
  $('#cmd').classList.remove('typing');
  $('#app').inert = false;
  clearTimeout(closeT);
  const hide = () => { if (!sc.classList.contains('open')) sc.hidden = true; };
  if (ctx.reduced()) hide(); else closeT = setTimeout(hide, 400);
  if (restoreFocus && lastFocus && document.contains(lastFocus) && !lastFocus.closest('[inert]')) lastFocus.focus();
}

function pulseTyping() {
  const box = $('#cmd');
  box.classList.add('typing');
  clearTimeout(typingT);
  typingT = setTimeout(() => box.classList.remove('typing'), 900);
}

async function runItem(i) {
  const it = items[i];
  if (!it || running) return;
  const c = it.c;
  closeCommandBar(!(c.nav || c.goes));
  running = true;
  try {
    const msg = await c.run(ctx.api);
    if (msg) ctx.toast(msg);
  } catch (e) {
    console.warn('[shell] command failed', c.id, e);
    ctx.toast(errMsg(e), { kind: 'error' });
  } finally {
    running = false;
    refresh();
  }
}

/** Runs the first command matching `query` (used by tests and deep links). */
export async function runCommand(query) {
  input().value = query;
  filter();
  if (!items.length) return false;
  await runItem(0);
  return true;
}

export function initCommandBar(context) {
  ctx = context;
  const inp = input();

  inp.addEventListener('input', () => { sel = 0; filter(); pulseTyping(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); move(-sel); }
    else if (e.key === 'Enter') { e.preventDefault(); runItem(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommandBar(); }
    else if (e.key === 'Tab') { e.preventDefault(); }          // focus trap: the input owns focus
  });
  list().addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  list().addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) runItem(+li.dataset.i);
  });
  list().addEventListener('mousemove', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && +li.dataset.i !== sel) move(+li.dataset.i - sel);
  });
  scrim().addEventListener('mousedown', (e) => { if (e.target === scrim()) closeCommandBar(); });
  // anything that steals focus while open gets it sent back to the input
  document.addEventListener('focusin', (e) => {
    if (trapping && !$('#cmd').contains(e.target)) inp.focus();
  });

  $('#cmdBtn').addEventListener('click', () => openCommandBar());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isOpen()) closeCommandBar(); else openCommandBar();
    }
  });
}
