// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Tip: a glass jar; now and then one coin drops in, with a small ripple.
// update({}) is accepted and ignored.

import { el, css, set, easeIn, seg, frac, mix, C, SHADOW } from '../svg.js';
import { W, H, deskLine } from './common.js';

const P = 6.5;
const X = W / 2;

export default function tipJar(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  deskLine(ctx, root, 127);

  const coinBody = (parent, rx, ry) => {
    const e = el('ellipse', { rx, ry }, parent);
    css(e, { fill: A, stroke: mix(A, 62, '#0c0e13'), 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    return e;
  };

  // falling coin (drawn before the lid, so it passes behind it)
  const coin = el('g', null, root);
  const coinE = coinBody(coin, 7.5, 7.5);
  const coinI = css(el('ellipse', { rx: 4.6, ry: 4.6, 'vector-effect': 'non-scaling-stroke' }, coin), { fill: 'none', stroke: mix(A, 60, '#0c0e13'), 'stroke-width': 1, 'stroke-opacity': 0.7 });

  // pile
  const pile = el('g', null, root);
  [[X - 11, 120.5, 0.7], [X + 10, 120.5, 0.62], [X - 1, 116, 0.78], [X + 15, 116.5, 0.5]].forEach(([x, y, o]) => {
    const g = el('g', { transform: `translate(${x} ${y})` }, pile);
    css(g, { opacity: o });
    coinBody(g, 10.5, 3.6);
  });
  const ripple = css(el('ellipse', { cx: X, cy: 112, rx: 8, ry: 2.5, 'vector-effect': 'non-scaling-stroke' }, root), { fill: 'none', stroke: A, 'stroke-width': 1, opacity: 0 });

  // jar
  const jar = el('path', { d: `M${X - 28} 38h56v8q9 5 9 15v54q0 11 -11 11h-52q-11 0 -11 -11V61q0 -10 9 -15z`, 'vector-effect': 'non-scaling-stroke' }, root);
  css(jar, { fill: 'rgba(255,255,255,.035)', stroke: C.paper, 'stroke-opacity': 0.5, 'stroke-width': 1.25, 'stroke-linejoin': 'round' });
  css(el('path', { d: `M${X - 30} 66v38`, 'vector-effect': 'non-scaling-stroke' }, root), { stroke: '#ffffff', 'stroke-opacity': 0.1, 'stroke-width': 2.5, 'stroke-linecap': 'round' });
  const lid = el('g', null, root);
  css(lid, { filter: SHADOW });
  css(el('rect', { x: X - 33, y: 29, width: 66, height: 10, rx: 3.5 }, lid), { fill: ctx.bodyFill() });
  css(el('rect', { x: X - 10, y: 32.6, width: 20, height: 2.4, rx: 1.2 }, lid), { fill: C.cut });

  return {
    view: [W, H],
    still: P * 0.3,
    frame(t) {
      const p = frac(t / P);
      let y = 12, op = 0;
      if (p < 0.12) { op = seg(p, 0, 0.12); y = 12; }
      else if (p < 0.42) { const u = easeIn(seg(p, 0.12, 0.42)); y = 12 + (110 - 12) * u; op = 1 - 0.25 * seg(p, 0.36, 0.42); }
      else if (p < 0.52) { y = 110; op = 0.75 * (1 - seg(p, 0.42, 0.52)); }
      const spin = Math.abs(Math.cos(p * Math.PI * 2.2));
      set(coinE, { ry: (0.9 + 6.6 * spin).toFixed(2) });
      set(coinI, { ry: (0.6 + 4 * spin).toFixed(2) });
      coin.setAttribute('transform', `translate(${X} ${y.toFixed(2)})`);
      coin.style.setProperty('opacity', op.toFixed(3));
      const r = seg(p, 0.42, 0.68);
      set(ripple, { rx: (8 + 16 * r).toFixed(2), ry: (2.4 + 3.6 * r).toFixed(2) });
      ripple.style.setProperty('opacity', (r > 0 && r < 1 ? 0.45 * (1 - r) : 0).toFixed(3));
    },
  };
}
