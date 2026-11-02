// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Screen layout: drag the computers (each one tile, all its monitors inside) to match the
// desk. Tiles snap edge to edge; the glowing lines are the crossing edges main computed
// (layout.get().edges, outer edges only). Every drop saves with layout.set.

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { device } from '../art/index.js';

const css = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) el.style.removeProperty(k); else el.style.setProperty(k, String(v));
  }
  return el;
};
const errText = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong. Try again.';
const OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const SNAP = 2;
const MAX_H = 360;

/* ---------- geometry ---------- */

const bbox = (rs) => {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
// A placement is where the device's monitor bounding box starts (main's engine/config.js
// placeDevice). Screens come in desktop coords, which can be negative (a monitor left of or
// above the primary), so shift them to start at 0,0; then placement + screen = layout coords.
export function placeable(d) {
  if (!d || !Array.isArray(d.screens) || !d.screens.length) return d;
  const b = bbox(d.screens);
  if (!b.x && !b.y) return d;
  return { ...d, screens: d.screens.map((s) => ({ ...s, x: s.x - b.x, y: s.y - b.y })) };
}
const absRects = (d, p) => (d.screens || []).map((s, i) => ({ i, x: s.x + p.x, y: s.y + p.y, w: s.w, h: s.h }));
const overlaps = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
function sideOf(r, side) {
  switch (side) {
    case 'left': return { line: r.x, a: r.y, b: r.y + r.h };
    case 'right': return { line: r.x + r.w, a: r.y, b: r.y + r.h };
    case 'top': return { line: r.y, a: r.x, b: r.x + r.w };
    default: return { line: r.y + r.h, a: r.x, b: r.x + r.w };
  }
}
function subtract(ivs, cut) {
  const out = [];
  for (const [a, b] of ivs) {
    if (cut[1] <= a || cut[0] >= b) { out.push([a, b]); continue; }
    if (cut[0] > a) out.push([a, cut[0]]);
    if (cut[1] < b) out.push([cut[1], b]);
  }
  return out;
}
// Drawn stretches of an edge main reported: where A's outer side touches B.
export function edgeSegments(A, pa, side, B, pb) {
  const ra = absRects(A, pa), rb = absRects(B, pb);
  const out = [];
  for (const r of ra) {
    const s = sideOf(r, side);
    let outer = [[s.a, s.b]];
    for (const o of ra) {
      if (o === r) continue;
      const t = sideOf(o, OPP[side]);
      if (Math.abs(t.line - s.line) <= SNAP) outer = subtract(outer, [t.a, t.b]);
    }
    for (const o of rb) {
      const t = sideOf(o, OPP[side]);
      if (Math.abs(t.line - s.line) > SNAP) continue;
      for (const [a, b] of outer) {
        const lo = Math.max(a, t.a), hi = Math.min(b, t.b);
        if (hi > lo) out.push({ side, line: s.line, a: lo, b: hi, mon: r.i });
      }
    }
  }
  return out;
}

/* ---------- page ---------- */

export default {
  id: 'layout', label: 'Screen layout', tab: 'Layout', group: 'share',
  accent: 'var(--c-layout)', icon: 'layout',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    const timers = new Set();
    const anims = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); return t; };
    const clearLater = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };

    const S = {
      devices: [], saved: null, P: {}, frame: null, scale: 0.05,
      drag: null, kbd: null, sel: null, saving: false, savedAt: null, loadErr: null,
    };

    /* ----- header ----- */
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), h('span', null, 'Arrange'));
    const vPlaced = h('span.num', null, '…');
    const vEdges = h('span.num', null, '…');
    const vSaved = h('span', null, '…');
    const art = h('div.lh-scene.lh-devices', { 'aria-hidden': 'true' });
    const header = h('header.lh', null,
      h('div', null, kick,
        h('h1', null, 'Screen layout'),
        h('p.sub', null, 'Arrange the computers the way they sit on your desk. Tiles snap edge to edge; the glowing edges are where the cursor crosses.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Placed'), h('dd', null, vPlaced, h('span.u', null, 'devices'))),
          h('div', null, h('dt', null, 'Crossing edges'), h('dd', null, vEdges)),
          h('div', null, h('dt', null, 'Saved'), h('dd', null, vSaved)))),
      art);

    /* ----- desk ----- */
    const instrId = 'lay-help-' + Math.random().toString(36).slice(2, 7);
    const desk = h('div', { role: 'group', 'aria-label': 'Desk layout' });
    css(desk, {
      position: 'relative', width: '100%', height: '260px', overflow: 'hidden', 'border-radius': 'var(--r-md)',
      background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,.035), rgba(0,0,0,.18))',
      border: '1px solid var(--line)', 'touch-action': 'none',
    });
    const grid = h('div', { 'aria-hidden': 'true' });
    css(grid, {
      position: 'absolute', inset: '0', 'pointer-events': 'none', opacity: '.5',
      'background-image': 'linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)',
      'background-size': '24px 24px',
    });
    const edgeLayer = h('div', { 'aria-hidden': 'true' });
    css(edgeLayer, { position: 'absolute', inset: '0', 'pointer-events': 'none', 'z-index': '3' });
    desk.append(grid, edgeLayer);

    const help = h('p.hint', { id: instrId }, 'Drag a tile, or focus it and use the arrow keys (Shift for small steps). It snaps and saves when you let go.');
    const placeSeg = h('div.seg', { role: 'group', 'aria-label': 'Place device' });
    const placeLabel = h('span.hint', null, 'Place');
    css(placeLabel, { margin: '0' });
    const resetBtn = h('button.btn.btn-sm', { type: 'button' }, icon('layout'), 'Reset layout');
    const tools = h('div', null, h('div', null, placeLabel, placeSeg), resetBtn);
    css(tools, { display: 'flex', 'flex-wrap': 'wrap', gap: '10px 16px', 'align-items': 'center', 'justify-content': 'space-between', 'margin-top': '14px' });
    css(tools.firstChild, { display: 'flex', 'flex-wrap': 'wrap', gap: '8px 10px', 'align-items': 'center', 'min-width': '0' });
    const err = h('p.err', { role: 'alert', hidden: true });
    const live = h('p.sr-only', { 'aria-live': 'polite' });
    const emptyBox = h('div.empty-state', { hidden: true }, icon('devices'),
      h('b', null, 'Only this computer so far'),
      h('p', null, 'Pair another computer and it appears here, ready to place beside this one.'),
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => shell.go('connection') }, icon('plus'), 'Pair a computer'));
    css(emptyBox, { 'margin-top': '14px' });
    const deskCard = h('section.card', null, desk, help, tools, err, emptyBox, live);
    css(help, { 'margin-top': '12px' });

    /* ----- edges card ----- */
    const edgeList = h('ul');
    css(edgeList, { 'list-style': 'none', margin: '8px 0 0', padding: '0' });
    const edgesCard = h('section.card', null,
      h('h2', null, 'Where the cursor crosses'),
      h('p.hint', null, 'Worked out from the layout. Only outer edges count.'),
      edgeList);
    const rulesNote = h('div.note', null, icon('mouse'),
      h('p', null, 'Only outer edges cross. ',
        h('small', null, 'The edge between two monitors of the same computer never sends the cursor away, and edges that touch nothing do nothing.')));
    const lower = h('div.grid-2', null, edgesCard, h('div', null, rulesNote));
    css(lower, { 'margin-top': '16px' });

    el.replaceChildren(header, deskCard, lower);

    /* ----- helpers ----- */
    const devById = (id) => S.devices.find((d) => d.id === id) || null;
    const thisDev = () => S.devices.find((d) => d.thisDevice || d.id === 'this') || null;
    const placedDevs = () => S.devices.filter((d) => (d.paired !== false) && S.P[d.id] && d.screens && d.screens.length);
    const nameOf = (id) => (devById(id) || {}).name || 'A device';

    function ensurePlacements() {
      // a paired device without a saved spot goes to the right of everything, unsaved
      const placed = S.devices.filter((d) => S.P[d.id] && d.screens && d.screens.length);
      for (const d of S.devices) {
        if (S.P[d.id] || d.paired === false || !d.screens || !d.screens.length) continue;
        const all = bbox(placed.flatMap((x) => absRects(x, S.P[x.id])));
        S.P[d.id] = { x: all.w ? all.x + all.w : 0, y: all.y };
        placed.push(d);
      }
    }

    function computeFrame() {
      const rs = placedDevs().flatMap((d) => absRects(d, S.P[d.id]));
      const b = bbox(rs);
      const m = Math.max(b.w, b.h, 2000) * 0.12;
      S.frame = { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
    }

    function measure() {
      if (!S.frame) return;
      const cw = desk.clientWidth || 600;
      S.scale = Math.min(cw / S.frame.w, MAX_H / S.frame.h);
      css(desk, { height: Math.round(S.frame.h * S.scale) + 'px' });
      // centre the frame horizontally when height-limited
      S.ox = (cw - S.frame.w * S.scale) / 2;
    }
    const px = (x) => S.ox + (x - S.frame.x) * S.scale;
    const py = (y) => (y - S.frame.y) * S.scale;

    /* ----- tiles ----- */
    const tiles = new Map(); // id -> { el, mons: [] , sig }

    function tileLabel(d) {
      const p = S.P[d.id];
      const me = thisDev();
      let where = '';
      if (me && d.id !== me.id && S.P[me.id]) {
        const a = bbox(absRects(d, p)), b = bbox(absRects(me, S.P[me.id]));
        const dx = (a.x + a.w / 2) - (b.x + b.w / 2), dy = (a.y + a.h / 2) - (b.y + b.h / 2);
        where = Math.abs(dx) * b.h > Math.abs(dy) * b.w ? (dx > 0 ? `right of ${me.name}` : `left of ${me.name}`) : (dy > 0 ? `below ${me.name}` : `above ${me.name}`);
      }
      const mons = d.screens.length > 1 ? `, ${d.screens.length} monitors` : '';
      return `${d.name}${d.thisDevice ? ' (this computer)' : ''}${d.online ? '' : ', offline'}${mons}${where ? ', ' + where : ''}`;
    }

    function buildTile(d) {
      const t = h('div', { tabindex: '0', role: 'button', 'aria-roledescription': 'movable device', 'aria-describedby': instrId, 'data-id': d.id });
      css(t, { position: 'absolute', 'z-index': '2', cursor: 'grab', 'border-radius': '8px', 'touch-action': 'none', 'user-select': 'none' });
      const b = bbox(d.screens);
      const mons = d.screens.map((s, i) => {
        const m = h('div');
        css(m, {
          position: 'absolute', 'box-sizing': 'border-box', overflow: 'hidden',
          left: ((s.x - b.x) / b.w * 100).toFixed(3) + '%', top: ((s.y - b.y) / b.h * 100).toFixed(3) + '%',
          width: (s.w / b.w * 100).toFixed(3) + '%', height: (s.h / b.h * 100).toFixed(3) + '%',
          'border-radius': d.os === 'macos' && d.battery ? '7px' : '5px',
          border: '1px solid var(--line-2)', padding: '6px 7px',
          font: '500 11px/1.3 var(--font)', color: 'var(--ink-2)',
          transition: shell.reducedMotion ? null : 'background .25s, border-color .25s',
        });
        const name = h('b', null, i === 0 ? d.name : '');
        css(name, { display: 'block', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'font-weight': '600' });
        const sub = h('span', null, d.screens.length > 1 ? `${i + 1}` : (d.online ? '' : 'Offline'));
        css(sub, { display: 'block', color: 'var(--ink-3)', font: '500 10px/1.3 var(--mono)', 'white-space': 'nowrap' });
        if (i === 0 && d.screens.length > 1) sub.textContent = '1';
        if (i === 0 && !d.online && d.screens.length > 1) sub.textContent = '1 · Offline';
        m.append(name, sub);
        t.append(m);
        return m;
      });
      t.addEventListener('pointerdown', onPointerDown);
      t.addEventListener('keydown', onKey);
      t.addEventListener('focus', () => { S.sel = d.id; renderPlace(); });
      return { el: t, mons, sig: '' };
    }

    function paintTile(d, T) {
      const isThis = d.thisDevice || d.id === 'this';
      const dragging = (S.drag && S.drag.id === d.id && S.drag.moved) || (S.kbd && S.kbd.id === d.id);
      const sig = [d.online, dragging, S.sel === d.id, isThis].join();
      if (T.sig !== sig) {
        T.sig = sig;
        css(T.el, { opacity: d.online ? null : '.5', cursor: dragging ? 'grabbing' : 'grab', 'z-index': dragging ? '4' : '2' });
        for (const m of T.mons) {
          css(m, {
            background: dragging ? 'color-mix(in oklab, var(--a) 18%, rgba(20,24,33,.9))'
              : isThis ? 'color-mix(in oklab, var(--a) 7%, rgba(24,28,38,.92))' : 'rgba(30,34,45,.92)',
            'border-color': dragging ? 'color-mix(in oklab, var(--a) 75%, transparent)'
              : S.sel === d.id ? 'color-mix(in oklab, var(--a) 45%, transparent)' : 'var(--line-2)',
            'border-style': d.online ? 'solid' : 'dashed',
          });
        }
      }
      T.el.setAttribute('aria-label', tileLabel(d));
    }

    function positionTile(d) {
      const T = tiles.get(d.id);
      if (!T || !S.frame) return;
      const b = bbox(absRects(d, S.P[d.id]));
      css(T.el, {
        left: px(b.x).toFixed(1) + 'px', top: py(b.y).toFixed(1) + 'px',
        width: Math.max(8, b.w * S.scale).toFixed(1) + 'px', height: Math.max(8, b.h * S.scale).toFixed(1) + 'px',
      });
      paintTile(d, T);
    }

    function syncTiles() {
      const list = placedDevs();
      const ids = new Set(list.map((d) => d.id));
      for (const [id, T] of tiles) if (!ids.has(id)) { T.el.remove(); tiles.delete(id); }
      for (const d of list) {
        let T = tiles.get(d.id);
        const shape = JSON.stringify([d.screens, d.name, d.online]);
        if (T && T.shape !== shape) {
          const had = document.activeElement === T.el;
          T.el.remove(); tiles.delete(d.id); T = null;
          const N = buildTile(d); N.shape = shape; tiles.set(d.id, N); desk.append(N.el);
          if (had) N.el.focus();
          continue;
        }
        if (!T) { T = buildTile(d); T.shape = shape; tiles.set(d.id, T); desk.append(T.el); }
      }
      for (const d of list) positionTile(d);
    }

    /* ----- edges ----- */
    function savedEdges() { return (S.saved && S.saved.edges) || []; }

    function renderEdges() {
      for (const a of anims) { try { a.cancel(); } catch (_) { /* ignore */ } }
      anims.clear();
      edgeLayer.replaceChildren();
      if (!S.frame || !S.saved) return;
      const moving = (S.drag && S.drag.moved && S.drag.id) || (S.kbd && S.kbd.id) || null;
      const seen = new Set();
      for (const e of savedEdges()) {
        if (moving && (e.from === moving || e.to === moving)) continue;
        const A = devById(e.from), B = devById(e.to);
        if (!A || !B || !S.P[A.id] || !S.P[B.id]) continue;
        for (const s of edgeSegments(A, S.P[A.id], e.fromEdge, B, S.P[B.id])) {
          const vert = s.side === 'left' || s.side === 'right';
          const key = `${vert ? 'v' : 'h'}:${Math.round(s.line)}:${Math.round(s.a)}:${Math.round(s.b)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = h('div');
          const off = B.online && A.online;
          css(line, {
            position: 'absolute', 'border-radius': '3px',
            background: off ? 'var(--a)' : 'var(--ink-4)',
            'box-shadow': off ? '0 0 10px 1px color-mix(in oklab, var(--a) 70%, transparent), 0 0 22px 2px color-mix(in oklab, var(--a) 30%, transparent)' : null,
            left: (vert ? px(s.line) - 1.5 : px(s.a)).toFixed(1) + 'px',
            top: (vert ? py(s.a) : py(s.line) - 1.5).toFixed(1) + 'px',
            width: (vert ? 3 : (s.b - s.a) * S.scale).toFixed(1) + 'px',
            height: (vert ? (s.b - s.a) * S.scale : 3).toFixed(1) + 'px',
          });
          edgeLayer.append(line);
          if (off && !shell.reducedMotion && typeof line.animate === 'function') {
            anims.add(line.animate([{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }], { duration: 3600, iterations: Infinity, easing: 'ease-in-out' }));
          }
        }
      }
    }

    function pairs() {
      // one entry per pair of devices, described from this computer's side when possible
      const me = thisDev();
      const map = new Map();
      for (const e of savedEdges()) {
        const k = [e.from, e.to].sort().join('|');
        const cur = map.get(k);
        if (!cur || (me && e.from === me.id && cur.from !== me.id)) map.set(k, e);
      }
      return [...map.values()];
    }

    function monitorNo(d, side, other) {
      if (!d || d.screens.length < 2) return '';
      const segs = edgeSegments(d, S.P[d.id], side, other, S.P[other.id]);
      const ms = [...new Set(segs.map((s) => s.mon + 1))];
      return ms.length ? ` monitor ${ms.join(' & ')},` : '';
    }

    function renderEdgeList() {
      const ps = pairs();
      if (!S.saved) { edgeList.replaceChildren(h('li.muted', null, 'Loading…')); return; }
      if (!ps.length) {
        const li = h('li.muted', null, placedDevs().length > 1
          ? 'No shared edge yet. Slide a computer until it touches a screen of another one.'
          : 'Nothing to cross to yet.');
        edgeList.replaceChildren(li);
        return;
      }
      edgeList.replaceChildren(...ps.map((e, i) => {
        const A = devById(e.from), B = devById(e.to);
        const offline = !(A && A.online && B && B.online);
        const li = h('li', null,
          h('span.pill', null, h('i', { class: offline ? 'dot-off' : 'dot-good' })),
          h('span', null,
            h('b', null, `${nameOf(e.from)}`), `${monitorNo(A, e.fromEdge, B)} ${e.fromEdge} edge `,
            h('span', { 'aria-hidden': 'true' }, '↔'), h('span.sr-only', null, 'to'), ' ', h('b', null, nameOf(e.to)),
            h('span.muted', null, ` · `, h('span.num', null, String(Math.round(e.overlapPx || 0))), ' px shared', offline ? ' · offline' : '')));
        css(li, { display: 'flex', gap: '10px', 'align-items': 'baseline', padding: '9px 0', 'border-top': i ? '1px solid var(--line)' : '0' });
        return li;
      }));
    }

    /* ----- header + art ----- */
    let artSig = '';
    function renderHeader() {
      const n = placedDevs().length;
      setText(vPlaced, S.saved ? String(n) : '…');
      setText(vEdges, S.saved ? String(pairs().length) : '…');
      setText(vSaved, S.saving ? 'Saving…' : S.savedAt ? 'Just now' : S.saved ? 'Up to date' : (S.loadErr ? 'Not loaded' : '…'));
      setText(kick.lastChild, S.saving ? 'Saving' : 'Arrange');
      const me = thisDev();
      const cands = pairs().map((e) => devById(e.from === (me && me.id) ? e.to : e.from)).filter(Boolean);
      const peer = cands.find((d) => d.online) || S.devices.find((d) => !d.thisDevice && d.paired && d.online) || cands[0]
        || S.devices.find((d) => !d.thisDevice && d.paired && d.online) || null;
      const sig = [me && me.screens.length, peer && peer.id, peer && peer.online, pairs().length].join();
      if (sig === artSig) return;
      artSig = sig;
      const kindOf = (d) => (d.os === 'macos' ? (d.battery ? 'macbook' : 'mac-mini') : (d.screens.length > 1 ? 'windows-pc-2' : 'windows-pc'));
      const parts = [];
      if (me) parts.push(device(kindOf(me), { size: 150, accent: 'var(--c-layout)', state: 'online' }));
      if (peer) {
        const link = h('div');
        css(link, {
          width: '34px', height: '3px', 'margin-bottom': '50px', 'border-radius': '3px', 'flex': 'none',
          background: pairs().length && peer.online ? 'var(--a)' : 'var(--ink-4)',
          'box-shadow': pairs().length && peer.online ? '0 0 12px 1px color-mix(in oklab, var(--a) 60%, transparent)' : null,
        });
        parts.push(link, device(kindOf(peer), { size: kindOf(peer) === 'macbook' ? 96 : 110, accent: 'var(--c-layout)', state: peer.online ? 'active' : 'offline' }));
      }
      art.replaceChildren(...parts);
    }

    let placeSig = '';
    function renderPlace() {
      const me = thisDev();
      const movable = placedDevs().filter((d) => !me || d.id !== me.id);
      if (!movable.find((d) => d.id === S.sel)) S.sel = (movable.find((d) => d.online) || movable[0] || {}).id || null;
      const d = devById(S.sel);
      tools.hidden = !d;
      const sig = d ? d.id + d.name : '';
      for (const [, T] of tiles) T.sig = '';
      for (const x of placedDevs()) positionTile(x);
      if (sig === placeSig) return;
      placeSig = sig;
      if (!d) return;
      setText(placeLabel, `Place ${d.name}:`);
      placeSeg.setAttribute('aria-label', `Place ${d.name} next to ${me ? me.name : 'this computer'}`);
      placeSeg.replaceChildren(...[['left', 'Left'], ['top', 'Above'], ['right', 'Right'], ['bottom', 'Below']].map(([side, label]) =>
        h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => placeBeside(S.sel, side) }, label)));
    }

    function renderAll() {
      if (!S.saved) { renderHeader(); renderEdgeList(); return; }
      ensurePlacements();
      if (!S.frame) computeFrame();
      measure();
      syncTiles();
      renderEdges();
      renderEdgeList();
      renderPlace();
      renderHeader();
      const lonely = placedDevs().length < 2;
      emptyBox.hidden = !lonely;
      help.hidden = lonely;
    }

    /* ----- snapping ----- */
    function snap(id) {
      const D = devById(id);
      if (!D) return;
      const cur = S.P[id];
      const others = placedDevs().filter((o) => o.id !== id);
      const fixed = others.flatMap((o) => absRects(o, S.P[o.id]));
      if (!fixed.length) return;
      const rel = D.screens;
      const free = (p) => !absRects(D, p).some((r) => fixed.some((f) => overlaps(r, f)));
      let best = null, bd = Infinity;
      const consider = (p) => {
        p = { x: Math.round(p.x), y: Math.round(p.y) };
        if (!free(p)) return;
        const d = Math.hypot(p.x - cur.x, p.y - cur.y);
        if (d < bd) { bd = d; best = p; }
      };
      const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
      const align = (v, list, tol) => { for (const t of list) if (Math.abs(v - t) <= tol) return t; return v; };
      for (const rd of rel) {
        for (const rb of fixed) {
          const minV = Math.min(200, rd.h / 2, rb.h / 2), minH = Math.min(200, rd.w / 2, rb.w / 2);
          // beside: slide vertically, keep at least minV overlap; align tops/bottoms/centres when close
          const ys = [rb.y - rd.y, rb.y + rb.h - rd.y - rd.h, rb.y + rb.h / 2 - rd.y - rd.h / 2];
          const y = align(clamp(cur.y, rb.y - rd.y - rd.h + minV, rb.y + rb.h - rd.y - minV), ys, rb.h * 0.07);
          consider({ x: rb.x + rb.w - rd.x, y });
          consider({ x: rb.x - rd.x - rd.w, y });
          const xs = [rb.x - rd.x, rb.x + rb.w - rd.x - rd.w, rb.x + rb.w / 2 - rd.x - rd.w / 2];
          const x = align(clamp(cur.x, rb.x - rd.x - rd.w + minH, rb.x + rb.w - rd.x - minH), xs, rb.w * 0.07);
          consider({ x, y: rb.y + rb.h - rd.y });
          consider({ x, y: rb.y - rd.y - rd.h });
        }
      }
      if (best) S.P[id] = best;
    }

    function placeBeside(id, side) {
      const me = thisDev();
      const D = devById(id);
      if (!me || !D || !S.P[me.id]) return;
      const mr = absRects(me, S.P[me.id]);
      const b = bbox(mr), d = bbox(D.screens);
      // the monitor that owns that outer side
      const val = (r) => (side === 'right' ? r.x + r.w : side === 'left' ? -r.x : side === 'bottom' ? r.y + r.h : -r.y);
      const owner = mr.slice().sort((p, q) => val(q) - val(p) || (q.w * q.h) - (p.w * p.h))[0];
      let p;
      if (side === 'right') p = { x: b.x + b.w - d.x, y: owner.y + owner.h / 2 - d.h / 2 - d.y };
      else if (side === 'left') p = { x: b.x - d.w - d.x, y: owner.y + owner.h / 2 - d.h / 2 - d.y };
      else if (side === 'bottom') p = { x: owner.x + owner.w / 2 - d.w / 2 - d.x, y: b.y + b.h - d.y };
      else p = { x: owner.x + owner.w / 2 - d.w / 2 - d.x, y: b.y - d.h - d.y };
      S.P[id] = { x: Math.round(p.x), y: Math.round(p.y) };
      snap(id);
      computeFrame();
      measure();
      commit(`${D.name} placed ${side === 'top' ? 'above' : side === 'bottom' ? 'below' : 'to the ' + side + ' of'} ${me.name}.`);
    }

    /* ----- saving ----- */
    let saveSeq = 0;
    async function commit(sayDone) {
      const mine = ++saveSeq;
      const placements = {};
      for (const d of placedDevs()) placements[d.id] = { x: S.P[d.id].x, y: S.P[d.id].y };
      err.hidden = true;
      S.saving = true;
      renderAll();
      try {
        const r = await api.layout.set({ placements });
        if (!alive || mine !== saveSeq) return;
        S.saved = { placements: { ...(r && r.placements) }, edges: (r && r.edges) || [] };
        for (const [id, p] of Object.entries(S.saved.placements)) S.P[id] = { x: p.x, y: p.y };
        S.savedAt = Date.now();
        S.saving = false;
        renderAll();
        const n = pairs().length;
        setText(live, `${sayDone || 'Layout saved.'} ${n ? `${n} crossing edge${n > 1 ? 's' : ''}.` : 'No crossing edge yet.'}`);
        shell.toast('Saved');
        later(() => { if (S.savedAt && Date.now() - S.savedAt >= 59000) { S.savedAt = null; renderHeader(); } }, 60000);
      } catch (e) {
        if (!alive || mine !== saveSeq) return;
        S.saving = false;
        // back to what the engine has
        S.P = {};
        for (const [id, p] of Object.entries((S.saved && S.saved.placements) || {})) S.P[id] = { x: p.x, y: p.y };
        computeFrame();
        err.textContent = `${errText(e)} The layout is back to how it was.`;
        err.hidden = false;
        renderAll();
      }
    }

    function resetLayout() {
      const me = thisDev();
      if (!me) return;
      const order = ['right', 'top', 'left', 'bottom'];
      S.P = { [me.id]: { x: 0, y: 0 } };
      const peers = S.devices.filter((d) => d.id !== me.id && d.paired !== false && d.screens && d.screens.length)
        .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      peers.forEach((d, i) => {
        S.P[d.id] = { x: 1e6, y: 1e6 }; // out of the way until placed
        const side = order[i % 4];
        const mr = Object.keys(S.P).filter((id) => id !== d.id).flatMap((id) => absRects(devById(id), S.P[id]));
        const b = bbox(mr.filter((r) => r.x < 9e5)), dd = bbox(d.screens);
        const own = absRects(me, S.P[me.id]);
        const val = (r) => (side === 'right' ? r.x + r.w : side === 'left' ? -r.x : side === 'bottom' ? r.y + r.h : -r.y);
        const o = own.slice().sort((p, q) => val(q) - val(p) || (q.w * q.h) - (p.w * p.h))[0];
        const p = side === 'right' ? { x: b.x + b.w, y: o.y + o.h / 2 - dd.h / 2 }
          : side === 'left' ? { x: b.x - dd.w, y: o.y + o.h / 2 - dd.h / 2 }
            : side === 'top' ? { x: o.x + o.w / 2 - dd.w / 2, y: b.y - dd.h }
              : { x: o.x + o.w / 2 - dd.w / 2, y: b.y + b.h };
        S.P[d.id] = { x: Math.round(p.x - dd.x), y: Math.round(p.y - dd.y) };
        snap(d.id);
      });
      computeFrame();
      measure();
      commit('Layout reset.');
    }
    resetBtn.addEventListener('click', resetLayout);

    /* ----- pointer ----- */
    function onPointerDown(e) {
      if (e.button !== 0 || !S.saved || S.saving) return;
      const t = e.currentTarget;
      const id = t.getAttribute('data-id');
      S.sel = id;
      S.drag = { id, el: t, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: S.P[id].x, oy: S.P[id].y, moved: false };
      try { t.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      t.addEventListener('pointermove', onPointerMove);
      t.addEventListener('pointerup', onPointerUp);
      t.addEventListener('pointercancel', onPointerUp);
      t.focus({ preventScroll: true });
      e.preventDefault();
    }
    function onPointerMove(e) {
      const g = S.drag;
      if (!g || e.pointerId !== g.pid) return;
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 3) return;
      if (!g.moved) { g.moved = true; renderEdges(); }
      const D = devById(g.id); const b = bbox(D.screens);
      const F = S.frame;
      S.P[g.id] = {
        x: Math.round(Math.max(F.x - b.x, Math.min(F.x + F.w - b.x - b.w, g.ox + dx / S.scale))),
        y: Math.round(Math.max(F.y - b.y, Math.min(F.y + F.h - b.y - b.h, g.oy + dy / S.scale))),
      };
      positionTile(D);
    }
    function onPointerUp(e) {
      const g = S.drag;
      if (!g || e.pointerId !== g.pid) return;
      g.el.removeEventListener('pointermove', onPointerMove);
      g.el.removeEventListener('pointerup', onPointerUp);
      g.el.removeEventListener('pointercancel', onPointerUp);
      try { g.el.releasePointerCapture(g.pid); } catch (_) { /* ignore */ }
      S.drag = null;
      if (!g.moved) { renderPlace(); return; }
      if (e.type === 'pointercancel') { S.P[g.id] = { x: g.ox, y: g.oy }; renderAll(); return; }
      snap(g.id);
      computeFrame();
      measure();
      commit(`${nameOf(g.id)} snapped into place.`);
    }

    /* ----- keyboard ----- */
    let kbdT = null;
    function onKey(e) {
      const id = e.currentTarget.getAttribute('data-id');
      const D = devById(id);
      if (!D || !S.saved || S.saving) return;
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (dirs[e.key]) {
        e.preventDefault();
        if (!S.kbd) S.kbd = { id, ox: S.P[id].x, oy: S.P[id].y };
        const stepPx = e.shiftKey ? 10 : 40;               // screen pixels per press
        const step = stepPx / S.scale;
        const [ax, ay] = dirs[e.key];
        const b = bbox(D.screens), F = S.frame;
        S.P[id] = {
          x: Math.round(Math.max(F.x - b.x, Math.min(F.x + F.w - b.x - b.w, S.P[id].x + ax * step))),
          y: Math.round(Math.max(F.y - b.y, Math.min(F.y + F.h - b.y - b.h, S.P[id].y + ay * step))),
        };
        renderEdges();
        positionTile(D);
        clearLater(kbdT);
        kbdT = later(() => finishKbd(), 700);
      } else if ((e.key === 'Enter' || e.key === ' ') && S.kbd) {
        e.preventDefault();
        clearLater(kbdT); finishKbd();
      } else if (e.key === 'Escape' && S.kbd) {
        e.preventDefault();
        clearLater(kbdT);
        S.P[id] = { x: S.kbd.ox, y: S.kbd.oy };
        S.kbd = null;
        renderAll();
        setText(live, `${D.name} moved back.`);
      }
    }
    function finishKbd() {
      kbdT = null;
      const k = S.kbd;
      if (!k) return;
      S.kbd = null;
      snap(k.id);
      computeFrame();
      measure();
      commit(`${nameOf(k.id)} snapped into place.`);
    }

    /* ----- data ----- */
    const sub = (fn) => { try { const off = fn(); if (typeof off === 'function') offs.push(off); } catch (e) { console.warn('[layout]', e); } };
    sub(() => api.devices.on((list) => {
      if (!alive) return;
      S.devices = (Array.isArray(list) ? list : []).map(placeable);
      if (S.drag || S.kbd) return;
      renderAll();
    }));

    let ro = null;
    if (typeof ResizeObserver === 'function') {
      let lastW = 0;
      ro = new ResizeObserver(() => {
        const w = desk.clientWidth;
        if (!alive || w === lastW || !S.frame) return;
        lastW = w;
        measure();
        for (const d of placedDevs()) positionTile(d);
        renderEdges();
      });
      ro.observe(desk);
    }

    (async () => {
      try {
        const r = await api.layout.get();
        if (!alive) return;
        S.saved = { placements: { ...(r && r.placements) }, edges: (r && r.edges) || [] };
        for (const [id, p] of Object.entries(S.saved.placements)) S.P[id] = { x: p.x, y: p.y };
      } catch (e) {
        if (!alive) return;
        S.loadErr = e;
        err.textContent = `Couldn't read the layout. ${errText(e)}`;
        err.hidden = false;
      }
      renderAll();
    })();

    renderAll();

    shell.registerCommands([{
      id: 'layout.reset', title: 'Reset screen layout', keywords: 'layout arrange reset default place',
      group: 'layout', icon: 'layout', accent: 'var(--c-layout)',
      run() { resetLayout(); return null; },
    }]);

    return () => {
      alive = false;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      timers.forEach((t) => clearTimeout(t)); timers.clear();
      for (const a of anims) { try { a.cancel(); } catch (_) { /* ignore */ } }
      anims.clear();
      if (ro) ro.disconnect();
      S.drag = null; S.kbd = null;
    };
  },
};
