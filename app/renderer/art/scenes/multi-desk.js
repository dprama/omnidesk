// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Multi-device: the devices on one desk, each linked up to one shared point.
// Before the first update it shows a sample desk (PC, Mac mini, MacBook). update({ devices })
// draws exactly the devices given (up to 4, offline ones dimmed); no placeholders.

import { el, css, clear, frac, ease, bump, mix, C } from '../svg.js';
import { drawDevice, kindOf, dims } from '../kit.js';
import { W, H, label, deskLine, dotted, pulse, pathPoint } from './common.js';

const GROUND = 124;
const HUB = { x: 180, y: 22 };
const SCALE = { 'windows-pc-2': 0.56, 'windows-pc': 0.62, 'mac-mini': 0.7, macbook: 0.62 };
const SAMPLE = [
  { kind: 'windows-pc-2', name: 'Windows PC', online: true },
  { kind: 'mac-mini', name: 'Mac mini', online: true },
  { kind: 'macbook', name: 'MacBook', online: true },
];
const MAX = 4;

export default function multiDesk(ctx) {
  const root = el('g', null, ctx.svg);
  deskLine(ctx, root, GROUND);
  const linkL = el('g', null, root), devL = el('g', null, root), labL = el('g', null, root), pulseL = el('g', null, root);

  const hub = el('g', { transform: `translate(${HUB.x} ${HUB.y})` }, root);
  const halo = css(el('circle', { r: 11 }, hub), { fill: ctx.accent, 'fill-opacity': 0.08 });
  css(el('circle', { r: 4.6, 'vector-effect': 'non-scaling-stroke' }, hub), { fill: mix(ctx.accent, 10), stroke: ctx.accent, 'stroke-width': 1.25 });
  css(el('circle', { r: 1.7 }, hub), { fill: ctx.accent });

  let state = SAMPLE.map((s) => ({ ...s }));
  let links = [], sig = '';

  function build() {
    const key = JSON.stringify(state.map((s) => [s.kind, s.online, s.name]));
    if (key === sig) return;
    sig = key;
    [linkL, devL, labL, pulseL].forEach(clear);
    links = [];
    const gap = 20;
    // shrink everything together if the desk would overflow the view
    const raw = state.map((s) => dims(s.kind).W * SCALE[s.kind]);
    const need = raw.reduce((a, b) => a + b, 0) + gap * Math.max(0, state.length - 1);
    const fit = Math.min(1, (W - 24) / Math.max(1, need));
    const widths = raw.map((w) => w * fit);
    let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, state.length - 1))) / 2;
    state.forEach((s, i) => {
      const { H: dh } = dims(s.kind);
      const sc = SCALE[s.kind] * fit;
      const h = drawDevice(ctx, devL, s.kind, { x, y: GROUND - dh * sc, scale: sc, state: s.online ? 'online' : 'offline' });
      label(labL, x + widths[i] / 2, GROUND + 15, s.name);
      if (!s.online) css(label(labL, x + widths[i] / 2, GROUND + 25, 'offline'), { fill: C.ink4, 'font-size': '8.5px' });
      const ax = x + widths[i] / 2, ay = h.box.y - 5;
      const d = `M${ax} ${ay}Q${ax * 0.75 + HUB.x * 0.25} ${HUB.y + 2} ${HUB.x + (ax < HUB.x ? -6 : ax > HUB.x + 1 ? 6 : 0)} ${HUB.y + (Math.abs(ax - HUB.x) < 2 ? 6 : 0)}`;
      const path = dotted(linkL, d, s.online ? 0.22 : 0.07);
      links.push({ path, pt: pathPoint(path), p: s.online ? pulse(ctx, pulseL) : null, off: i / Math.max(1, state.length) });
      x += widths[i] + gap;
    });
  }
  build();

  return {
    view: [W, H],
    still: 2.0,
    update(data) {
      if (!Array.isArray(data.devices)) return;
      const list = data.devices.filter((d) => d && (d.thisDevice || d.paired !== false));
      // this device first, then online ones, then the rest; at most MAX on the desk
      const order = (d) => (d.thisDevice ? 0 : d.online !== false ? 1 : 2);
      state = list.slice().sort((a, b) => order(a) - order(b)).slice(0, MAX).map((d) => {
        const kind = kindOf(d);
        return { kind: SCALE[kind] ? kind : 'windows-pc', name: d.name || 'Computer', online: d.thisDevice || d.online !== false };
      });
      build();
    },
    frame(t) {
      const P = 6.6;
      for (const l of links) {
        if (!l.p) continue;
        const c = t / P + l.off, k = Math.floor(c), f = frac(c);
        const u = ease(f / 0.7);
        const along = k % 2 ? u : 1 - u; // alternately out to the device and back to the hub
        const pt = l.pt(along);
        l.p.at(pt.x, pt.y, f > 0.7 ? 0 : Math.pow(bump(u), 0.8) * 0.9);
      }
      halo.style.setProperty('fill-opacity', (0.07 + 0.05 * (0.5 + 0.5 * Math.sin((t / 5) * Math.PI * 2))).toFixed(3));
    },
  };
}
