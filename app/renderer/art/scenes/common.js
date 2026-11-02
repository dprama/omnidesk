// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

import { el, css, C, mix, STROKE } from '../svg.js';

export const W = 360;
export const H = 150;

export function label(parent, x, y, text, anchor = 'middle') {
  const t = el('text', { x, y, 'text-anchor': anchor }, parent);
  css(t, { fill: C.ink3, font: `500 9.5px ${C.font}`, 'letter-spacing': '.02em' });
  t.textContent = short(text);
  return t;
}

export const short = (s, n = 22) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// The desk: a hairline that fades out at both ends.
export function deskLine(ctx, parent, y, x0 = 10, x1 = W - 10) {
  const l = el('line', { x1: x0, y1: y, x2: x1, y2: y }, parent);
  css(l, { stroke: ctx.fadeLine(x0, x1, 0.15), 'stroke-width': 1 });
  return l;
}

// A dotted link (round dots), quiet by default.
export function dotted(parent, d, opacity = 0.22) {
  const p = el('path', { d, 'vector-effect': 'non-scaling-stroke' }, parent);
  css(p, { fill: 'none', stroke: '#ffffff', 'stroke-opacity': opacity, 'stroke-width': 1.6,
    'stroke-linecap': 'round', 'stroke-dasharray': '0.01 5' });
  return p;
}

// A soft travelling light: halo + core.
export function pulse(ctx, parent, accent = ctx.accent) {
  const g = el('g', null, parent);
  css(el('circle', { r: 7 }, g), { fill: accent, 'fill-opacity': 0.12 });
  css(el('circle', { r: 2.4 }, g), { fill: accent });
  css(g, { opacity: 0 });
  return {
    g,
    at(x, y, o) { g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`); g.style.setProperty('opacity', o.toFixed(3)); },
  };
}

export function pathPoint(path) {
  const len = path.getTotalLength();
  return (p) => path.getPointAtLength(Math.max(0, Math.min(1, p)) * len);
}

export function outline(node, color, width = STROKE) {
  node.setAttribute('vector-effect', 'non-scaling-stroke');
  return css(node, { stroke: color, 'stroke-width': width, fill: 'none' });
}

export { mix, C };
