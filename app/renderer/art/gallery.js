// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Art test page: every device in every state, every scene with fake data.

import { device, scene } from './index.js';

const $ = (s) => document.querySelector(s);
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

// ---- devices ----
const KINDS = ['windows-pc', 'windows-pc-2', 'macbook', 'mac-mini'];
const STATES = ['online', 'offline', 'active'];
const grid = $('#devices');
grid.append(h('div'), ...STATES.map((s) => h('div', 'head', s)), h('div', 'head smallcol', 'small'));
for (const k of KINDS) {
  grid.append(h('div', 'k', k));
  for (const s of STATES) {
    const c = h('div', 'cell');
    c.append(device(k, { size: k === 'windows-pc-2' ? 200 : k === 'mac-mini' ? 110 : 150, state: s, accent: 'var(--c-multi)' }));
    grid.append(c);
  }
  const c = h('div', 'cell small smallcol');
  STATES.forEach((s) => c.append(device(k, { size: 44, state: s, accent: 'var(--c-multi)' })));
  grid.append(c);
}

// ---- scenes with fake data ----
const dev = (id, name, os, extra = {}) => ({ id, name, os, online: true, screens: [{ x: 0, y: 0, w: 1920, h: 1080 }], battery: null, ...extra });

const DEMOS = [
  { name: 'desk', title: 'desk · home', accent: '--c-home', run: (s) => {
    s.update({ devices: [dev('this', 'Windows PC', 'windows', { thisDevice: true, screens: [{}, {}] }), dev('mac', 'MacBook', 'macos', { battery: { percent: 80 } })], cursorOn: 'mac' });
  } },
  { name: 'desk', title: 'desk · three, one offline', accent: '--c-home', run: (s) => {
    s.update({ devices: [dev('this', 'Windows PC', 'windows'), dev('mini', 'Studio Mac mini', 'macos', { online: false }), dev('mac', 'MacBook', 'macos', { battery: { percent: 80 } })] });
  } },
  { name: 'radar', title: 'radar · connection', accent: '--c-conn', run: (s) => {
    const found = [];
    const add = (d) => { found.push(d); s.update({ devices: found.slice() }); };
    return [setTimeout(() => add(dev('mac-1', 'MacBook', 'macos')), 600),
      setTimeout(() => add(dev('mini-7', 'Studio Mac mini', 'macos', { online: false })), 2200),
      setTimeout(() => add(dev('pc-3', 'Living room PC', 'windows')), 4200)];
  } },
  { name: 'screen-map', title: 'screen-map · mouse', accent: '--c-mouse', wide: true, run: (s) => {
    s.update({ screens: { this: [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }], peer: [{ x: 0, y: 0, w: 1440, h: 900 }] },
      crossingEdge: 'right', names: { this: 'Windows PC', peer: 'MacBook' } });
    // a cursor that wanders across both monitors, crosses, and comes back
    const path = [['this', 900, 700], ['this', 2300, 500], ['this', 3300, 800], ['this', 4470, 700], ['mac', 200, 420], ['mac', 900, 300], ['mac', 600, 640], ['mac', 5, 450], ['this', 4300, 760], ['this', 1500, 900]];
    let i = 0;
    const step = () => { const [deviceId, x, y] = path[i++ % path.length]; s.update({ cursor: { deviceId, x, y } }); };
    step();
    return [setInterval(step, 1300)];
  } },
  { name: 'clipboard-hop', title: 'clipboard-hop', accent: '--c-clip', run: (s) => {
    const kinds = ['text', 'image', 'file']; let i = 0;
    return [setInterval(() => s.update({ kind: kinds[++i % 3] }), 15000)];
  } },
  { name: 'display-slide', title: 'display-slide · demo loop', accent: '--c-screen', run: (s) => { s.update({ direction: 'pc-to-mac', live: false }); } },
  { name: 'display-slide', title: 'display-slide · live, pc → mac', accent: '--c-screen', run: (s) => {
    return [setTimeout(() => s.update({ direction: 'pc-to-mac', live: true }), 700)];
  } },
  { name: 'camera-watch', title: 'camera-watch', accent: '--c-cam', run: (s) => {
    s.update({ liveDeviceId: 'mac', watchers: ['pc', 'mini'] });
    return [setTimeout(() => s.update({ watchers: ['pc', 'mini', 'pc-3'] }), 3000)];
  } },
  { name: 'multi-desk', title: 'multi-desk', accent: '--c-multi', run: (s) => {
    s.update({ devices: [dev('this', 'Windows PC', 'windows', { screens: [{}, {}] }), dev('mini', 'Mac mini', 'macos'), dev('mac', 'MacBook', 'macos', { battery: {} })] });
  } },
  { name: 'tip-jar', title: 'tip-jar', accent: '--c-tip' },
  { name: 'feedback-note', title: 'feedback-note', accent: '--c-fb' },
  { name: 'about-credits', title: 'about-credits', accent: '--c-about', run: (s) => { s.update({ names: ['Deskflow Developers', 'Synergy App Ltd', 'Chris Schoeneman', 'Virtual Display Driver'] }); } },
];

const wrap = $('#scenes');
const cards = DEMOS.map((d) => {
  const card = h('div', 'card' + (d.wide ? ' wide' : ''));
  card.style.setProperty('--a', `var(${d.accent})`);
  const host = h('div', 'host');
  const cap = h('p');
  cap.append(h('i'), document.createTextNode(d.title));
  card.append(host, cap);
  wrap.append(card);
  return { d, host, live: null, timers: [] };
});

function start(reducedMotion) {
  for (const c of cards) {
    if (c.live) c.live.stop();
    c.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    c.live = scene(c.d.name, c.host, { accent: `var(${c.d.accent})`, reducedMotion });
    c.timers = (c.d.run && c.d.run(c.live)) || [];
  }
}

const box = $('#reduced');
box.checked = matchMedia('(prefers-reduced-motion: reduce)').matches || /reduced/.test(location.hash);
box.addEventListener('change', () => start(box.checked));
start(box.checked);
window.__art = { start, cards };
