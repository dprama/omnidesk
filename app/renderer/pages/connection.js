// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Connection: radar of computers found nearby, pairing with a 6-digit code (both sides:
// show a code here, or type the code another computer shows), and the link per device.

import { h, setText } from '../shell/dom.js';
import { icon, LINK_LABELS } from '../shell/icons.js';
import { device, scene } from '../art/index.js';


const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const osLabel = (d) => `${OS_NAMES[d.os] || d.os} ${d.osVersion || ''}`.trim();
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
const LINK_ICONS = { wifi: 'wifi', usb: 'usb', bluetooth: 'bluetooth', ethernet: 'ethernet' };
const LINK_ORDER = ['wifi', 'usb', 'bluetooth', 'ethernet'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 2 * Math.PI * 22;

function stat(label, mono = true) {
  const num = h(mono ? 'span.num' : 'span'), u = h('span.u');
  const dt = h('dt', null, label);
  return { el: h('div', null, dt, h('dd', null, num, u)), dt, set(n, unit = '') { setText(num, n); setText(u, unit); } };
}

export default {
  id: 'connection', label: 'Connection', tab: 'Connection', group: 'devices', accent: 'var(--c-conn)', icon: 'connection',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    let devices = [];
    let found = [];
    let mode = 'show';                 // 'show' (this computer shows a code) | 'enter' (type another computer's code)
    let pair = null;                   // { code, expiresAt } while a code is shown
    let expired = false;
    let pairErr = '';
    let busy = false;
    let pick = null;                   // found device id chosen on the "enter" side
    let codeVal = '';
    let enterErr = '';
    let paired = null;                 // name of the device just paired
    let countdown = null;
    let cmdOff = null;

    /* ---------- header ---------- */
    const sFound = stat('Found nearby'), sLink = stat('Link', false), sPing = stat('Ping');
    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Searching');
    el.replaceChildren(h('header.lh', null,
      h('div', null, kick, h('h1', null, 'Connection'),
        h('p.sub', null, 'OmniDesk looks for computers on your network and cables. One code pairs two of them, and nothing leaves your desk.'),
        h('dl.stats', null, sFound.el, sLink.el, sPing.el)),
      sceneHost));
    const sc = scene('radar', sceneHost, { accent: 'var(--c-conn)', reducedMotion: shell.reducedMotion });

    /* ---------- pairing card ---------- */
    const pairCard = h('section.card', { 'aria-labelledby': 'conn-pair-h' });
    const modeSeg = h('div.seg.pair-mode', { role: 'group', 'aria-label': 'Which computer is this?' });
    const mShow = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Show a code here');
    const mEnter = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Type a code');
    modeSeg.append(mShow, mEnter);
    mShow.addEventListener('click', () => setMode('show'));
    mEnter.addEventListener('click', () => setMode('enter'));
    const pairBody = h('div');
    pairCard.append(h('h2', { id: 'conn-pair-h' }, 'Pair a new device'), modeSeg, pairBody);

    /* ---------- links card ---------- */
    const linkList = h('div');
    const linkCard = h('section.card', { 'aria-labelledby': 'conn-link-h' },
      h('h2', { id: 'conn-link-h' }, 'Link per device'),
      h('p.hint', null, 'Pick how each computer talks to this one. A USB cable is fastest; Wi-Fi needs nothing extra.'),
      linkList);

    const note = h('div.note', null, icon('lock'),
      h('p', null, h('b', null, 'Encrypted, no account, no cloud.'), h('br'),
        h('small', null, 'Computers talk to each other directly over your network or cable. The keys are made on your computers and stay there.')));

    el.append(h('div.grid-2', null, pairCard, linkCard), h('div.note-wrap', null, note));

    /* ---------- pairing logic ---------- */
    function setMode(m) {
      if (mode === m) return;
      mode = m;
      mShow.setAttribute('aria-pressed', String(m === 'show'));
      mEnter.setAttribute('aria-pressed', String(m === 'enter'));
      paired = null;
      renderPair();
    }

    function stopCountdown() { if (countdown) { clearInterval(countdown); countdown = null; } }

    async function startPair() {
      if (busy) return;
      busy = true; pairErr = ''; expired = false; paired = null;
      renderPair();
      try {
        const r = await api.connection.pairStart();
        if (!alive) return;
        pair = r;
        stopCountdown();
        countdown = setInterval(tick, 1000);
        registerCopy();
      } catch (e) {
        if (!alive) return;
        pair = null;
        pairErr = errText(e);
      }
      busy = false;
      renderPair();
      const first = pairBody.querySelector('[data-focus]');
      if (first) first.focus();
    }

    async function cancelPair() {
      stopCountdown();
      const had = pair;
      pair = null; expired = false; pairErr = '';
      unregisterCopy();
      renderPair();
      pairBody.querySelector('button') && pairBody.querySelector('button').focus();
      if (!had) return;
      try { await api.connection.pairCancel(); if (alive) shell.toast('Pairing cancelled'); } catch (e) { if (alive) shell.toast(errText(e)); }
    }

    const left = () => (pair ? Math.max(0, Math.round((Date.parse(pair.expiresAt) - Date.now()) / 1000)) : 0);
    let ringEl = null, leftEl = null;
    function tick() {
      if (!pair) return stopCountdown();
      const s = left();
      if (s <= 0) {
        stopCountdown();
        expired = true;
        unregisterCopy();
        renderPair();
        return;
      }
      if (ringEl) ringEl.setAttribute('stroke-dashoffset', (RING * (1 - s / 120)).toFixed(1));
      if (leftEl) setText(leftEl, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }

    async function copyCode() {
      if (!pair) return 'Show a pairing code first';
      try { await navigator.clipboard.writeText(pair.code); return 'Pairing code copied'; } catch (_) { return `The code is ${pair.code.split('').join(' ')}`; }
    }
    function registerCopy() {
      if (cmdOff) return;
      cmdOff = shell.registerCommands([{
        id: 'connection.copy-code', title: 'Copy pairing code', keywords: 'pair code clipboard copy six digits', group: 'connection', icon: 'connection', accent: 'var(--c-conn)',
        run: () => copyCode(),
      }]);
    }
    function unregisterCopy() { if (cmdOff) { try { cmdOff(); } catch (_) { /* gone */ } cmdOff = null; } }

    async function submitCode(ev) {
      if (ev) ev.preventDefault();
      if (busy) return;
      enterErr = '';
      if (!pick) enterErr = 'Pick the computer that shows the code.';
      else if (!/^\d{6}$/.test(codeVal)) enterErr = 'Type all 6 digits of the code.';
      if (enterErr) { renderPair(); focusEnter(); return; }
      busy = true; renderPair();
      try {
        const d = await api.connection.pairEnter(pick, codeVal);
        if (!alive) return;
        paired = d && d.name ? d.name : 'the other computer';
        pick = null; codeVal = '';
        shell.toast(`Paired with ${paired}`);
      } catch (e) {
        if (!alive) return;
        enterErr = errText(e);
      }
      busy = false;
      renderPair();
      if (enterErr) focusEnter();
      else { const b = pairBody.querySelector('button'); if (b) b.focus(); }
    }
    function focusEnter() {
      const t = pairBody.querySelector(pick ? 'input' : '.found button') || pairBody.querySelector('input');
      if (t) t.focus();
    }

    function renderShow() {
      ringEl = leftEl = null;
      const err = pairErr ? h('p.err', { role: 'alert' }, pairErr) : null;
      if (!pair) {
        const b = h('button.btn.btn-primary', { type: 'button', disabled: busy }, icon('connection'), busy ? 'Making a code…' : 'Show a pairing code');
        b.addEventListener('click', startPair);
        return [h('p.hint', null, 'Add another Windows or Mac computer to this desk. This computer shows a 6-digit code; you type it on the other one.'),
          err, h('div.btns', null, b)];
      }
      const digits = pair.code.split('');
      const codeEl = h('div.code' + (expired ? '.expired' : ''), { role: 'img', 'aria-label': `Pairing code ${digits.join(' ')}` },
        digits.map((c) => h('span', { 'aria-hidden': 'true' }, c)));
      if (expired) {
        const b = h('button.btn.btn-primary', { type: 'button', 'data-focus': '' }, 'Get a new code');
        b.addEventListener('click', startPair);
        const c = h('button.btn', { type: 'button' }, 'Close');
        c.addEventListener('click', cancelPair);
        return [h('p.hint', null, 'This code expired. Codes last 2 minutes so nobody else can use them.'), codeEl, err, h('div.btns', null, b, c)];
      }
      const s = left();
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 50 50');
      svg.setAttribute('aria-hidden', 'true');
      const tr = document.createElementNS(SVG_NS, 'circle');
      for (const [k, v] of Object.entries({ class: 'tr', cx: 25, cy: 25, r: 22 })) tr.setAttribute(k, v);
      ringEl = document.createElementNS(SVG_NS, 'circle');
      for (const [k, v] of Object.entries({ class: 'pr', cx: 25, cy: 25, r: 22, 'stroke-dasharray': RING.toFixed(1), 'stroke-dashoffset': (RING * (1 - s / 120)).toFixed(1) })) ringEl.setAttribute(k, v);
      svg.append(tr, ringEl);
      leftEl = h('b.num', null, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      const nb = h('button.btn.btn-sm', { type: 'button', 'data-focus': '' }, 'New code');
      nb.addEventListener('click', startPair);
      const cb = h('button.btn.btn-sm.btn-quiet', { type: 'button' }, 'Cancel');
      cb.addEventListener('click', cancelPair);
      const cp = h('button.btn.btn-sm', { type: 'button' }, 'Copy');
      cp.addEventListener('click', async () => shell.toast(await copyCode()));
      return [
        h('p.hint', null, 'Type this code on the other computer, in OmniDesk → Connection → Type a code.'),
        codeEl,
        h('div.cd', null, svg, h('div', null, leftEl, h('div.hint', null, 'until this code expires'))),
        err,
        h('div.btns', null, nb, cp, cb),
      ];
    }

    function renderEnter() {
      const nodes = [h('p.hint', null, 'Pairing from this side? Pick the computer that shows a code, then type its 6 digits.')];
      if (paired) {
        nodes.push(h('p.ok-msg', { role: 'status' }, icon('check'), `Paired with ${paired}. It now shows up under Link per device.`));
      }
      if (!found.length) {
        nodes.push(h('div.searching', { role: 'status' }, h('i', { 'aria-hidden': 'true' }),
          h('span', null, 'Looking for computers… Open OmniDesk on the other computer and keep it on the same network or cable.')));
      } else {
        const ul = h('ul.found', { role: 'radiogroup', 'aria-label': 'Computers nearby' });
        found.forEach((d, i) => {
          const on = pick === d.id;
          const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on || (!pick && i === 0) ? '0' : '-1' },
            device(kindOf(d), { size: 56 }),
            h('span', null, h('b', null, d.name), h('small', null, `${osLabel(d)} · ${d.link ? LINK_LABELS[d.link.type] : 'nearby'}`)),
            h('span.tick', { 'aria-hidden': 'true' }, icon('check')));
          b.addEventListener('click', () => { pick = d.id; enterErr = ''; renderPair(); const inp = pairBody.querySelector('input'); if (inp) inp.focus(); });
          b.addEventListener('keydown', (e) => {
            const k = e.key;
            if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
            e.preventDefault();
            const n = found[(i + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : found.length - 1)) % found.length];
            pick = n.id; renderPair();
            const t = pairBody.querySelector('.found button[aria-checked="true"]');
            if (t) t.focus();
          });
          ul.append(h('li', null, b));
        });
        nodes.push(ul);
      }
      const inp = h('input.input.codein', {
        type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '••••••',
        id: 'conn-code', 'aria-invalid': enterErr ? 'true' : null, 'aria-describedby': enterErr ? 'conn-code-err' : null,
        disabled: !found.length || busy,
      });
      inp.value = codeVal;
      inp.addEventListener('input', () => {
        const v = inp.value.replace(/\D/g, '').slice(0, 6);
        if (v !== inp.value) inp.value = v;
        codeVal = v;
        if (enterErr) { enterErr = ''; inp.removeAttribute('aria-invalid'); const e = pairBody.querySelector('#conn-code-err'); if (e) e.remove(); }
      });
      const go = h('button.btn.btn-primary', { type: 'submit', disabled: !found.length || busy }, busy ? 'Pairing…' : 'Pair');
      nodes.push(h('form', { novalidate: '' },
        h('div.field', null, h('label', { for: 'conn-code' }, 'Code from the other computer'), inp,
          enterErr ? h('p.err', { id: 'conn-code-err', role: 'alert' }, enterErr) : null),
        h('div.btns', null, go)));
      nodes[nodes.length - 1].addEventListener('submit', submitCode);
      return nodes;
    }

    function renderPair() {
      pairBody.replaceChildren(...(mode === 'show' ? renderShow() : renderEnter()).filter(Boolean));
    }

    /* ---------- link rows ---------- */
    const rows = new Map();
    const linkBusy = new Set();
    const rowSig = (d) => JSON.stringify([d.name, d.online, d.thisDevice, d.os, d.link && d.link.available, !!d.battery, d.online ? null : ago(d.lastSeen), !!d.link]);

    function buildRow(d) {
      const off = !d.online;
      const refs = {};
      let hint, pill, ctl = null;
      if (d.thisDevice) {
        hint = h('div.hint', null, `This computer · ${d.link ? LINK_LABELS[d.link.type] : 'No network'}`);
        pill = h('span.pill', null, h('i.dot-good', { 'aria-hidden': 'true' }), 'This device');
      } else if (off || !d.link) {
        hint = h('div.hint', null, `Offline · last seen ${ago(d.lastSeen)}`);
        pill = h('span.pill', null, h('i.dot-off', { 'aria-hidden': 'true' }), 'Offline');
      } else {
        refs.type = h('span');
        refs.ping = h('span.num');
        hint = h('div.hint', null, refs.type, ' · ', refs.ping, ' ms');
        pill = h('span.pill', null, h('i.dot-good', { 'aria-hidden': 'true' }), 'Connected');
        const seg = h('div.seg', { role: 'group', 'aria-label': `${d.name} link` });
        refs.btns = {};
        for (const t of LINK_ORDER.filter((x) => d.link.available.includes(x))) {
          const b = h('button', { type: 'button', 'aria-pressed': 'false' }, icon(LINK_ICONS[t]), LINK_LABELS[t]);
          b.addEventListener('click', () => setLink(d.id, t));
          refs.btns[t] = b;
          seg.append(b);
        }
        refs.err = h('p.err', { role: 'alert', hidden: true });
        ctl = [h('div.ctl', null, seg), refs.err];
      }
      const el = h('div.linkrow', null,
        device(kindOf(d), { size: 62, state: off ? 'offline' : 'online' }),
        h('div', null, h('b', null, d.name), hint), pill, ctl);
      return { el, refs, sig: rowSig(d) };
    }

    function liveRow(r, d) {
      if (!r.refs.ping || !d.link) return;
      setText(r.refs.type, LINK_LABELS[d.link.type]);
      setText(r.refs.ping, d.link.pingMs == null ? '—' : d.link.pingMs);
      for (const [t, b] of Object.entries(r.refs.btns)) b.setAttribute('aria-pressed', String(t === d.link.type));
    }

    async function setLink(id, type) {
      const d = devices.find((x) => x.id === id);
      if (!d || !d.link || d.link.type === type || linkBusy.has(id)) return;
      const r = rows.get(id);
      linkBusy.add(id);
      if (r) { r.refs.err.hidden = true; for (const [t, b] of Object.entries(r.refs.btns)) b.setAttribute('aria-pressed', String(t === type)); }
      try {
        await api.connection.setLink(id, type);
        if (alive) shell.toast(`${d.name} now uses ${LINK_LABELS[type]}`);
      } catch (e) {
        if (!alive) return;
        const rr = rows.get(id);
        if (rr) {
          rr.refs.err.textContent = errText(e);
          rr.refs.err.hidden = false;
          const cur = devices.find((x) => x.id === id);
          if (cur) liveRow(rr, cur);
        }
      } finally {
        linkBusy.delete(id);
      }
    }

    function renderLinks() {
      const seen = new Set();
      let prev = null;
      for (const d of devices) {
        seen.add(d.id);
        let r = rows.get(d.id);
        const sig = rowSig(d);
        if (!r || r.sig !== sig) {
          const n = buildRow(d);
          if (r) r.el.replaceWith(n.el);
          rows.set(d.id, n);
          r = n;
        }
        const want = prev ? prev.nextSibling : linkList.firstChild;
        if (want !== r.el) linkList.insertBefore(r.el, want);
        prev = r.el;
        if (!linkBusy.has(d.id)) liveRow(r, d);
      }
      for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
      if (devices.length && devices.every((d) => d.thisDevice)) {
        if (!linkList.querySelector('.empty-state')) {
          linkList.append(h('div.empty-state', null, h('b', null, 'No other computers yet'), h('p', null, 'Pair one on the left and its link shows up here.')));
        }
      } else {
        const es = linkList.querySelector('.empty-state');
        if (es) es.remove();
      }
    }

    function renderHeader() {
      sFound.set(found.length, found.length === 1 ? 'computer' : 'computers');
      const peer = devices.find((d) => !d.thisDevice && d.online && d.link);
      if (peer) {
        setText(sLink.dt, `${peer.name} link`);
        sLink.set(LINK_LABELS[peer.link.type]);
        sPing.set(peer.link.pingMs == null ? '—' : peer.link.pingMs, 'ms');
      } else {
        setText(sLink.dt, 'Link');
        sLink.set('Not connected');
        sPing.set('—', '');
      }
      setText(kick.lastChild, found.length ? `${found.length} found` : 'Searching');
      sc.update({ devices: [...devices.filter((d) => !d.thisDevice), ...found] });
    }

    renderPair();

    offs.push(api.devices.on((list) => {
      if (!alive || !Array.isArray(list)) return;
      devices = list;
      renderLinks();
      renderHeader();
    }));
    offs.push(api.connection.onFound((list) => {
      if (!alive || !Array.isArray(list)) return;
      const had = found.map((d) => d.id).join();
      found = list;
      if (pick && !found.some((d) => d.id === pick)) pick = null;
      renderHeader();
      if (mode === 'enter' && had !== found.map((d) => d.id).join() && !busy) {
        const active = document.activeElement;
        const inPair = pairBody.contains(active);
        const wasInput = inPair && active.tagName === 'INPUT';
        renderPair();
        if (wasInput) { const i = pairBody.querySelector('input'); if (i) i.focus(); }
      }
    }));

    if (shell.registerCommands) {
      shell.registerCommands([{
        id: 'connection.show-code', title: 'Show a new pairing code', keywords: 'pair add device code join', group: 'connection', icon: 'connection', accent: 'var(--c-conn)',
        run: async () => { setMode('show'); await startPair(); return pair ? 'Pairing code ready' : pairErr || null; },
      }]);
    }

    const ageTimer = setInterval(() => { if (devices.length) renderLinks(); }, 30000);

    return () => {
      alive = false;
      stopCountdown();
      clearInterval(ageTimer);
      unregisterCopy();
      for (const off of offs) { try { off(); } catch (_) { /* gone */ } }
      if (pair && !expired) api.connection.pairCancel().catch(() => {});
      sc.stop();
    };
  },
};
