// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Connection: a slow sweep; found devices fade in as blips and glow as the sweep passes.
// update({ devices: Device[] })

import { el, css, set, hash, smooth, C } from '../svg.js';
import { W, H, label } from './common.js';

const CX = W / 2, CY = H / 2, RINGS = [22, 44, 66], PERIOD = 6.5;

export default function radar(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  RINGS.forEach((r, i) =>
    css(el('circle', { cx: CX, cy: CY, r, 'vector-effect': 'non-scaling-stroke' }, root),
      { fill: 'none', stroke: A, 'stroke-opacity': [0.12, 0.16, 0.22][i], 'stroke-width': 1 }));
  css(el('path', { d: `M${CX} ${CY - 66}V${CY + 66}M${CX - 66} ${CY}H${CX + 66}`, 'vector-effect': 'non-scaling-stroke' }, root),
    { stroke: '#ffffff', 'stroke-opacity': 0.05, 'stroke-width': 1 });

  // Sweep: a fan of thin wedges fading behind the leading edge.
  const sweep = el('g', null, root);
  const R = 66, N = 14, STEP = 3.6;
  for (let i = 0; i < N; i++) {
    const a0 = (-(i + 1) * STEP * Math.PI) / 180, a1 = (-i * STEP * Math.PI) / 180;
    const p = (a) => `${(CX + R * Math.sin(a)).toFixed(2)} ${(CY - R * Math.cos(a)).toFixed(2)}`;
    css(el('path', { d: `M${CX} ${CY}L${p(a0)}A${R} ${R} 0 0 1 ${p(a1)}Z` }, sweep),
      { fill: A, 'fill-opacity': (0.15 * Math.pow(1 - i / N, 1.6)).toFixed(3) });
  }
  css(el('line', { x1: CX, y1: CY, x2: CX, y2: CY - R, 'vector-effect': 'non-scaling-stroke' }, sweep),
    { stroke: A, 'stroke-opacity': 0.55, 'stroke-width': 1.25, 'stroke-linecap': 'round' });

  const blipL = el('g', null, root);
  css(el('circle', { cx: CX, cy: CY, r: 9 }, root), { fill: A, 'fill-opacity': 0.08 });
  css(el('circle', { cx: CX, cy: CY, r: 3.2 }, root), { fill: C.paper });

  const blips = new Map();

  function place(id) {
    const h = hash(String(id));
    const r = 30 + ((h >>> 9) % 32);
    let deg = h % 360, pos;
    // keep labels apart: rotate on until no other blip label sits on the same row and side
    for (let i = 0; i < 14; i++) {
      const th = ((deg + i * 27) % 360) * (Math.PI / 180);
      pos = { theta: th, x: CX + r * Math.sin(th), y: CY - r * Math.cos(th) };
      const clash = [...blips.values()].some((b) => (b.x < CX) === (pos.x < CX) && Math.abs(b.y - pos.y) < 13);
      if (!clash) break;
    }
    return pos;
  }

  return {
    view: [W, H],
    still: PERIOD * 0.3,
    update(data) {
      const list = Array.isArray(data.devices) ? data.devices : [];
      const seen = new Set();
      for (const d of list) {
        const id = String(d.id ?? d.name);
        seen.add(id);
        let b = blips.get(id);
        const online = d.online !== false;
        if (!b) {
          const pos = place(id);
          const g = el('g', null, blipL);
          const ring = el('circle', { cx: pos.x, cy: pos.y, r: 4, 'vector-effect': 'non-scaling-stroke' }, g);
          css(ring, { fill: 'none', stroke: A, 'stroke-width': 1, opacity: 0 });
          const dot = el('circle', { cx: pos.x, cy: pos.y, r: 3.4, 'vector-effect': 'non-scaling-stroke' }, g);
          const left = pos.x < CX;
          const lab = label(g, pos.x + (left ? -9 : 9), pos.y + 3.2, '', left ? 'end' : 'start');
          b = { ...pos, g, ring, dot, lab, born: ctx.now(), online: null };
          blips.set(id, b);
        }
        if (b.online !== online) {
          b.online = online;
          css(b.dot, online ? { fill: A, stroke: 'none' } : { fill: 'none', stroke: C.ink3, 'stroke-width': 1.1 });
        }
        b.lab.textContent = (d.name || 'Device').slice(0, 22) + (online ? '' : ' · offline');
      }
      for (const [id, b] of blips) if (!seen.has(id)) { b.g.remove(); blips.delete(id); }
    },
    frame(t) {
      const ang = ((t / PERIOD) % 1) * 360;
      sweep.setAttribute('transform', `rotate(${ang.toFixed(2)} ${CX} ${CY})`);
      for (const b of blips.values()) {
        const deg = (b.theta * 180) / Math.PI;
        const since = (((ang - deg) % 360 + 360) % 360 / 360) * PERIOD;
        const heat = Math.exp(-since / 1.9);
        const appear = ctx.reduced ? 1 : smooth((t - b.born) / 1.6);
        const k = b.online ? 1 : 0.6;
        b.dot.style.setProperty('opacity', (appear * k * (0.4 + 0.6 * heat)).toFixed(3));
        b.lab.style.setProperty('opacity', (appear * (0.6 + 0.4 * heat)).toFixed(3));
        const rp = since / 1.5;
        if (rp < 1 && b.online && !ctx.reduced) {
          set(b.ring, { r: 4 + rp * 11 });
          b.ring.style.setProperty('opacity', (appear * 0.45 * Math.pow(1 - rp, 1.5)).toFixed(3));
        } else b.ring.style.setProperty('opacity', '0');
      }
    },
  };
}
