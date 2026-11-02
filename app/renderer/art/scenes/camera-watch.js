// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Camera: one lens; small viewer dots drift around it, linked while the camera is live.
// update({ liveDeviceId: string|null, watchers: deviceId[] })

import { el, css, smooth, mix, C, SHADOW } from '../svg.js';
import { W, H } from './common.js';

const CX = W / 2, CY = H / 2 - 2, RX = 128, RY = 50, ORBIT = 90;

export default function cameraWatch(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  const lineL = el('g', null, root), dotL = el('g', null, root);
  const rings = [0, 1].map(() => css(el('circle', { cx: CX, cy: CY, r: 34, 'vector-effect': 'non-scaling-stroke' }, root),
    { fill: 'none', stroke: A, 'stroke-width': 1.2, opacity: 0 }));

  const lens = el('g', null, root);
  css(lens, { filter: SHADOW });
  css(el('circle', { cx: CX, cy: CY, r: 31 }, lens), { fill: ctx.bodyFill() });
  css(el('circle', { cx: CX, cy: CY, r: 22 }, lens), { fill: C.cut });
  css(el('circle', { cx: CX, cy: CY, r: 17, 'vector-effect': 'non-scaling-stroke' }, lens), { fill: 'none', stroke: 'rgba(255,255,255,.06)', 'stroke-width': 1 });
  const iris = css(el('circle', { cx: CX, cy: CY, r: 10.5 }, lens), { fill: '#343a46' });
  css(el('circle', { cx: CX, cy: CY, r: 4.2 }, lens), { fill: C.cut, 'fill-opacity': 0.75 });
  css(el('circle', { cx: CX - 5.5, cy: CY - 6, r: 2.6 }, lens), { fill: '#ffffff', 'fill-opacity': 0.4 });
  const led = css(el('circle', { cx: CX + 23, cy: CY - 23, r: 2.6 }, root), { fill: C.ink4 });

  let live = null;
  const watchers = new Map(); // id -> { dot, halo, line, born, ang }

  function setLive(v) {
    live = v || null;
    css(iris, { fill: live ? mix(A, 78, '#1b1f27') : '#343a46' });
    css(led, { fill: live ? A : C.ink4, filter: live ? `drop-shadow(0 0 3px ${A})` : null });
  }
  setLive('demo');

  function setWatchers(ids) {
    const seen = new Set(ids.map(String));
    for (const [id, w] of watchers) if (!seen.has(id)) { w.g.remove(); w.line.remove(); watchers.delete(id); }
    for (const id of seen) {
      if (watchers.has(id)) continue;
      const line = el('path', { 'vector-effect': 'non-scaling-stroke' }, lineL);
      css(line, { fill: 'none', stroke: A, 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-dasharray': '0.01 4.5' });
      const g = el('g', null, dotL);
      const halo = css(el('circle', { r: 7.5 }, g), { fill: A, 'fill-opacity': 0.12 });
      css(el('circle', { r: 3.4 }, g), { fill: C.paper });
      watchers.set(id, { g, halo, line, born: ctx.now(), ang: null });
    }
  }
  setWatchers(['a', 'b', 'c']);

  return {
    view: [W, H],
    still: 1.4,
    update(d) {
      if ('liveDeviceId' in d) setLive(d.liveDeviceId);
      if (Array.isArray(d.watchers)) setWatchers(d.watchers);
    },
    frame(t, dt) {
      const list = [...watchers.values()];
      const n = list.length;
      const base = -Math.PI / 2 + 0.5 + (ctx.reduced ? 0 : (t / ORBIT) * Math.PI * 2);
      list.forEach((w, i) => {
        const target = base + (i * Math.PI * 2) / Math.max(1, n);
        if (w.ang == null || ctx.reduced) w.ang = target;
        else w.ang += (target - w.ang) * (1 - Math.exp(-dt * 2.5));
        const x = CX + RX * Math.cos(w.ang), y = CY + RY * Math.sin(w.ang);
        const appear = ctx.reduced ? 1 : smooth((t - w.born) / 1.4);
        w.g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        w.g.style.setProperty('opacity', ((live ? 0.9 : 0.4) * appear).toFixed(3));
        w.halo.style.setProperty('fill-opacity', live ? '0.12' : '0');
        const dx = x - CX, dy = y - CY, len = Math.hypot(dx, dy) || 1;
        const sx = CX + (dx / len) * 37, sy = CY + (dy / len) * 37;
        const ex = x - (dx / len) * 8, ey = y - (dy / len) * 8;
        w.line.setAttribute('d', `M${sx.toFixed(2)} ${sy.toFixed(2)}L${ex.toFixed(2)} ${ey.toFixed(2)}`);
        w.line.style.setProperty('stroke-opacity', live ? (0.4 * appear).toFixed(3) : '0');
        w.line.style.setProperty('stroke-dashoffset', (-t * 4).toFixed(2));
      });
      rings.forEach((r, i) => {
        if (!live || ctx.reduced) { r.style.setProperty('opacity', live && i === 0 ? '0.18' : '0'); r.setAttribute('r', '40'); return; }
        const q = ((t / 5 + i / 2) % 1);
        r.setAttribute('r', (34 + 30 * q).toFixed(2));
        r.style.setProperty('opacity', (0.32 * Math.pow(1 - q, 1.6)).toFixed(3));
      });
    },
  };
}
