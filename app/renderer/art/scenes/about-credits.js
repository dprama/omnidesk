// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// About: the OmniDesk mark inside a slow ring; small dots orbit like contributors,
// and credited names fade in one at a time below.
// update({ names?: string[] })

import { el, css, clear, bump, frac, mix, C } from '../svg.js';
import { W, H, label } from './common.js';

const CX = W / 2, CY = 66;

export default function aboutCredits(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);

  const glowId = ctx.gradient('about-glow', (id) => {
    const g = el('radialGradient', { id }, ctx.defs);
    css(el('stop', { offset: 0 }, g), { 'stop-color': A, 'stop-opacity': 0.2 });
    css(el('stop', { offset: 1 }, g), { 'stop-color': A, 'stop-opacity': 0 });
  });
  const glow = css(el('circle', { cx: CX, cy: CY, r: 56 }, root), { fill: glowId });
  css(el('circle', { cx: CX, cy: CY, r: 58, 'vector-effect': 'non-scaling-stroke' }, root), { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.05, 'stroke-width': 1 });
  const ring = el('g', null, root);
  css(el('circle', { cx: CX, cy: CY, r: 46, 'vector-effect': 'non-scaling-stroke' }, ring),
    { fill: 'none', stroke: A, 'stroke-opacity': 0.4, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-dasharray': '0.01 7' });

  const dots = [[46, 34, 0.1, true], [58, 52, 0.35], [46, 61, 0.6], [58, 44, 0.82], [58, 71, 0.15]].map(([r, per, ph, acc]) => {
    const d = el('circle', { r: acc ? 2.2 : 1.7 }, root);
    css(d, { fill: acc ? A : C.paper, opacity: acc ? 0.9 : 0.45 });
    return { d, r, per, ph };
  });

  // the mark: two rounded screens and a cursor
  const mark = el('g', { transform: `translate(${CX - 40} ${CY - 40}) scale(2)` }, root);
  css(el('rect', { x: 4, y: 7, width: 24, height: 19, rx: 5, 'vector-effect': 'non-scaling-stroke' }, mark), { fill: 'none', stroke: A, 'stroke-width': 1.8 });
  css(el('rect', { x: 12, y: 14, width: 24, height: 19, rx: 5, 'vector-effect': 'non-scaling-stroke' }, mark), { fill: mix(C.paper, 16), stroke: C.paper, 'stroke-opacity': 0.85, 'stroke-width': 1.4 });
  css(el('path', { d: 'M20 19.5v8l2.3-2 1.8 3.6 1.5-.7-1.8-3.5h3z' }, mark), { fill: C.paper });

  const nameL = el('g', null, root);
  let names = [], nameEls = [];
  const setNames = (list) => {
    clear(nameL);
    names = list.filter(Boolean).slice(0, 12);
    nameEls = names.map((n) => { const t = label(nameL, CX, 142, n); css(t, { opacity: 0 }); return t; });
  };

  return {
    view: [W, H],
    still: 2,
    update(d) { if (Array.isArray(d.names)) setNames(d.names); },
    frame(t) {
      ring.setAttribute('transform', `rotate(${((t / 120) * 360 % 360).toFixed(2)} ${CX} ${CY})`);
      glow.style.setProperty('opacity', (0.7 + 0.3 * Math.sin((t / 8) * Math.PI * 2)).toFixed(3));
      for (const o of dots) {
        const a = (t / o.per + o.ph) * Math.PI * 2;
        o.d.setAttribute('cx', (CX + o.r * Math.cos(a)).toFixed(2));
        o.d.setAttribute('cy', (CY + o.r * Math.sin(a)).toFixed(2));
      }
      if (nameEls.length) {
        const SLOT = 4.5, c = t / SLOT, i = Math.floor(c) % nameEls.length;
        nameEls.forEach((n, j) => n.style.setProperty('opacity', j === i ? (ctx.reduced ? 1 : Math.min(1, bump(frac(c)) * 1.6)).toFixed(3) : '0'));
        if (ctx.reduced && nameEls.length > 1) {
          // a still frame shows them all, joined
          nameEls.forEach((n, j) => n.style.setProperty('opacity', j === 0 ? '1' : '0'));
          nameEls[0].textContent = names.join(' · ').slice(0, 64);
        }
      }
    },
  };
}
