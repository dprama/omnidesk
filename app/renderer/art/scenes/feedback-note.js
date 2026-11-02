// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Feedback: a note writes itself, then a paper plane carries it off along a dotted path.
// update({}) is accepted and ignored.

import { el, css, ease, seg, frac, bump, C, SHADOW } from '../svg.js';
import { W, H, dotted, pathPoint } from './common.js';

const P = 11;

export default function feedbackNote(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);

  const route = `M126 58C176 6 238 104 334 34`;
  const trail = dotted(root, route, 0.13);
  const pt = pathPoint(trail);

  const card = el('g', { transform: 'rotate(-5 94 78)' }, root);
  css(card, { filter: SHADOW });
  css(el('rect', { x: 62, y: 38, width: 64, height: 80, rx: 6 }, card), { fill: ctx.bodyFill() });
  const lines = [[38, A], [30, C.ink4], [44, C.ink4], [36, C.ink4], [22, C.ink4]].map(([w, c], i) => {
    const n = el('path', { d: `M72 ${54 + i * 12}h${w}` }, card);
    css(n, { stroke: c, 'stroke-width': i === 0 ? 2.4 : 2, 'stroke-linecap': 'round', 'stroke-dasharray': `${w} ${w + 4}`, fill: 'none' });
    return { n, w };
  });

  const plane = el('g', null, root);
  const inner = el('g', { transform: 'scale(.62) translate(-21 -14)' }, plane);
  css(inner, { filter: SHADOW });
  css(el('path', { d: 'M0 0L42 14L0 28L8 14Z' }, inner), { fill: ctx.bodyFill() });
  css(el('path', { d: 'M8 14L42 14L14 20Z' }, inner), { fill: C.paper2 });

  return {
    view: [W, H],
    still: P * 0.66,
    frame(t) {
      const p = frac(t / P);
      const fade = 1 - seg(p, 0.9, 0.98);
      lines.forEach((l, i) => {
        const q = ease(seg(p, 0.02 + i * 0.055, 0.02 + (i + 1) * 0.055));
        l.n.style.setProperty('stroke-dashoffset', (l.w * (1 - q)).toFixed(2));
        l.n.style.setProperty('opacity', fade.toFixed(3));
      });
      const u = ease(seg(p, 0.38, 0.9));
      const a = pt(u), b = pt(Math.min(1, u + 0.01));
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const bob = Math.sin(t * 1.4) * 1.2;
      plane.setAttribute('transform', `translate(${a.x.toFixed(2)} ${(a.y + bob).toFixed(2)}) rotate(${ang.toFixed(2)})`);
      plane.style.setProperty('opacity', (p < 0.38 ? 0 : Math.min(1, seg(p, 0.38, 0.43) * 1) * (1 - seg(p, 0.8, 0.9))).toFixed(3));
      trail.style.setProperty('stroke-opacity', (0.08 + 0.08 * bump(seg(p, 0.36, 0.92))).toFixed(3));
    },
  };
}
