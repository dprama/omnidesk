// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Second screen: a display slides out of the PC onto the laptop (or back).
// update({ direction: 'pc-to-mac'|'mac-to-pc', live: boolean, names?: [pc, mac] })
// Not live: a slow, faint demonstration loop. Live: it slides once and stays, breathing softly.

import { el, css, clear, ease, seg, bump, lerp, frac, mix, C } from '../svg.js';
import { drawDevice, dims } from '../kit.js';
import { W, H, label, deskLine } from './common.js';

const GROUND = 122;
const P = 9.5;

export default function displaySlide(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  deskLine(ctx, root, GROUND);
  const pcD = dims('windows-pc'), macD = dims('macbook');
  const sp = 0.8, sm = 0.8;
  const pc = drawDevice(ctx, root, 'windows-pc', { x: 26, y: GROUND - pcD.H * sp, scale: sp });
  const mac = drawDevice(ctx, root, 'macbook', { x: W - 26 - macD.W * sm, y: GROUND - macD.H * sm, scale: sm });
  const S = pc.screens[0], M = mac.screens[0];

  const flow = el('path', { d: `M${S.x + S.w + 30} ${GROUND - 9}H${M.x - 22}`, 'vector-effect': 'non-scaling-stroke' }, root);
  css(flow, { fill: 'none', stroke: A, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-dasharray': '0.01 6', 'stroke-opacity': 0 });

  const glows = [S, M].map((r) => css(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 1.6 }, root), { fill: ctx.glowFill(A), opacity: 0 }));

  // the travelling display: frame + a tiny desktop inside (unit space 100 x 62)
  const panel = el('g', null, root);
  const content = el('g', null, panel);
  css(el('rect', { x: 0, y: 0, width: 100, height: 62 }, content), { fill: mix(A, 10, '#151920') });
  css(el('rect', { x: 0, y: 0, width: 100, height: 5 }, content), { fill: mix(A, 22, 'transparent') });
  css(el('rect', { x: 9, y: 13, width: 40, height: 27, rx: 2 }, content), { fill: C.paper, 'fill-opacity': 0.16 });
  css(el('rect', { x: 55, y: 13, width: 36, height: 38, rx: 2 }, content), { fill: C.paper, 'fill-opacity': 0.09 });
  css(el('rect', { x: 9, y: 45, width: 26, height: 3, rx: 1.5 }, content), { fill: A, 'fill-opacity': 0.55 });
  const frame = el('rect', { rx: 2, 'vector-effect': 'non-scaling-stroke' }, panel);
  css(frame, { fill: 'none', stroke: A, 'stroke-width': 1.3 });

  const labL = el('g', null, root);
  let names = ['Windows PC', 'MacBook'];
  const drawLabels = () => {
    clear(labL);
    label(labL, pc.box.x + pc.box.w / 2, GROUND + 17, names[0]);
    label(labL, mac.box.x + mac.box.w / 2, GROUND + 17, names[1]);
  };
  drawLabels();

  let live = false, dir = 'pc-to-mac', since = -100;

  function place(r, lift, op) {
    content.setAttribute('transform', `translate(${r.x.toFixed(2)} ${(r.y - lift).toFixed(2)}) scale(${(r.w / 100).toFixed(4)} ${(r.h / 62).toFixed(4)})`);
    frame.setAttribute('x', r.x.toFixed(2)); frame.setAttribute('y', (r.y - lift).toFixed(2));
    frame.setAttribute('width', r.w.toFixed(2)); frame.setAttribute('height', r.h.toFixed(2));
    panel.style.setProperty('opacity', op.toFixed(3));
  }
  const lerpRect = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) });

  return {
    view: [W, H],
    still: P * 0.7,
    update(d) {
      const nl = !!d.live, nd = d.direction === 'mac-to-pc' ? 'mac-to-pc' : d.direction === 'pc-to-mac' ? 'pc-to-mac' : dir;
      if ((nl && !live) || (nl && nd !== dir)) since = ctx.now();
      live = nl; dir = nd;
      if (Array.isArray(d.names)) { names = d.names; drawLabels(); }
    },
    frame(t) {
      const [src, dst, gi] = dir === 'pc-to-mac' ? [S, M, 1] : [M, S, 0];
      let u, op, lift;
      if (live) {
        u = ctx.reduced ? 1 : ease((t - since) / 2.8);
        lift = 12 * bump(u);
        const breathe = 0.5 + 0.5 * Math.sin((t / 5.5) * Math.PI * 2);
        op = 1;
        frame.style.setProperty('stroke-opacity', (u < 1 ? 1 : 0.65 + 0.35 * breathe).toFixed(3));
        glows[gi].style.setProperty('opacity', (u * (0.55 + 0.25 * (ctx.reduced ? 1 : breathe))).toFixed(3));
        glows[1 - gi].style.setProperty('opacity', '0');
        flow.style.setProperty('stroke-opacity', (0.35 * u).toFixed(3));
        flow.style.setProperty('stroke-dashoffset', ((dir === 'pc-to-mac' ? -1 : 1) * t * 5).toFixed(2));
      } else {
        const p = frac(t / P);
        u = ease(seg(p, 0.16, 0.56));
        lift = 12 * bump(u);
        op = 0.62 * Math.min(seg(p, 0, 0.1), 1 - seg(p, 0.84, 0.98));
        frame.style.setProperty('stroke-opacity', '0.8');
        glows[gi].style.setProperty('opacity', (0.3 * seg(p, 0.5, 0.6) * (1 - seg(p, 0.84, 0.98))).toFixed(3));
        glows[1 - gi].style.setProperty('opacity', '0');
        flow.style.setProperty('stroke-opacity', '0');
      }
      place(lerpRect(src, dst, u), lift, op);
    },
  };
}
