// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Monochrome "paper cut-out" device kit. Original, generic shapes:
// a monitor + small tower, a thin-bezel laptop, a low square box.
// Every device shares one unit system: ground line at y = H, body radius 6,
// screen radius 2, bezel 4.5, one non-scaling stroke weight.

import { el, set, css, clear, C, mix, STROKE, SHADOW, makeCtx } from './svg.js';

const R_BODY = 6;
const R_SCREEN = 2;
const BEZEL = 4.5;
const GROUND = 88;

// ---- shape builders (record parts with a role; painting depends on state) ----

function monitor(parts, x, w, h) {
  const footH = 5, footW = Math.round(w * 0.38), neckH = 12.5;
  const bodyY = GROUND - footH - neckH - h;
  parts.push({ role: 'body', tag: 'rect', a: { x, y: bodyY, width: w, height: h, rx: R_BODY } });
  const screen = { x: x + BEZEL, y: bodyY + BEZEL, w: w - 2 * BEZEL, h: h - 2 * BEZEL - 1.5 };
  parts.push({ role: 'screen', tag: 'rect', a: { x: screen.x, y: screen.y, width: screen.w, height: screen.h, rx: R_SCREEN }, screen });
  const cx = x + w / 2, nt = w * 0.055, nb = w * 0.08, ny = bodyY + h;
  parts.push({ role: 'part', tag: 'path', a: { d: `M${cx - nt} ${ny}H${cx + nt}L${cx + nb} ${GROUND - footH + 0.5}H${cx - nb}Z` } });
  parts.push({ role: 'body', tag: 'rect', a: { x: cx - footW / 2, y: GROUND - footH, width: footW, height: footH, rx: footH / 2 } });
  return screen;
}

function tower(parts, x, w, h) {
  const y = GROUND - h;
  parts.push({ role: 'body', tag: 'rect', a: { x, y, width: w, height: h, rx: R_BODY - 1 } });
  parts.push({ role: 'part', tag: 'rect', a: { x: x + 6.5, y: y + 17, width: 1.5, height: h - 27, rx: 0.75 } });
  parts.push({ role: 'led', tag: 'circle', a: { cx: x + w / 2, cy: y + 8.5, r: 2.1 } });
}

const KINDS = {
  'windows-pc': {
    W: 152, H: GROUND,
    build(p) { const s = monitor(p, 0, 114, 70); tower(p, 124, 28, 58); return [s]; },
  },
  'windows-pc-2': {
    W: 238, H: GROUND,
    build(p) { const a = monitor(p, 0, 114, 70); const b = monitor(p, 120, 84, 54); tower(p, 210, 28, 58); return [a, b]; },
  },
  macbook: {
    W: 150, H: GROUND,
    build(p) {
      const lidX = 17, lidW = 116, lidH = 75, rb = 1.5;
      p.push({ role: 'body', tag: 'path', a: { d:
        `M${lidX} ${lidH - rb}V${R_BODY}a${R_BODY} ${R_BODY} 0 0 1 ${R_BODY} -${R_BODY}H${lidX + lidW - R_BODY}` +
        `a${R_BODY} ${R_BODY} 0 0 1 ${R_BODY} ${R_BODY}V${lidH}H${lidX}Z` } });
      const b = 3.2;
      const screen = { x: lidX + b, y: b, w: lidW - 2 * b, h: lidH - b - 4.5 };
      p.push({ role: 'screen', tag: 'rect', a: { x: screen.x, y: screen.y, width: screen.w, height: screen.h, rx: R_SCREEN }, screen });
      p.push({ role: 'dot', tag: 'circle', a: { cx: lidX + lidW / 2, cy: 1.7, r: 0.75 } });
      p.push({ role: 'part', tag: 'rect', a: { x: lidX + 2, y: lidH - 0.5, width: lidW - 4, height: 2.5 } });
      p.push({ role: 'body', tag: 'path', a: { d: `M1 ${lidH + 1.5}H149L146.2 ${GROUND - 2.6}Q145 ${GROUND} 142 ${GROUND}H8Q5 ${GROUND} 3.8 ${GROUND - 2.6}Z` } });
      p.push({ role: 'part', tag: 'rect', a: { x: 63, y: lidH + 1.5, width: 24, height: 2, rx: 1 } });
      return [screen];
    },
  },
  'mac-mini': {
    W: 100, H: 26,
    build(p) {
      const H = 26;
      p.push({ role: 'top', tag: 'rect', a: { x: 3, y: 0, width: 94, height: 10, rx: 5 } });
      p.push({ role: 'body', tag: 'rect', a: { x: 0, y: 3.5, width: 100, height: 18.5, rx: R_BODY } });
      p.push({ role: 'part', tag: 'rect', a: { x: 9, y: H - 4.5, width: 82, height: 4.5, rx: 2.25 } });
      p.push({ role: 'led', tag: 'circle', a: { cx: 89, cy: 13, r: 1.3 } });
      return [];
    },
  },
};

export const KIND_NAMES = Object.keys(KINDS);
export const dims = (kind) => { const k = KINDS[kind] || KINDS['windows-pc']; return { W: k.W, H: k.H }; };

// Pick a kit kind for an API Device (or anything with a `kind`).
export function kindOf(d) {
  if (d && KINDS[d.kind]) return d.kind;
  if (d && d.os === 'macos') {
    if (d.battery) return 'macbook';
    return /book|laptop/i.test(d.name || '') ? 'macbook' : 'mac-mini';
  }
  return d && Array.isArray(d.screens) && d.screens.length >= 2 ? 'windows-pc-2' : 'windows-pc';
}

const NON_SCALING = { 'vector-effect': 'non-scaling-stroke' };

function paint(ctx, node, role, state, accent) {
  const ghost = state === 'offline';
  if (ghost) {
    if (role === 'dot' || role === 'led') return false;
    set(node, NON_SCALING);
    // Offline = the same device, powered down and dimmed: solid low-contrast paper with a
    // quiet outline and a dark, unlit screen (no dashed "placeholder box" look).
    if (role === 'part') {
      css(node, { fill: mix(C.paper, 20) });
    } else if (role === 'top') {
      css(node, { fill: mix(C.paper, 34), stroke: mix(C.paper, 40), 'stroke-width': STROKE });
    } else if (role === 'screen') {
      css(node, { fill: mix(C.cut, 88), stroke: mix(C.paper, 14), 'stroke-width': STROKE });
    } else {
      css(node, { fill: mix(C.paper, 26), stroke: mix(C.paper, 44), 'stroke-width': STROKE, 'stroke-linejoin': 'round' });
    }
    return true;
  }
  const fills = {
    body: ctx.bodyFill(),
    top: mix(C.paper, 72, '#ffffff'),
    part: C.paper2,
    screen: C.cut,
    dot: mix(C.cut, 80),
    led: state === 'active' ? accent : mix(C.cut, 70),
  };
  css(node, { fill: fills[role] });
  if (role === 'led' && state === 'active') css(node, { filter: `drop-shadow(0 0 2.5px ${accent})` });
  return true;
}

// Draw a device into `parent`. Returns a handle with screen rects in parent coordinates.
export function drawDevice(ctx, parent, kind, opts = {}) {
  const def = KINDS[kind] || KINDS['windows-pc'];
  const { x = 0, y = 0, scale = 1 } = opts;
  const accent = opts.accent || ctx.accent;
  const g = el('g', { transform: `translate(${x} ${y}) scale(${scale})` }, parent);
  const h = {
    g, kind, W: def.W, H: def.H, x, y, scale, screens: [], state: null,
    box: { x, y, w: def.W * scale, h: def.H * scale },
    setState(state) {
      if (state === h.state) return h;
      h.state = state = state === 'offline' || state === 'active' ? state : 'online';
      clear(g);
      const parts = [];
      const screens = def.build(parts);
      const body = el('g', null, g);
      css(body, { filter: state === 'offline' ? null : SHADOW, opacity: state === 'offline' ? 0.7 : null });
      for (const p of parts) {
        const n = el(p.tag, p.a, body);
        if (!paint(ctx, n, p.role, state, accent)) n.remove();
        if (p.role === 'screen' && state !== 'offline') {
          const s = p.screen;
          // a quiet diagonal reflection
          css(el('path', { d: `M${s.x} ${s.y}H${s.x + s.w * 0.92}L${s.x + s.w * 0.42} ${s.y + s.h}H${s.x}Z` }, body),
            { fill: 'rgba(255,255,255,.03)' });
          if (state === 'active') {
            const glow = el('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: R_SCREEN, ...NON_SCALING }, body);
            css(glow, { fill: ctx.glowFill(accent), stroke: mix(accent, 38), 'stroke-width': 1,
              filter: `drop-shadow(0 0 6px ${mix(accent, 30)})` });
          }
        }
      }
      h.screens = screens.map((s) => ({ x: x + s.x * scale, y: y + s.y * scale, w: s.w * scale, h: s.h * scale }));
      return h;
    },
  };
  h.setState(opts.state);
  return h;
}

// Public: a standalone SVG of one device.
export function device(kind, opts = {}) {
  const def = KINDS[kind] || KINDS['windows-pc'];
  const PAD_X = 8, PAD_T = 6, PAD_B = 12;
  const vw = def.W + 2 * PAD_X, vh = def.H + PAD_T + PAD_B;
  const svg = el('svg', {
    viewBox: `${-PAD_X} ${-PAD_T} ${vw} ${vh}`, 'aria-hidden': 'true', focusable: 'false',
    class: `od-device od-device-${kind in KINDS ? kind : 'windows-pc'}`,
  });
  svg.setAttribute('data-state', opts.state || 'online');
  css(svg, { overflow: 'visible' });
  const size = opts.size;
  if (typeof size === 'number' && size > 0) {
    set(svg, { width: size, height: Math.round((size * vh) / vw) });
  } else if (typeof size === 'string') {
    set(svg, { width: size });
  } else {
    css(svg, { width: '100%', height: 'auto' });
  }
  const ctx = makeCtx(svg, opts.accent);
  drawDevice(ctx, svg, kind, { state: opts.state, accent: opts.accent || ctx.accent });
  return svg;
}
