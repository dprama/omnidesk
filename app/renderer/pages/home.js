// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Home: every device on the desk as a card (OS, link, ping, battery, what it shares right
// now), a live header with the desk scene, and quick switches for mouse and clipboard.

import { h, setText } from '../shell/dom.js';
import { icon, LINK_LABELS } from '../shell/icons.js';
import { device, scene } from '../art/index.js';


/* ---------- helpers ---------- */

const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const osLabel = (d) => `${OS_NAMES[d.os] || d.os} ${d.osVersion || ''}`.trim();
const archLabel = (d) => (d.os === 'macos' ? (d.arch === 'arm64' ? 'Apple silicon' : 'Intel x64') : d.arch === 'arm64' ? 'Arm64' : 'x64');
function kindOf(d) {
  if (d.os === 'macos') return d.battery || /book|laptop/i.test(d.name) ? 'macbook' : 'mac-mini';
  return d.screens && d.screens.length >= 2 ? 'windows-pc-2' : 'windows-pc';
}
function ago(iso) {
  if (!iso) return 'a while ago';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
const joinNames = (n) => (n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
const screensLabel = (d) => (d.screens || []).map((s) => `${s.w}×${s.h}`).join(' + ') || 'None';
const SHARES = [
  ['mouse', 'Mouse & keyboard', 'var(--c-mouse)'],
  ['clipboard', 'Clipboard', 'var(--c-clip)'],
  ['screen', 'Second screen', 'var(--c-screen)'],
  ['camera', 'Camera', 'var(--c-cam)'],
];

/** A stat cell: <dd><span.num/><span.u/></dd> with in-place updates. */
function stat(label, mono = true) {
  const num = h(mono ? 'span.num' : 'span'), u = h('span.u');
  const dd = h('dd', null, num, u);
  return {
    el: h('div', null, h('dt', null, label), dd),
    dt: null,
    set(n, unit = '') { setText(num, n); setText(u, unit); },
  };
}

/* ---------- device card ---------- */

function cardSig(d) {
  return JSON.stringify([d.name, d.os, d.osVersion, d.arch, d.online, d.thisDevice, d.link && d.link.type,
    !!d.battery, d.battery && d.battery.charging, d.sharing, d.online ? null : ago(d.lastSeen), screensLabel(d)]);
}

function buildCard(d) {
  const off = !d.online;
  const refs = {};
  const kv = h('dl.kv');
  const add = (k, v) => kv.append(h('dt', null, k), h('dd', null, v));

  if (d.thisDevice) {
    add('Link', d.link ? LINK_LABELS[d.link.type] : 'Not connected');
    add('Role', 'This computer');
  } else if (off) {
    add('Link', 'Not connected');
    add('Ping', h('span.muted', null, '—'));
  } else {
    add('Link', d.link ? LINK_LABELS[d.link.type] : 'Not connected');
    refs.ping = h('span.num');
    add('Ping', d.link && d.link.pingMs != null ? h('span', null, refs.ping, ' ms') : h('span.muted', null, 'Measuring…'));
  }
  if (d.battery) {
    refs.battBar = h('i');
    refs.battNum = h('span.num');
    refs.batt = h('span.batt', null, h('span.batt-b', { 'aria-hidden': 'true' }, refs.battBar), h('span', null, refs.battNum, '%'),
      d.battery.charging ? [icon('bolt'), h('span.sr-only', null, 'charging')] : null);
    add('Battery', refs.batt);
  } else {
    add('Screens', h('span.num', null, screensLabel(d)));
  }

  let foot;
  if (off) {
    foot = [h('span.t', null, 'Last seen'), h('span.muted', null, ago(d.lastSeen))];
  } else {
    const on = SHARES.filter(([k]) => d.sharing && d.sharing[k]);
    foot = [h('span.t', null, 'Sharing now'),
      on.length ? h('div.chips', null, on.map(([, label, c]) => {
        const i = h('i', { 'aria-hidden': 'true' });
        i.style.setProperty('--c', c);
        return h('span.chip', null, i, label);
      })) : h('span.muted', null, 'Nothing right now')];
  }

  const el = h('article.card.dev' + (off ? '.off' : ''), { 'aria-label': d.name },
    h('div.dev-art', null, device(kindOf(d), { size: 160, state: off ? 'offline' : 'online' })),
    h('div', null,
      h('h3', null, d.name,
        d.thisDevice ? h('span.chip', null, 'This device') : null,
        off ? h('span.pill', null, h('i.dot-off', { 'aria-hidden': 'true' }), 'Offline')
          : !d.thisDevice ? h('span.pill', null, h('i.dot-good', { 'aria-hidden': 'true' }), 'Online') : null),
      h('p.os', null, `${osLabel(d)} · ${archLabel(d)}`),
      kv),
    h('div.share-now', null, foot));
  return { el, refs, sig: cardSig(d) };
}

function liveCard(card, d) {
  const r = card.refs;
  if (r.ping && d.link && d.link.pingMs != null) setText(r.ping, d.link.pingMs);
  if (r.batt && d.battery) {
    setText(r.battNum, d.battery.percent);
    r.battBar.style.setProperty('--p', String(d.battery.percent));
    r.batt.classList.toggle('low', d.battery.percent <= 20 && !d.battery.charging);
  }
}

/* ---------- page ---------- */

export default {
  id: 'home', label: 'Home', tab: 'Home', group: 'home', accent: 'var(--c-home)', icon: 'home',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    let devices = [];
    let status = null;

    /* header */
    const sConn = stat('Connected'), sPing = stat('Ping'), sBatt = stat('Battery'), sCursor = stat('Cursor on', false);
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Live');
    const sub = h('p.sub', null, 'Loading your devices…');
    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    const stats = h('dl.stats', null, sConn.el, sPing.el, sBatt.el, sCursor.el);
    const pingDt = sPing.el.firstChild, battDt = sBatt.el.firstChild;

    /* body */
    const grid = h('div.grid-3', { role: 'list', 'aria-label': 'Devices' });
    const firstRun = h('div.first', { role: 'listitem' });
    const cards = new Map();

    const sw = (label, onChange) => {
      const b = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label });
      b.addEventListener('click', () => onChange(b.getAttribute('aria-checked') !== 'true'));
      return b;
    };
    const qsErr = h('p.err', { role: 'alert', hidden: true });
    const mouseSw = sw('Share mouse and keyboard', (on) => toggle('mouse', on));
    const clipSw = sw('Share clipboard', (on) => toggle('clipboard', on));
    const qRow = (accent, ic, title, desc, ctl) => {
      const r = h('div.row', null, h('div.qs-l', null, h('span.qs-ic', { 'aria-hidden': 'true' }, icon(ic)),
        h('div', null, h('b', null, title), h('div.d', null, desc))), ctl);
      r.style.setProperty('--a', accent);
      return r;
    };
    const conBtn = h('button.btn.btn-sm', { type: 'button' }, icon('connection'), 'Pair a new device');
    conBtn.style.setProperty('--a', 'var(--c-conn)');
    conBtn.addEventListener('click', () => shell.go('connection'));
    const layBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button' }, icon('layout'), 'Arrange screens');
    layBtn.addEventListener('click', () => shell.go('layout'));
    const cmdBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button' }, icon('search'), 'All commands');
    cmdBtn.addEventListener('click', () => shell.openCommandBar(''));

    el.replaceChildren(
      h('header.lh', null, h('div', null, kick, h('h1', null, 'Your desk'), sub, stats), sceneHost),
      grid,
      h('h2.sect', null, 'Quick switches'),
      h('section.card', { 'aria-label': 'Quick switches' },
        h('div.qs', null,
          qRow('var(--c-mouse)', 'mouse', 'Mouse & keyboard', 'One pointer and keyboard for every computer.', mouseSw),
          qRow('var(--c-clip)', 'clipboard', 'Clipboard', 'Copy on one computer, paste on another.', clipSw)),
        qsErr,
        h('div.qs-foot', null, h('div.btns', null, conBtn, layBtn), cmdBtn))
    );

    const sc = scene('desk', sceneHost, { accent: 'var(--c-home)', reducedMotion: shell.reducedMotion });

    /* quick switches */
    const busy = { mouse: false, clipboard: false };
    async function toggle(which, on) {
      if (busy[which]) return;
      busy[which] = true;
      const b = which === 'mouse' ? mouseSw : clipSw;
      b.setAttribute('aria-checked', String(on));
      qsErr.hidden = true;
      try {
        await api[which].set({ enabled: on });
        if (!alive) return;
        shell.toast(which === 'mouse' ? `Mouse sharing is ${on ? 'on' : 'off'}` : `Clipboard is ${on ? 'on' : 'off'}`);
      } catch (e) {
        if (!alive) return;
        b.setAttribute('aria-checked', String(!on));
        qsErr.textContent = errText(e);
        qsErr.hidden = false;
      } finally {
        busy[which] = false;
      }
    }

    /* rendering */
    const peer = () => {
      const id = status && status.link && status.link.deviceId;
      return devices.find((d) => d.id === id) || devices.find((d) => !d.thisDevice && d.online && d.link) || null;
    };

    function renderHeader() {
      const peers = devices.filter((d) => !d.thisDevice);
      const on = peers.filter((d) => d.online);
      const me = devices.find((d) => d.thisDevice);
      if (!devices.length) setText(sub, 'Loading your devices…');
      else if (!peers.length) setText(sub, 'Only this computer so far. Pair a second one to share one mouse, keyboard and clipboard.');
      else if (!on.length) setText(sub, `Your other ${peers.length === 1 ? 'computer is' : 'computers are'} offline. ${peers.length === 1 ? 'It joins' : 'They join'} again as soon as ${peers.length === 1 ? 'it wakes' : 'they wake'} up.`);
      else setText(sub, `${joinNames([me && me.name, ...on.map((d) => d.name)].filter(Boolean))} are working as one. Move the pointer off an outer edge to cross.`);

      sPing.el.hidden = !peers.length;
      const p = peer();
      if (p && p.link && p.link.pingMs != null) {
        setText(pingDt, `${p.name} ping`);
        sPing.set(p.link.pingMs, 'ms');
      } else {
        setText(pingDt, 'Ping');
        sPing.set('—', on.length ? 'measuring' : 'no link');
      }
      const lap = devices.find((d) => d.battery && d.online) || devices.find((d) => d.battery);
      sBatt.el.hidden = !lap;
      if (lap) {
        setText(battDt, devices.filter((d) => d.battery).length > 1 ? `${lap.name} battery` : 'Battery');
        sBatt.set(lap.battery.percent, lap.battery.charging ? '% charging' : '%');
      }
      // status.connected / status.total: the same numbers as the status bar
      if (status) sConn.set(status.connected, `of ${status.total}`);
      else sConn.set('…');
      const cur = status && devices.find((d) => d.id === status.cursorOn);
      sCursor.set(cur ? cur.name : '—');
      setText(kick.lastChild, on.length ? 'Live' : peers.length ? 'Waiting' : 'Just you');
      sc.update({ devices, cursorOn: status ? status.cursorOn : null });
    }

    function renderCards() {
      const seen = new Set();
      let prev = null;
      for (const d of devices) {
        seen.add(d.id);
        let c = cards.get(d.id);
        const sig = cardSig(d);
        if (!c || c.sig !== sig) {
          const n = buildCard(d);
          n.el.setAttribute('role', 'listitem');
          if (c) c.el.replaceWith(n.el);
          cards.set(d.id, n);
          c = n;
        }
        // keep DOM order equal to the list order
        const want = prev ? prev.nextSibling : grid.firstChild;
        if (want !== c.el) grid.insertBefore(c.el, want);
        prev = c.el;
        liveCard(c, d);
      }
      for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }

      const peers = devices.filter((d) => !d.thisDevice);
      if (devices.length && !peers.length) {
        if (!firstRun.firstChild) {
          const b = h('button.btn.btn-primary', { type: 'button' }, icon('connection'), 'Pair a new device');
          b.style.setProperty('--a', 'var(--c-conn)');
          b.addEventListener('click', () => shell.go('connection'));
          const es = h('div.empty-state', null, icon('devices'), h('b', null, 'Add your second computer'),
            h('p', null, 'Open OmniDesk on the other computer, then pair the two with a 6-digit code. No account needed.'),
            h('div.btns', null, b));
          firstRun.replaceChildren(es);
        }
        if (grid.lastChild !== firstRun) grid.append(firstRun);
      } else if (firstRun.firstChild) { firstRun.replaceChildren(); firstRun.remove(); }
    }

    function renderSwitches() {
      if (!status) return;
      if (!busy.mouse) mouseSw.setAttribute('aria-checked', String(!!status.mouse));
      if (!busy.clipboard) clipSw.setAttribute('aria-checked', String(!!status.clipboard));
    }

    offs.push(api.devices.on((list) => {
      if (!alive || !Array.isArray(list)) return;
      devices = list;
      renderCards();
      renderHeader();
    }));
    offs.push(api.status.on((s) => {
      if (!alive || !s) return;
      status = s;
      renderSwitches();
      renderHeader();
    }));

    // "last seen" text ages while the page is open
    const ageTimer = setInterval(() => { if (devices.length) renderCards(); }, 30000);

    return () => {
      alive = false;
      clearInterval(ageTimer);
      for (const off of offs) { try { off(); } catch (_) { /* already gone */ } }
      sc.stop();
    };
  },
};
