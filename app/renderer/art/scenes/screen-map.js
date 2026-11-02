// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Mouse & keyboard: the monitors of both computers, to scale, a moving cursor and the
// outer crossing edge glowing.
// update({ screens: { this: Rect[], peer: Rect[] }, cursor: { deviceId, x, y },
//          crossingEdge: 'left'|'right'|'top'|'bottom' | { fromEdge }, names?: { this, peer } })
// Coordinates are desktop pixels; the cursor is in its own device's coordinates.

import { el, css, set, clear, mix, C } from '../svg.js';

const DEFAULT = {
  screens: {
    this: [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }],
    peer: [{ x: 0, y: 0, w: 1440, h: 900 }],
  },
  cursor: { deviceId: 'this', x: 3400, y: 700 },
  crossingEdge: 'right',
  names: { this: 'This computer', peer: 'Other computer' },
};

const CURSOR = 'M0 0L0 14L4 10.5L7 17L9.5 16L6.5 9.5L11.5 9.5Z';

const bbox = (rs) => {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const valid = (rs) => Array.isArray(rs) ? rs.filter((r) => r && r.w > 0 && r.h > 0) : [];

export default function screenMap(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  const monL = el('g', null, root), edgeL = el('g', null, root), labL = el('g', null, root);
  const cur = el('g', null, root);
  const curPath = el('path', { d: CURSOR, 'vector-effect': 'non-scaling-stroke' }, cur);
  css(curPath, { fill: C.paper, stroke: 'rgba(0,0,0,.55)', 'stroke-width': 1, 'stroke-linejoin': 'round',
    filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))' });

  let VW = 360, VH = 150;
  const data = JSON.parse(JSON.stringify(DEFAULT));
  let L = null; // layout
  const pos = { x: 0, y: 0, ok: false };

  function edgeName(e) {
    const s = typeof e === 'string' ? e : e && (e.fromEdge || e.edge);
    return ['left', 'right', 'top', 'bottom'].includes(s) ? s : 'right';
  }

  function layout() {
    [monL, edgeL, labL].forEach(clear);
    const mine = valid(data.screens.this);
    const peer = valid(data.screens.peer);
    const edge = edgeName(data.crossingEdge);
    const tb = bbox(mine), pb = bbox(peer);
    // the monitor that owns the outer edge on that side
    const onEdge = mine.filter((r) =>
      edge === 'right' ? Math.abs(r.x + r.w - (tb.x + tb.w)) < 2 :
      edge === 'left' ? Math.abs(r.x - tb.x) < 2 :
      edge === 'top' ? Math.abs(r.y - tb.y) < 2 : Math.abs(r.y + r.h - (tb.y + tb.h)) < 2);
    const horiz = edge === 'left' || edge === 'right';
    const owner = onEdge.sort((a, b) => (horiz ? b.h - a.h : b.w - a.w))[0] || tb;
    const gap = Math.max(tb.w, tb.h) * 0.045;
    let px = 0, py = 0;
    if (horiz) {
      px = edge === 'right' ? tb.x + tb.w + gap : tb.x - gap - pb.w;
      py = owner.y + owner.h / 2 - pb.h / 2;
    } else {
      py = edge === 'bottom' ? tb.y + tb.h + gap : tb.y - gap - pb.h;
      px = owner.x + owner.w / 2 - pb.w / 2;
    }
    const off = { x: px - pb.x, y: py - pb.y };
    const peerAbs = peer.map((r) => ({ x: r.x + off.x, y: r.y + off.y, w: r.w, h: r.h }));
    const all = bbox(mine.concat(peerAbs));
    const pad = 12, top = 16;
    const s = Math.min((VW - 2 * pad) / Math.max(1, all.w), (VH - 2 * pad - top) / Math.max(1, all.h));
    const ox = (VW - all.w * s) / 2 - all.x * s;
    const oy = pad + top + (VH - 2 * pad - top - all.h * s) / 2 - all.y * s;
    const map = (x, y) => [ox + x * s, oy + y * s];

    const rects = [];
    const drawMon = (r, i, isPeer) => {
      const [x, y] = map(r.x, r.y);
      const w = r.w * s, h = r.h * s;
      const n = el('rect', { x: x + 0.5, y: y + 0.5, width: Math.max(1, w - 1), height: Math.max(1, h - 1), rx: isPeer ? 5 : 3.5, 'vector-effect': 'non-scaling-stroke' }, monL);
      css(n, { fill: 'rgba(255,255,255,.03)', stroke: 'rgba(255,255,255,.2)', 'stroke-width': 1 });
      if (w > 74 && h > 26) {
        const t = el('text', { x: x + 8, y: y + 15 }, labL);
        css(t, { fill: C.ink3, font: `500 9px ${C.mono}`, 'letter-spacing': '0' });
        t.textContent = isPeer ? `${r.w}×${r.h}` : `${i + 1} · ${r.w}×${r.h}`;
      }
      rects.push({ n, r, isPeer });
    };
    mine.forEach((r, i) => drawMon(r, i, false));
    peerAbs.forEach((r, i) => drawMon(r, i, true));

    const name = (txt, b) => {
      if (!b.w) return;
      const [x, y] = map(b.x, b.y);
      const t = el('text', { x: x + 1, y: y - 7 }, labL);
      css(t, { fill: C.ink3, font: `500 9.5px ${C.font}`, 'letter-spacing': '.02em' });
      t.textContent = txt;
    };
    const names = data.names || DEFAULT.names;
    name(names.this || DEFAULT.names.this, tb);
    if (peer.length) name(names.peer || DEFAULT.names.peer, bbox(peerAbs));

    // the crossing segment: overlap of the owner edge with the peer
    let edgeLines = null;
    if (peer.length && owner) {
      const P = bbox(peerAbs);
      let a, b;
      if (horiz) {
        const x = edge === 'right' ? owner.x + owner.w : owner.x;
        const y0 = Math.max(owner.y, P.y), y1 = Math.min(owner.y + owner.h, P.y + P.h);
        if (y1 > y0) { a = map(x, y0); b = map(x, y1); }
      } else {
        const y = edge === 'bottom' ? owner.y + owner.h : owner.y;
        const x0 = Math.max(owner.x, P.x), x1 = Math.min(owner.x + owner.w, P.x + P.w);
        if (x1 > x0) { a = map(x0, y); b = map(x1, y); }
      }
      if (a) {
        const inset = 3;
        const dx = horiz ? 0 : inset, dy = horiz ? inset : 0;
        const d = `M${a[0] + dx} ${a[1] + dy}L${b[0] - dx} ${b[1] - dy}`;
        const glow = css(el('path', { d }, edgeL), { stroke: A, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-opacity': 0.14, fill: 'none' });
        const core = css(el('path', { d }, edgeL), { stroke: A, 'stroke-width': 2.2, 'stroke-linecap': 'round', fill: 'none' });
        edgeLines = { glow, core };
      }
    }
    L = { map, off, rects, edgeLines, s };
  }

  function target() {
    const c = data.cursor;
    if (!c || !L) return null;
    const isPeer = c.deviceId != null && c.deviceId !== 'this';
    const x = c.x + (isPeer ? L.off.x : 0), y = c.y + (isPeer ? L.off.y : 0);
    return { x, y, isPeer, screen: L.map(x, y) };
  }

  layout();

  return {
    still: 1,
    resize(w, h) {
      VW = Math.max(60, w); VH = Math.max(40, h);
      ctx.svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
      layout();
      pos.ok = false;
    },
    update(d) {
      let relayout = false;
      if (d.screens) {
        if (d.screens.this) data.screens.this = d.screens.this;
        if (d.screens.peer) data.screens.peer = d.screens.peer;
        relayout = true;
      }
      if ('crossingEdge' in d) { data.crossingEdge = d.crossingEdge; relayout = true; }
      if (d.names) { data.names = { ...data.names, ...d.names }; relayout = true; }
      if (d.cursor !== undefined) data.cursor = d.cursor;
      if (relayout) layout();
    },
    frame(t, dt) {
      const tg = target();
      if (tg) {
        const [x, y] = tg.screen;
        if (!pos.ok || ctx.reduced || dt === 0 && !pos.ok) { pos.x = x; pos.y = y; pos.ok = true; }
        else { const k = 1 - Math.exp(-dt * 11); pos.x += (x - pos.x) * k; pos.y += (y - pos.y) * k; }
        cur.setAttribute('transform', `translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)})`);
        cur.style.removeProperty('display');
        for (const m of L.rects) {
          const inside = tg.x >= m.r.x && tg.x < m.r.x + m.r.w && tg.y >= m.r.y && tg.y < m.r.y + m.r.h;
          const fill = inside ? (m.isPeer ? mix(A, 14) : 'rgba(255,255,255,.065)') : 'rgba(255,255,255,.03)';
          if (m.fill !== fill) { m.fill = fill; m.n.style.setProperty('fill', fill); m.n.style.setProperty('stroke', inside && m.isPeer ? mix(A, 55) : 'rgba(255,255,255,.2)'); }
        }
      } else cur.style.setProperty('display', 'none');
      if (L && L.edgeLines) {
        const b = ctx.reduced ? 1 : 0.5 + 0.5 * Math.sin((t / 4.4) * Math.PI * 2);
        L.edgeLines.core.style.setProperty('stroke-opacity', (0.55 + 0.4 * b).toFixed(3));
        L.edgeLines.glow.style.setProperty('stroke-opacity', (0.07 + 0.12 * b).toFixed(3));
      }
    },
  };
}
