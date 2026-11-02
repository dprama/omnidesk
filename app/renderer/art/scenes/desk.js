// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Home: the desk with the devices; a soft dotted link pulses between online neighbours.
// update({ devices: Device[], cursorOn?: deviceId })

import { el, css, clear, frac, ease, bump, C } from '../svg.js';
import { drawDevice, kindOf, dims } from '../kit.js';
import { W, H, label, deskLine, dotted, pulse, pathPoint } from './common.js';

const GROUND = 120;
const DEFAULT = [
  { id: 'this', name: 'Windows PC', kind: 'windows-pc-2', online: true },
  { id: 'mac', name: 'MacBook', kind: 'macbook', online: true },
];

export default function desk(ctx) {
  const root = el('g', null, ctx.svg);
  deskLine(ctx, root, GROUND);
  const linkL = el('g', null, root), devL = el('g', null, root), labL = el('g', null, root), pulseL = el('g', null, root);
  let links = [], sig = '';

  function build(list, activeId) {
    list = (list && list.length ? list : DEFAULT).slice(0, 3);
    const items = list.map((d) => ({ d, kind: kindOf(d), ...dims(kindOf(d)) }));
    const key = JSON.stringify([items.map((i) => [i.d.id, i.kind, i.d.online !== false, i.d.name]), activeId]);
    if (key === sig) return;
    sig = key;
    [linkL, devL, labL, pulseL].forEach(clear);
    links = [];

    const gap = items.length > 2 ? 26 : 40;
    const sumW = items.reduce((a, i) => a + i.W, 0);
    const maxH = Math.max(...items.map((i) => i.H));
    const s = Math.min(0.74, (W - 30 - gap * (items.length - 1)) / sumW, 92 / maxH);
    let x = (W - (sumW * s + gap * (items.length - 1))) / 2;
    const placed = items.map((i) => {
      const online = i.d.online !== false;
      const state = !online ? 'offline' : activeId != null && i.d.id === activeId ? 'active' : 'online';
      const h = drawDevice(ctx, devL, i.kind, { x, y: GROUND - i.H * s, scale: s, state });
      label(labL, x + (i.W * s) / 2, GROUND + 15, i.d.name || 'Device');
      if (!online) css(label(labL, x + (i.W * s) / 2, GROUND + 26, 'offline'), { fill: C.ink4, 'font-size': '8.5px' });
      x += i.W * s + gap;
      const scr = h.screens[h.screens.length - 1] || h.screens[0];
      const yMid = scr ? scr.y + scr.h / 2 : h.box.y + h.box.h / 2;
      return { h, online, yMid, yLeft: (h.screens[0] ? h.screens[0].y + h.screens[0].h / 2 : yMid) };
    });
    for (let i = 0; i + 1 < placed.length; i++) {
      const a = placed[i], b = placed[i + 1];
      const x0 = a.h.box.x + a.h.box.w + 6, x1 = b.h.box.x - 6, y0 = a.yMid, y1 = b.yLeft;
      const both = a.online && b.online;
      const d = `M${x0} ${y0}Q${(x0 + x1) / 2} ${Math.min(y0, y1) - 12} ${x1} ${y1}`;
      const path = dotted(linkL, d, both ? 0.24 : 0.08);
      links.push({ path, both, pt: pathPoint(path), p: both ? pulse(ctx, pulseL) : null, off: i * 1.7 });
    }
  }

  build(null, null);

  return {
    view: [W, H],
    still: 2.4,
    update(data) { build(data.devices, data.cursorOn ?? data.activeId ?? null); },
    frame(t) {
      for (const l of links) {
        if (!l.p) continue;
        const P = 5.2, c = (t + l.off) / P, k = Math.floor(c), u = ease(frac(c) / 0.82);
        const along = k % 2 ? 1 - u : u;
        const pt = l.pt(along);
        l.p.at(pt.x, pt.y, frac(c) > 0.82 ? 0 : Math.pow(bump(u), 0.8) * 0.95);
        l.path.style.setProperty('stroke-opacity', (0.2 + 0.08 * Math.sin((t / 6) * Math.PI * 2)).toFixed(3));
      }
    },
  };
}
