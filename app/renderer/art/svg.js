// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Small SVG helpers shared by the device kit and the scenes.
// Colors go through el.style.setProperty (CSSOM is allowed by the CSP; style="" is not),
// so CSS custom properties from tokens.css apply, with fallbacks when they are missing.

export const NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  if (attrs) set(n, attrs);
  if (parent) parent.appendChild(n);
  return n;
}

export function set(n, attrs) {
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) n.removeAttribute(k);
    else n.setAttribute(k, typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
  }
  return n;
}

export function css(n, props) {
  for (const k in props) {
    const v = props[k];
    if (v == null) n.style.removeProperty(k);
    else n.style.setProperty(k, String(v));
  }
  return n;
}

export function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
}

const v = (name, fallback) => `var(${name}, ${fallback})`;

// Monochrome kit palette. Accent is supplied per call.
export const C = {
  paper: v('--paper', '#cdd1d9'),
  paper2: v('--paper-2', '#9ea4b0'),
  cut: v('--paper-cut', '#151920'),
  ink3: v('--ink-3', '#808999'),
  ink4: v('--ink-4', '#596170'),
  bg: v('--bg', '#0c0e13'),
  font: v('--font', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'),
  mono: v('--mono', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'),
};

export const DEFAULT_ACCENT = v('--a', '#c9d2e3');

export const mix = (color, pct, other = 'transparent') =>
  `color-mix(in oklab, ${color} ${pct}%, ${other})`;

// One stroke weight for the whole kit, in screen pixels.
export const STROKE = 1.25;

export const SHADOW =
  'drop-shadow(0 1px 0 rgba(0,0,0,.42)) drop-shadow(0 6px 9px rgba(0,0,0,.30))';

let counter = 0;
export const uid = (p) => `od-${p}-${(++counter).toString(36)}`;

// Per-SVG context: a <defs> plus cached gradients (ids are unique per document).
export function makeCtx(svg, accent) {
  const defs = el('defs', null, svg);
  const cache = new Map();
  const ctx = {
    svg, defs, accent: accent || DEFAULT_ACCENT, reduced: false, now: () => 0,
    gradient(key, build) {
      if (!cache.has(key)) { const id = uid('g'); build(id); cache.set(key, `url(#${id})`); }
      return cache.get(key);
    },
    // Paper body: lit from above, fading slightly towards the desk.
    bodyFill() {
      return ctx.gradient('body', (id) => {
        const g = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        css(el('stop', { offset: 0 }, g), { 'stop-color': mix(C.paper, 92, '#0c0e13') });
        css(el('stop', { offset: 1 }, g), { 'stop-color': mix(C.paper, 74, '#0c0e13') });
      });
    },
    // Soft accent light on a screen.
    glowFill(color) {
      return ctx.gradient('glow:' + color, (id) => {
        const g = el('radialGradient', { id, cx: 0.5, cy: 0.62, r: 0.8 }, defs);
        css(el('stop', { offset: 0 }, g), { 'stop-color': color, 'stop-opacity': 0.34 });
        css(el('stop', { offset: 0.65 }, g), { 'stop-color': color, 'stop-opacity': 0.12 });
        css(el('stop', { offset: 1 }, g), { 'stop-color': color, 'stop-opacity': 0.04 });
      });
    },
    // Horizontal line that fades out at both ends (the desk).
    fadeLine(x0, x1, opacity = 0.16) {
      return ctx.gradient(`fade:${x0}:${x1}:${opacity}`, (id) => {
        const g = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x0, y1: 0, x2: x1, y2: 0 }, defs);
        [[0, 0], [0.22, opacity], [0.78, opacity], [1, 0]].forEach(([o, a]) =>
          css(el('stop', { offset: o }, g), { 'stop-color': '#ffffff', 'stop-opacity': a }));
      });
    },
  };
  return ctx;
}

// Easing and timing.
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t)); // sine in-out
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const easeIn = (t) => Math.pow(clamp(t), 2);
export const seg = (p, a, b) => clamp((p - a) / (b - a));
export const bump = (t) => Math.sin(Math.PI * clamp(t));
export const frac = (x) => x - Math.floor(x);
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
