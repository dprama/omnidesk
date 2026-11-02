// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Mouse & keyboard: one pointer across computers. Live screen map with the real cursor,
// the sharing switch, crossing timings, the always-on button rule, the cursor lock and a
// "Why didn't it cross?" log that explains every edge decision in plain words.

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene } from '../art/index.js';

const css = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) el.style.removeProperty(k); else el.style.setProperty(k, String(v));
  }
  return el;
};
const errText = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong. Try again.';
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const MAX_LINES = 200;

/* ---------- decision lines ---------- */

// "12:04:31 no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[..][..]"
export function parseDecision(line) {
  const m = /^(\d{1,2}:\d{2}:\d{2})\s+(no-cross|cross)\b\s*(.*)$/.exec(String(line));
  if (!m) return { ts: '', kind: 'other', rest: String(line), kv: {} };
  const kv = {};
  const re = /(\w[\w-]*)=(.*?)(?=\s+\w[\w-]*=|\s*$)/g;
  let x;
  while ((x = re.exec(m[3]))) kv[x[1]] = x[2];
  return { ts: m[1], kind: m[2], rest: m[3], kv };
}

function posText(kv) {
  const p = /\((-?\d+),\s*(-?\d+)\)/.exec(kv.pos || '');
  return p ? ` at ${p[1]}, ${p[2]}` : '';
}

export function explainDecision(d, cfg) {
  const kv = d.kv || {};
  const edge = kv.edge ? `the ${kv.edge} edge${posText(kv)}` : 'the edge';
  const cool = cfg && Number.isFinite(cfg.cooldownMs) ? `${cfg.cooldownMs} ms` : 'a moment';
  const guard = cfg && Number.isFinite(cfg.arrivalGuardMs) ? `${cfg.arrivalGuardMs} ms` : 'a moment';
  const hot = (cfg && cfg.lockHotkey) || 'the lock hotkey';
  if (d.kind === 'cross') {
    return `Crossed to ${kv.to || 'the other computer'} at ${edge}. It waits ${kv.cooldown || cool} before it can cross again.`;
  }
  if (d.kind !== 'no-cross') return 'Engine note.';
  switch (kv.reason) {
    case 'not-outer-edge': return `Stayed: another monitor continues past ${edge}, so the cursor just moved onto it. Only outer edges cross.`;
    case 'outside-zone': return `Stayed: this part of ${edge} doesn't touch the other computer's screen. Only the glowing stretch crosses.`;
    case 'button-held': return `Stayed: a mouse button was held at ${edge}. Drags and selections never cross, so nothing gets dropped on the wrong computer.`;
    case 'cooldown': return `Stayed: it had just crossed. After every crossing it waits ${cool} before it crosses again${kv.remaining ? ` (${kv.remaining} were left)` : ''}, so it can't bounce at ${edge}.`;
    case 'arrival-guard': return `Stayed: the cursor had only just arrived through ${edge}. The ${guard} arrival guard ignores that edge for a moment.`;
    case 'locked': return `Stayed: the cursor is locked to this computer. Press ${hot} or use the switch to unlock it.`;
    case 'sharing-off': return `Stayed: mouse and keyboard sharing is off.`;
    case 'no-neighbour': return `Stayed: no connected computer is beside ${edge}. Check that it's online and placed there in Screen layout.`;
    default: return `Stayed at ${edge}${kv.reason ? ` (${kv.reason})` : ''}.`;
  }
}

/* ---------- small builders ---------- */

function switchEl(label, big) {
  return h('button.switch' + (big ? '.big' : ''), { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label });
}
function stat(label, valueEl) {
  return h('div', null, h('dt', null, label), h('dd', null, valueEl));
}
function keys(combo) {
  const parts = String(combo || '').split('+').filter(Boolean);
  const out = [];
  parts.forEach((k, i) => { if (i) out.push(' + '); out.push(h('kbd', null, k)); });
  return out;
}

/* ---------- page ---------- */

export default {
  id: 'mouse', label: 'Mouse & keyboard', tab: 'Mouse', group: 'share',
  accent: 'var(--c-mouse)', icon: 'mouse',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); return t; };

    const S = {
      cfg: null, status: null, devices: [], layout: null,
      cursor: null, busy: new Set(),
    };

    /* ----- header ----- */
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), h('span', null, 'Loading'));
    const vSharing = h('span', null, '…');
    const vOn = h('span', null, '…');
    const vEdge = h('span', null, '…');
    const sceneHost = h('div.lh-scene');
    css(sceneHost, { height: '150px' });
    const header = h('header.lh', null,
      h('div', null,
        kick,
        h('h1', null, 'Mouse & keyboard'),
        h('p.sub', null, 'One pointer and one keyboard for every computer. The cursor crosses only at the outer edge of your monitors, never between two screens of the same computer.'),
        h('dl.stats', null, stat('Sharing', vSharing), stat('Cursor on', vOn), stat('Crosses at', vEdge))),
      sceneHost);

    /* ----- peer note (empty / offline) ----- */
    const peerNote = h('div.note', { hidden: true });
    css(peerNote, { 'margin-bottom': '16px' });

    /* ----- sharing card ----- */
    const swShare = switchEl('Share mouse and keyboard', true);
    const shareDesc = h('div.d', null, ' ');
    const swLock = switchEl('Lock cursor to this screen');
    const hotkey = h('span');
    const shareErr = h('p.err', { role: 'alert', hidden: true });
    const r0 = h('div.row', null, h('div', null, h('b', null, 'Share mouse & keyboard'), shareDesc), swShare);
    css(r0, { 'padding-top': '0' });
    const cardShare = h('section.card', null,
      r0,
      h('div.row', null,
        h('div', null, h('b', null, 'Lock cursor to this screen'),
          h('div.d', null, 'Hotkey ', hotkey, '. Works anywhere, even in full-screen games.')),
        swLock),
      shareErr);

    /* ----- crossing card ----- */
    function sliderRow(label, key, max, step, endL, endR, help) {
      const out = h('span.num', null, '…');
      const input = h('input.slider', { type: 'range', min: '0', max: String(max), step: String(step), 'aria-label': label + ' in milliseconds' });
      const head = h('div', null, h('b', null, label), h('span', null, out, h('span.u', null, 'ms')));
      css(head, { display: 'flex', 'justify-content': 'space-between', gap: '10px', 'align-items': 'baseline' });
      const row = h('div.row', null, head, input, h('div.range-l', null, h('span', null, endL), h('span', null, endR)), help ? h('div.d', null, help) : null);
      css(row, { display: 'block' });
      return { row, input, out, key };
    }
    const cool = sliderRow('Cooldown after crossing', 'cooldownMs', 1000, 50, 'Instant', '1 s',
      'How long the cursor waits after crossing before it may cross again.');
    const guard = sliderRow('Arrival guard', 'arrivalGuardMs', 500, 25, 'Off', '500 ms',
      'Right after arriving, ignores the edge the cursor came in through, so it doesn\'t bounce straight back.');
    css(cool.row, { 'padding-top': '4px' });
    const ruleLeft = h('div', null, icon('lock', 'icon'),
      h('div', null, h('b', null, 'Don\'t cross while a button is held'),
        h('div.d', null, 'Always on. Drags, selections and window moves stay on one computer.')));
    css(ruleLeft, { display: 'flex', gap: '10px', 'align-items': 'flex-start' });
    css(ruleLeft.firstChild, { 'margin-top': '3px', color: 'var(--a)' });
    const crossErr = h('p.err', { role: 'alert', hidden: true });
    const cardCross = h('section.card', null,
      h('h2', null, 'Crossing'),
      cool.row, guard.row,
      h('div.row', null, ruleLeft, h('span.chip', null, h('i', { 'aria-hidden': 'true' }), 'Always on')),
      crossErr);

    /* ----- log card ----- */
    const logBox = h('div.log', {
      role: 'listbox', tabindex: '0', 'aria-label': 'Crossing decisions, newest last. Use the arrow keys to read why.',
    });
    css(logBox, { 'max-height': '330px', 'min-height': '160px' });
    const logEmpty = h('div', { role: 'option', 'aria-disabled': 'true' }, 'Waiting for the cursor to reach an edge…');
    css(logEmpty, { color: 'var(--ink-3)', 'font-family': 'var(--font)' });
    logBox.append(logEmpty);
    const why = h('p.hint', { 'aria-live': 'off' }, 'Point at a line, or focus the log and use the arrow keys, to see why in plain words.');
    css(why, { 'min-height': '3.2em', 'margin-top': '10px' });
    const counts = h('div.chips');
    css(counts, { 'margin-top': '10px' });
    const cxCount = h('span.chip', null, h('i', { 'aria-hidden': 'true' }), '0 crossed');
    css(cxCount, { '--c': 'var(--good)' });
    const ncCount = h('span.chip', null, h('i', { 'aria-hidden': 'true' }), '0 stayed');
    css(ncCount, { '--c': 'var(--warn)' });
    counts.append(cxCount, ncCount);
    const cardLog = h('section.card', null,
      h('h2', null, 'Why didn\'t it cross?'),
      h('p.hint', null, 'Every edge decision, newest at the bottom. Green crossed, amber stayed.'),
      counts,
      h('div', null, logBox),
      why);
    css(logBox.parentNode, { 'margin-top': '12px' });

    const left = h('div.stack-v', null, cardShare, cardCross);
    el.replaceChildren(header, peerNote, h('div.grid-2', null, left, cardLog));

    /* ----- scene ----- */
    let sc = null;
    try { sc = scene('screen-map', sceneHost, { accent: 'var(--c-mouse)', reducedMotion: shell.reducedMotion }); }
    catch (e) { console.warn('[mouse] scene', e); }

    /* ----- derived ----- */
    const devById = (id) => S.devices.find((d) => d.id === id) || null;
    const thisDev = () => S.devices.find((d) => d.thisDevice || d.id === 'this') || null;
    const nameOf = (id) => (devById(id) || {}).name || (id === 'this' ? 'This computer' : 'Other computer');

    // The device across this computer's outer edge, and which edge, from layout.get().edges.
    function crossing() {
      const me = thisDev();
      const myId = me ? me.id : 'this';
      const edges = (S.layout && S.layout.edges) || [];
      const mine = edges.filter((e) => e.from === myId);
      const on = mine.filter((e) => { const d = devById(e.to); return d && d.online; });
      const pick = (list) => list.slice().sort((a, b) => {
        const ca = S.cursor && S.cursor.deviceId === a.to ? 1 : 0, cb = S.cursor && S.cursor.deviceId === b.to ? 1 : 0;
        return cb - ca || (b.overlapPx || 0) - (a.overlapPx || 0);
      })[0] || null;
      return { edge: pick(on) || null, offlineEdge: on.length ? null : pick(mine), any: mine.length > 0 };
    }

    function monitorOnEdge(screens, side) {
      if (!screens || !screens.length) return null;
      const val = (r) => (side === 'right' ? r.x + r.w : side === 'left' ? -r.x : side === 'bottom' ? r.y + r.h : -r.y);
      let best = 0;
      screens.forEach((r, i) => { if (val(r) > val(screens[best])) best = i; });
      return best + 1;
    }

    function renderHeader() {
      const cfg = S.cfg;
      const on = cfg ? !!cfg.enabled : !!(S.status && S.status.mouse);
      const locked = !!(cfg && cfg.locked);
      setText(kick.lastChild, !cfg && !S.status ? 'Loading' : !on ? 'Off' : locked ? 'Locked here' : 'Sharing');
      vSharing.replaceChildren(h('span', { class: on ? 'good' : 'muted' }, on ? (locked ? 'On, locked' : 'On') : 'Off'));
      const cOn = (S.cursor && S.cursor.deviceId) || (S.status && S.status.cursorOn) || 'this';
      setText(vOn, nameOf(cOn));
      const c = crossing();
      const me = thisDev();
      if (c.edge) {
        const n = me && me.screens && me.screens.length > 1 ? `Monitor ${monitorOnEdge(me.screens, c.edge.fromEdge)}, ` : '';
        setText(vEdge, `${n}${c.edge.fromEdge} → ${nameOf(c.edge.to)}`);
      } else if (c.offlineEdge) setText(vEdge, `${cap(c.offlineEdge.fromEdge)} edge (${nameOf(c.offlineEdge.to)} offline)`);
      else setText(vEdge, S.layout ? 'Nowhere yet' : '…');
    }

    let sceneKey = '';
    function renderScene() {
      if (!sc) return;
      const me = thisDev();
      const c = crossing();
      const peer = c.edge ? devById(c.edge.to) : null;
      const key = JSON.stringify([me && me.screens, peer && peer.id, peer && peer.screens, c.edge && c.edge.fromEdge, me && me.name, peer && peer.name]);
      if (key !== sceneKey) {
        sceneKey = key;
        sc.update({
          screens: { this: (me && me.screens) || [], peer: (peer && peer.screens) || [] },
          crossingEdge: (c.edge && c.edge.fromEdge) || 'right',
          names: { this: (me && me.name) || 'This computer', peer: (peer && peer.name) || '' },
        });
      }
      const cur = S.cursor;
      const myId = me ? me.id : 'this';
      if (!cur) return;
      if (cur.deviceId === myId) sc.update({ cursor: { deviceId: 'this', x: cur.x, y: cur.y } });
      else if (peer && cur.deviceId === peer.id) sc.update({ cursor: { deviceId: peer.id, x: cur.x, y: cur.y } });
      else sc.update({ cursor: null });
    }

    function renderPeerNote() {
      const peers = S.devices.filter((d) => !d.thisDevice && d.paired);
      const c = crossing();
      let msg = null, btn = null;
      if (!S.devices.length) { peerNote.hidden = true; return; }
      if (!peers.length) {
        msg = [h('b', null, 'No other computer yet.'), ' Pair one and the cursor can cross to it at the outer edge.'];
        btn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => shell.go('connection') }, icon('plus'), 'Pair a computer');
      } else if (!c.edge && c.offlineEdge) {
        msg = [h('b', null, `${nameOf(c.offlineEdge.to)} is offline.`), ' The cursor stays on this computer until it\'s back.'];
      } else if (!c.edge && S.layout) {
        msg = [h('b', null, 'No crossing edge.'), ' No online computer touches an outer edge of this one.'];
        btn = h('button.btn.btn-sm', { type: 'button', onclick: () => shell.go('layout') }, icon('layout'), 'Open Screen layout');
      }
      if (!msg) { peerNote.hidden = true; return; }
      const p = h('p', null, ...msg);
      const box = h('div', null, p, btn ? h('div.btns', null, btn) : null);
      if (btn) css(box.lastChild, { 'margin-top': '10px' });
      peerNote.replaceChildren(icon(peers.length ? 'alert' : 'devices'), box);
      peerNote.hidden = false;
    }

    function renderControls() {
      const cfg = S.cfg;
      const disabled = !cfg;
      swShare.setAttribute('aria-checked', String(!!(cfg && cfg.enabled)));
      swLock.setAttribute('aria-checked', String(!!(cfg && cfg.locked)));
      swShare.disabled = disabled || S.busy.has('enabled');
      swLock.disabled = disabled || S.busy.has('locked');
      const peers = S.devices.filter((d) => !d.thisDevice && d.paired);
      const peerName = (crossing().edge && nameOf(crossing().edge.to)) || (peers[0] && peers[0].name) || 'the other computer';
      setText(shareDesc, cfg && cfg.enabled
        ? `Move past the outer edge to control ${peerName} from here.`
        : 'Off. The cursor and keyboard stay on this computer.');
      hotkey.replaceChildren(...keys(cfg ? cfg.lockHotkey : '…'));
      for (const s of [cool, guard]) {
        s.input.disabled = disabled;
        if (cfg && document.activeElement !== s.input && !s.dragging) s.input.value = String(cfg[s.key]);
        const v = s.dragging || document.activeElement === s.input ? s.input.value : (cfg ? cfg[s.key] : '…');
        setText(s.out, v);
        s.input.setAttribute('aria-valuetext', `${s.input.value} milliseconds`);
      }
    }

    function renderAll() { renderHeader(); renderScene(); renderPeerNote(); renderControls(); }

    /* ----- setters ----- */
    function showErr(p, e) { p.textContent = errText(e); p.hidden = false; }
    async function setPatch(patch, errEl, busyKey) {
      if (busyKey) S.busy.add(busyKey);
      errEl.hidden = true;
      renderControls();
      try {
        const r = await api.mouse.set(patch);
        if (!alive) return;
        S.cfg = r || { ...S.cfg, ...patch };
      } catch (e) {
        if (!alive) return;
        showErr(errEl, e);
      } finally {
        if (alive) { if (busyKey) S.busy.delete(busyKey); renderAll(); }
      }
    }

    swShare.addEventListener('click', () => {
      if (!S.cfg) return;
      const v = !S.cfg.enabled;
      swShare.setAttribute('aria-checked', String(v));
      setPatch({ enabled: v }, shareErr, 'enabled').then(() => {
        if (alive && S.cfg && S.cfg.enabled === v) shell.toast(v ? 'Mouse sharing is on' : 'Mouse sharing is off');
      });
    });
    swLock.addEventListener('click', () => {
      if (!S.cfg) return;
      const v = !S.cfg.locked;
      swLock.setAttribute('aria-checked', String(v));
      setPatch({ locked: v }, shareErr, 'locked').then(() => {
        if (alive && S.cfg && S.cfg.locked === v) shell.toast(v ? 'Cursor locked to this screen' : 'Cursor unlocked');
      });
    });
    for (const s of [cool, guard]) {
      s.input.addEventListener('input', () => {
        s.dragging = true;
        setText(s.out, s.input.value);
        s.input.setAttribute('aria-valuetext', `${s.input.value} milliseconds`);
      });
      s.input.addEventListener('change', () => {
        s.dragging = false;
        const v = Math.round(Number(s.input.value));
        if (!S.cfg || S.cfg[s.key] === v) return;
        setPatch({ [s.key]: v }, crossErr);
      });
      s.input.addEventListener('blur', () => { s.dragging = false; renderControls(); });
    }

    /* ----- log ----- */
    let lines = [];        // { el, d, text }
    let active = -1;
    let seq = 0;
    let nCross = 0, nStay = 0;
    const logId = 'mlog-' + Math.random().toString(36).slice(2, 7);

    function explainAt(i, latest) {
      const L = lines[i];
      if (!L) return;
      setText(why, (latest ? 'Latest: ' : '') + explainDecision(L.d, S.cfg));
    }
    let hovering = false;
    function setActive(i) {
      if (active >= 0 && lines[active]) { css(lines[active].el, { background: null, 'box-shadow': null }); lines[active].el.setAttribute('aria-selected', 'false'); }
      active = i;
      const L = lines[i];
      if (!L) { logBox.removeAttribute('aria-activedescendant'); return; }
      L.el.setAttribute('aria-selected', 'true');
      css(L.el, { background: 'color-mix(in oklab, var(--a) 16%, transparent)', 'box-shadow': 'inset 2px 0 0 var(--a)' });
      logBox.setAttribute('aria-activedescendant', L.el.id);
      // keep it in view without scrolling the page
      const top = L.el.offsetTop, bottom = top + L.el.offsetHeight;
      if (top < logBox.scrollTop) logBox.scrollTop = top - 8;
      else if (bottom > logBox.scrollTop + logBox.clientHeight) logBox.scrollTop = bottom - logBox.clientHeight + 8;
      explainAt(i);
    }

    function addLine(text) {
      const d = parseDecision(text);
      const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
      if (logEmpty.parentNode) logEmpty.remove();
      const kindCls = d.kind === 'cross' ? 'ok' : d.kind === 'no-cross' ? 'no' : '';
      const row = h('div', { role: 'option', id: `${logId}-${++seq}`, 'aria-selected': 'false' },
        d.ts ? h('span.ts', null, d.ts) : null, d.ts ? ' ' : null,
        d.kind !== 'other' ? h('span', { class: kindCls }, d.kind) : null,
        d.kind !== 'other' ? ' ' + d.rest : d.rest);
      css(row, { 'border-radius': '6px', padding: '0 6px', margin: '0 -6px', cursor: 'default', width: 'max-content', 'min-width': 'calc(100% + 12px)' });
      row.title = explainDecision(d, S.cfg);
      const L = { el: row, d, text };
      lines.push(L);
      logBox.append(row);
      if (d.kind === 'cross') nCross++; else if (d.kind === 'no-cross') nStay++;
      if (lines.length > MAX_LINES) {
        const gone = lines.splice(0, lines.length - MAX_LINES);
        gone.forEach((g) => g.el.remove());
        if (active >= 0) active = Math.max(-1, active - gone.length);
      }
      setText(cxCount.lastChild, `${nCross} crossed`);
      setText(ncCount.lastChild, `${nStay} stayed`);
      if (atBottom) logBox.scrollTop = logBox.scrollHeight;
      if (active < 0 && !hovering) explainAt(lines.length - 1, true);
    }

    logBox.addEventListener('mouseover', (e) => {
      const row = e.target.closest('[role="option"]');
      const i = lines.findIndex((L) => L.el === row);
      if (i >= 0) { hovering = true; explainAt(i); }
    });
    logBox.addEventListener('mouseleave', () => {
      hovering = false;
      if (active >= 0) explainAt(active); else if (lines.length) explainAt(lines.length - 1, true);
    });
    logBox.addEventListener('click', (e) => {
      const row = e.target.closest('[role="option"]');
      const i = lines.findIndex((L) => L.el === row);
      if (i >= 0) setActive(i);
    });
    logBox.addEventListener('blur', () => { why.setAttribute('aria-live', 'off'); setActive(-1); if (lines.length) explainAt(lines.length - 1, true); });
    logBox.addEventListener('focus', () => {
      why.setAttribute('aria-live', 'polite'); if (lines.length && (active < 0 || !lines[active])) setActive(lines.length - 1); });
    logBox.addEventListener('keydown', (e) => {
      if (!lines.length) return;
      let i = active < 0 ? lines.length - 1 : active;
      if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowDown') i = Math.min(lines.length - 1, i + 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = lines.length - 1;
      else if (e.key === 'PageUp') i = Math.max(0, i - 8);
      else if (e.key === 'PageDown') i = Math.min(lines.length - 1, i + 8);
      else return;
      e.preventDefault();
      setActive(i);
    });

    /* ----- data ----- */
    let refetchT = null;
    function refetchCfg() {
      if (refetchT) return;
      refetchT = later(async () => {
        refetchT = null;
        try {
          const c = await api.mouse.get();
          if (!alive || S.busy.size) return;
          const changed = JSON.stringify(c) !== JSON.stringify(S.cfg);
          S.cfg = c;
          if (changed) { renderHeader(); renderControls(); }
        } catch (_) { /* keep the last value */ }
      }, 250);
    }

    const sub = (fn) => { try { const off = fn(); if (typeof off === 'function') offs.push(off); } catch (e) { console.warn('[mouse]', e); } };
    sub(() => api.status.on((s) => {
      if (!alive) return;
      S.status = s;
      renderHeader();
      refetchCfg();
    }));
    sub(() => api.devices.on((list) => {
      if (!alive) return;
      S.devices = Array.isArray(list) ? list : [];
      renderAll();
    }));
    let curPending = null, curRaf = 0;
    sub(() => api.mouse.onCursor((c) => {
      if (!alive || !c) return;
      curPending = c;
      if (curRaf) return;
      curRaf = requestAnimationFrame(() => {
        curRaf = 0;
        if (!alive || !curPending) return;
        const prevDev = S.cursor && S.cursor.deviceId;
        S.cursor = curPending; curPending = null;
        renderScene();
        if (prevDev !== S.cursor.deviceId) renderHeader();
      });
    }));
    sub(() => api.mouse.onDecision((line) => { if (alive && typeof line === 'string') addLine(line); }));

    (async () => {
      try { S.cfg = await api.mouse.get(); } catch (e) { if (alive) showErr(shareErr, e); }
      try { S.layout = await api.layout.get(); } catch (_) { S.layout = { placements: {}, edges: [] }; }
      if (alive) renderAll();
    })();

    renderAll();

    return () => {
      alive = false;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      timers.forEach((t) => clearTimeout(t)); timers.clear();
      if (curRaf) cancelAnimationFrame(curRaf);
      if (sc) { sc.stop(); sc = null; }
    };
  },
};
