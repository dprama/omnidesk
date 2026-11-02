// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Shell entry: waits for window.omnidesk, builds the glass-folders frame (sidebar, folder
// tabs, folder stack, status bar, command bar, toasts) and routes #<page-id> to lazily
// imported page modules (../pages/<id>.js). See docs/API.md "Renderer module contracts".

import { $, $$, h } from './dom.js';
import { icon } from './icons.js';
import { PAGES, GROUPS, page } from './registry.js';
import { startState } from './state.js';
import { startStatus } from './status.js';
import { initToasts, toast } from './toast.js';
import { initCommandBar, openCommandBar, closeCommandBar, isOpen, registerCommands } from './commands.js';

const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = RM.matches;
RM.addEventListener('change', (e) => { reduced = e.matches; });
const PHONE = window.matchMedia('(max-width: 820px)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let api = null;

/* ---------- the shell object handed to pages ---------- */

function makeShell(owner) {
  return Object.freeze({
    go,
    toast: (text) => toast(text),
    registerCommands(cmds) {
      const off = registerCommands(cmds);
      // commands a page registers while mounted are dropped automatically when it unmounts
      if (owner) owner.cmds.push(off);
      return off;
    },
    get reducedMotion() { return reduced; },
    openCommandBar: (query) => openCommandBar(query)
  });
}
const shell = makeShell(null);

/* ---------- wait for the preload / mock ---------- */

function waitForApi(timeoutMs = 15000) {
  if (window.omnidesk) return Promise.resolve(window.omnidesk);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.omnidesk) return resolve(window.omnidesk);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('window.omnidesk did not appear'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/* ---------- sidebar + tabs ---------- */

function buildNav() {
  const nav = $('#nav');
  nav.replaceChildren(...GROUPS.map((g) => {
    const ul = h('ul', null, ...PAGES.filter((p) => p.group === g.id).map((p) => {
      const a = h('a.nav-i', { href: '#' + p.id, 'data-nav': p.id },
        icon(p.icon), h('span', null, p.label), h('span.st', { 'data-st': p.id, 'aria-hidden': 'true', hidden: true }));
      a.style.setProperty('--a', p.accent);
      return h('li', null, a);
    }));
    const id = 'navg-' + g.id;
    return h('div.navg', g.title ? { role: 'group', 'aria-labelledby': id } : null, g.title ? h('h2', { id }, g.title) : null, ul);
  }));

  $('#tabs').replaceChildren(...PAGES.map((p) => {
    const a = h('a.tab', { href: '#' + p.id, 'data-tab': p.id }, p.tab);
    a.style.setProperty('--a', p.accent);
    return a;
  }));
}

function navState(id) {
  const p = page(id);
  for (const a of $$('[data-nav], [data-tab]')) {
    if ((a.dataset.nav || a.dataset.tab) === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const crumb = $('#crumb');
  crumb.style.setProperty('--a', p.accent);
  const group = GROUPS.find((g) => g.id === p.group);
  crumb.replaceChildren(h('i', { 'aria-hidden': 'true' }),
    ...(group && group.title ? [h('span', null, group.title), h('span', { 'aria-hidden': 'true' }, '/')] : []),
    h('b', null, p.label));
  const t = $(`[data-tab="${id}"]`);
  const w = $('#tabsWrap');
  if (t && w) {
    const l = t.offsetLeft - 24;
    if (l < w.scrollLeft || t.offsetLeft + t.offsetWidth > w.scrollLeft + w.clientWidth) {
      w.scrollTo({ left: Math.max(0, l), behavior: reduced ? 'auto' : 'smooth' });
    }
  }
  document.title = p.id === 'home' ? 'OmniDesk' : `${p.label} · OmniDesk`;
}

/* ---------- drawer (phone) ---------- */

function setDrawer(open) {
  const app = $('#app');
  const was = app.classList.contains('drawer');
  app.classList.toggle('drawer', open);
  $('#menuBtn').setAttribute('aria-expanded', String(open));
  $('#main').inert = open;
  $('.status').inert = open;
  if (open && !was) {
    const a = $('.nav-i[aria-current]') || $('.nav-i');
    if (a) a.focus();
  }
}
const closeDrawer = () => setDrawer(false);

/* ---------- folder stack + router ---------- */

let current = null;   // { id, sheet, unmount, cmds: [] }
let navToken = 0;

function seedStack() {
  const st = $('#stack');
  for (const [accent, cls] of [['var(--c-clip)', 'back back2'], ['var(--c-conn)', 'back']]) {
    const s = h('section', { class: 'sheet ' + cls, 'aria-hidden': 'true' });
    s.style.setProperty('--a', accent);
    s.inert = true;
    st.append(s);
  }
}

function safe(fn, what) {
  if (typeof fn !== 'function') return;
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[shell] ${what}`, e));
  } catch (e) { console.warn(`[shell] ${what}`, e); }
}

function teardown(ctx) {
  if (!ctx) return;
  safe(ctx.unmount, `unmount(${ctx.id})`);
  ctx.unmount = null;
  for (const off of ctx.cmds.splice(0)) safe(off, 'unregister commands');
}

function placeholder(sheet, meta) {
  const hid = 'h-' + meta.id;
  const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  art.setAttribute('viewBox', '0 0 300 150');
  art.setAttribute('aria-hidden', 'true');
  art.innerHTML =
    '<path class="f1" d="M30 30h70l10 12h160a8 8 0 0 1 8 8v82a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8V38a8 8 0 0 1 8-8z"/>' +
    '<path class="f2" d="M40 48h64l10 12h146a8 8 0 0 1 8 8v66a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8V56a8 8 0 0 1 8-8z"/>' +
    '<rect class="tabp" x="44" y="46" width="56" height="3" rx="1.5"/>' +
    '<path class="ln" d="M58 88h120M58 106h168M58 124h84"/>';
  sheet.replaceChildren(
    h('header.lh', null,
      h('div', null,
        h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Coming soon'),
        h('h1', { id: hid }, meta.label),
        h('p.sub', null, 'This page is being built. Everything else in OmniDesk keeps working while it is.')),
      h('div.lh-scene.ph-art', null, art)),
    h('div.empty-state', null,
      icon(meta.icon),
      h('b', null, 'This page is being built'),
      h('p', null, 'Press Ctrl K to run a command, or pick another folder.'))
  );
  sheet.setAttribute('aria-labelledby', hid);
}

function labelSheet(sheet, id) {
  const h1 = sheet.querySelector('h1');
  if (!h1) { sheet.setAttribute('aria-label', page(id).label); return; }
  if (!h1.id) h1.id = 'h-' + id;
  sheet.setAttribute('aria-labelledby', h1.id);
}

async function show(id) {
  closeDrawer();
  if (current && current.id === id) return;
  const token = ++navToken;
  const meta = page(id);
  const stack = $('#stack');
  const old = current ? current.sheet : null;

  teardown(current);

  const sheet = h('section', { class: 'sheet front', id: 'content', tabindex: '-1', 'data-page': id, 'aria-busy': 'true' });
  sheet.style.setProperty('--a', meta.accent);
  if (old && !reduced) sheet.classList.add('enter');
  sheet.addEventListener('animationend', (e) => { if (e.target === sheet) sheet.classList.remove('enter'); });

  // the previous sheets recede: front -> back -> back2 -> gone
  for (const e of $$('.sheet.back2', stack)) e.remove();
  for (const e of $$('.sheet.back', stack)) e.classList.add('back2');
  if (old) {
    old.classList.remove('front', 'enter', 'loading');
    old.classList.add('back');
    old.setAttribute('aria-hidden', 'true');
    old.removeAttribute('aria-labelledby');
    old.removeAttribute('aria-busy');
    old.removeAttribute('tabindex');
    old.inert = true;
    for (const e of $$('[id]', old)) e.removeAttribute('id');
    old.removeAttribute('id');
    setTimeout(() => { if (!old.classList.contains('front')) old.replaceChildren(); }, reduced ? 0 : 420);
  }
  stack.append(sheet);

  const ctx = { id, sheet, unmount: null, cmds: [] };
  current = ctx;
  navState(id);
  $('#main').scrollTop = 0;

  // only show the loading shimmer if the import is slow
  const shimmer = setTimeout(() => { if (current === ctx) sheet.classList.add('loading'); }, 120);

  let mod = null;
  try {
    mod = (await import(`../pages/${id}.js`)).default;
  } catch (e) {
    console.warn(`[shell] page "${id}" is not available yet:`, e && e.message ? e.message : e);
  }
  clearTimeout(shimmer);
  if (token !== navToken) return;
  sheet.classList.remove('loading');
  sheet.removeAttribute('aria-busy');

  if (!mod || typeof mod.mount !== 'function') { placeholder(sheet, meta); return; }
  if (mod.accent) sheet.style.setProperty('--a', mod.accent);

  try {
    let un = mod.mount(sheet, api, makeShell(ctx));
    if (un && typeof un.then === 'function') un = await un;
    const fn = typeof un === 'function' ? un
      : typeof mod.unmount === 'function' ? () => mod.unmount(sheet) : null;
    if (current !== ctx) { safe(fn, `unmount(${id})`); return; }   // navigated away meanwhile
    ctx.unmount = fn;
    labelSheet(sheet, id);
    // focus was on something that no longer exists (e.g. the closed command bar): start at the sheet
    const a = document.activeElement;
    if (!a || a === document.body || !document.contains(a) || a.closest('[inert], [hidden]')) sheet.focus({ preventScroll: true });
  } catch (e) {
    console.warn(`[shell] page "${id}" failed to mount:`, e);
    if (current !== ctx) return;
    teardown(ctx);
    sheet.style.setProperty('--a', meta.accent);
    placeholder(sheet, meta);
  }
}

function go(id) {
  if (!page(id)) id = 'home';
  closeDrawer();
  if (location.hash.slice(1) !== id) location.hash = id;   // hashchange -> show()
  else show(id);
}

function onHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (page(id)) { show(id); return; }
  if (!id) { show('home'); return; }
  // not a page (e.g. an in-page anchor): keep the current folder and its URL
  if (current) history.replaceState(null, '', '#' + current.id);
  else show('home');
}

/* ---------- boot ---------- */

function wireFrame() {
  $('#kbdHint').textContent = isMac ? '⌘K' : 'Ctrl K';
  $('#menuBtn').addEventListener('click', () => setDrawer(!$('#app').classList.contains('drawer')));
  $('#drawerScrim').addEventListener('click', closeDrawer);
  PHONE.addEventListener('change', (e) => { if (!e.matches) closeDrawer(); });

  // skip link: focus the front sheet without touching the hash router
  $('.skip').addEventListener('click', (e) => {
    e.preventDefault();
    const s = $('#stack .sheet.front');
    if (s) s.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isOpen()) { e.preventDefault(); closeCommandBar(); return; }
    if ($('#app').classList.contains('drawer')) { closeDrawer(); $('#menuBtn').focus(); }
  });

  window.addEventListener('hashchange', onHash);
}

function fatal(err) {
  console.error('[shell] cannot start:', err);
  const stack = $('#stack');
  const s = h('section.sheet.front', null,
    h('div.empty-state', null, h('b', null, 'OmniDesk could not start'), h('p', null, 'The app backend did not respond. Restart OmniDesk.')));
  stack.replaceChildren(s);
}

async function boot() {
  buildNav();
  seedStack();
  wireFrame();
  initToasts(() => reduced);
  try {
    api = await waitForApi();
  } catch (e) { fatal(e); return; }
  initCommandBar({ api, go, toast, reduced: () => reduced });
  startState(api);
  startStatus();
  const first = decodeURIComponent(location.hash.slice(1));
  if (!page(first)) history.replaceState(null, '', '#home');
  show(page(first) ? first : 'home');
}

boot();

export { shell };
