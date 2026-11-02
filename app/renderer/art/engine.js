// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// Scene runner: one SVG per host, sized by ResizeObserver, one requestAnimationFrame
// loop that pauses when the tab is hidden or the host is off-screen. With reduced
// motion it draws a single still frame (again after each update/resize) and never loops.

import { el, css, makeCtx } from './svg.js';

export function runScene(host, opts, def) {
  const prefers = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduced = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : prefers;

  const svg = el('svg', { 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid meet', class: 'od-scene' });
  css(svg, { display: 'block', width: '100%', height: '100%', overflow: 'visible' });
  host.appendChild(svg);

  let t = 0, last = 0, raf = 0, alive = true, onScreen = true, sized = true;
  const ctx = makeCtx(svg, opts.accent);
  ctx.reduced = reduced;
  ctx.now = () => t;

  const s = def(ctx) || {};
  if (s.view) svg.setAttribute('viewBox', `0 0 ${s.view[0]} ${s.view[1]}`);
  const STILL = typeof s.still === 'number' ? s.still : 0;
  if (reduced) t = STILL;

  const canRun = () => alive && !reduced && onScreen && sized && !document.hidden;
  const tick = (now) => {
    raf = 0;
    if (!canRun()) { last = 0; return; }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    t += dt;
    s.frame && s.frame(t, dt);
    raf = requestAnimationFrame(tick);
  };
  const schedule = () => { if (!raf && canRun()) raf = requestAnimationFrame(tick); };
  const halt = () => { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; };
  const draw = () => { if (alive && s.frame) s.frame(t, 0); };

  const onVis = () => { if (document.hidden) halt(); else schedule(); };
  document.addEventListener('visibilitychange', onVis);

  let ro = null, io = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      sized = r.width > 0 && r.height > 0;
      if (sized && s.resize) s.resize(r.width, r.height);
      if (sized) draw();
      sized ? schedule() : halt();
    });
    ro.observe(host);
  }
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      onScreen ? schedule() : halt();
    });
    io.observe(host);
  }

  if (s.resize) {
    const r = host.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) s.resize(r.width, r.height);
  }
  draw();
  schedule();

  return {
    update(data) {
      if (!alive || data == null) return;
      s.update && s.update(data);
      draw();
    },
    stop() {
      if (!alive) return;
      alive = false;
      halt();
      document.removeEventListener('visibilitychange', onVis);
      ro && ro.disconnect();
      io && io.disconnect();
      s.dispose && s.dispose();
      svg.remove();
    },
  };
}
