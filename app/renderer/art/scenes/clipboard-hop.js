// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Clipboard: a small card lifts out of one screen and hops to the other.
// update({ enabled?: boolean, kind?: 'text'|'image'|'file', direction?: 'both'|'ltr'|'rtl',
//          names?: [left, right] })

import { el, css, clear, ease, seg, bump, lerp, frac, mix, C } from '../svg.js';
import { drawDevice, dims } from '../kit.js';
import { W, H, label, deskLine, dotted } from './common.js';

const GROUND = 122;
const P = 7.5;

export default function clipboardHop(ctx) {
  const A = ctx.accent;
  const root = el('g', null, ctx.svg);
  deskLine(ctx, root, GROUND);
  const s = 0.78;
  const lw = dims('macbook'), rw = dims('windows-pc');
  const left = drawDevice(ctx, root, 'macbook', { x: 30, y: GROUND - lw.H * s, scale: s });
  const right = drawDevice(ctx, root, 'windows-pc', { x: W - 30 - rw.W * s, y: GROUND - rw.H * s, scale: s });
  const labL = el('g', null, root);
  const flashes = [left.screens[0], right.screens[0]].map((r) => {
    const n = el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 1.6 }, root);
    css(n, { fill: ctx.glowFill(A), opacity: 0 });
    return n;
  });
  const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const a = center(left.screens[0]), b = center(right.screens[0]);
  const LIFT = 16;
  const ctrl = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 62 };
  const arc = dotted(root, `M${a.x} ${a.y - LIFT}Q${ctrl.x} ${ctrl.y} ${b.x} ${b.y - LIFT}`, 0.12);

  const card = el('g', null, root);
  const inner = el('g', null, card);
  let opts = { enabled: true, kind: 'text', direction: 'both', names: ['MacBook', 'Windows PC'] };

  function drawCard() {
    clear(inner);
    const body = el('path', { d: 'M-9 -12H4.5L10 -6.5V12H-9Z' }, inner);
    css(body, { fill: ctx.bodyFill(), filter: 'drop-shadow(0 3px 4px rgba(0,0,0,.4))' });
    css(el('path', { d: 'M4.5 -12V-6.5H10Z' }, inner), { fill: C.paper2 });
    if (opts.kind === 'image') {
      css(el('rect', { x: -5.5, y: -3, width: 12, height: 10, rx: 1.2 }, inner), { fill: mix(A, 30, '#2a303c') });
      css(el('path', { d: 'M-5.5 7L-1 2.5L2 5.5L4 3.5L6.5 7Z' }, inner), { fill: A, 'fill-opacity': 0.8 });
    } else if (opts.kind === 'file') {
      css(el('rect', { x: -5.5, y: 0, width: 12, height: 7, rx: 1.4 }, inner), { fill: 'none', stroke: A, 'stroke-width': 1.3 });
      css(el('path', { d: 'M-5.5 0V-2.6H-1L0.4 0' }, inner), { fill: 'none', stroke: A, 'stroke-width': 1.3, 'stroke-linejoin': 'round' });
    } else {
      [[-5.5, -4, 9], [-5.5, 0.5, 11.5], [-5.5, 5, 7]].forEach(([x, y, w], i) =>
        css(el('path', { d: `M${x} ${y}h${w}` }, inner), { stroke: i === 0 ? A : C.paper2, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    }
  }
  function drawLabels() {
    clear(labL);
    label(labL, left.box.x + left.box.w / 2, GROUND + 17, opts.names[0]);
    label(labL, right.box.x + right.box.w / 2, GROUND + 17, opts.names[1]);
  }
  drawCard();
  drawLabels();

  const quad = (u, p0, p2) => ({
    x: (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * ctrl.x + u * u * p2.x,
    y: (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * ctrl.y + u * u * p2.y,
  });

  return {
    view: [W, H],
    still: P * 0.44,
    update(d) {
      const prevKind = opts.kind;
      opts = { ...opts, ...d };
      if (d.kind && d.kind !== prevKind) drawCard();
      if (d.names) drawLabels();
      css(root, { opacity: opts.enabled === false ? 0.42 : null });
    },
    frame(t) {
      const c = t / P, k = Math.floor(c), p = frac(c);
      const ltr = opts.direction === 'ltr' ? true : opts.direction === 'rtl' ? false : k % 2 === 0;
      const from = ltr ? a : b, to = ltr ? b : a, sign = ltr ? 1 : -1;
      const off = opts.enabled === false;
      let x = from.x, y = from.y, sc = 1, op = 0, rot = 0;
      if (p < 0.14) { const q = ease(seg(p, 0, 0.14)); y = from.y - LIFT * q; sc = 0.6 + 0.4 * q; op = q; }
      else if (p < 0.22) { y = from.y - LIFT; op = 1; }
      else if (p < 0.68) {
        const u = ease(seg(p, 0.22, 0.68));
        const q = quad(u, { x: from.x, y: from.y - LIFT }, { x: to.x, y: to.y - LIFT });
        x = q.x; y = q.y; op = 1; rot = Math.sin(Math.PI * u) * 7 * sign;
      } else if (p < 0.82) {
        const v = ease(seg(p, 0.68, 0.82));
        x = to.x; y = to.y - LIFT * (1 - v); sc = 1 - 0.4 * v; op = 1 - v;
      }
      if (off) { x = lerp(a.x, b.x, 0.5); y = ctrl.y + 30; op = 0; }
      card.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)}) scale(${sc.toFixed(3)})`);
      card.style.setProperty('opacity', op.toFixed(3));
      const land = bump(seg(p, 0.7, 0.98));
      const lift = bump(seg(p, 0.0, 0.26));
      flashes[0].style.setProperty('opacity', (off ? 0 : (ltr ? lift : land) * 0.9).toFixed(3));
      flashes[1].style.setProperty('opacity', (off ? 0 : (ltr ? land : lift) * 0.9).toFixed(3));
      arc.style.setProperty('stroke-opacity', (off ? 0.06 : 0.1 + 0.06 * bump(seg(p, 0.18, 0.72))).toFixed(3));
    },
  };
}
