// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Small page behaviours: the feature folders (tabs) and copy buttons.
// Everything works without this file; it only adds the folder stack and copying.
(function () {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- feature folders ----------
  function folders(root) {
    const wrap = root.querySelector('[data-tabs-wrap]');
    const tabs = Array.from(root.querySelectorAll('[role=tab]'));
    const sheets = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
    const ghosts = Array.from(root.querySelectorAll('[data-ghost]'));
    if (!wrap || !tabs.length || sheets.some((s) => !s)) return;
    const accent = (el) => Array.from(el.classList).find((c) => c.startsWith('c-')) || '';

    root.classList.add('js-tabs');
    wrap.hidden = false;
    sheets.forEach((s, i) => { s.setAttribute('role', 'tabpanel'); s.setAttribute('aria-labelledby', tabs[i].id); s.tabIndex = 0; });

    function select(i, focus) {
      tabs.forEach((t, j) => {
        const on = i === j;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        sheets[j].hidden = !on;
      });
      // The folders behind show the next two tabs' colours on their top edge.
      ghosts.forEach((g, k) => {
        const next = tabs[(i + ghosts.length - k) % tabs.length];
        g.className = g.className.replace(/\bc-[a-z]+\b/g, '').trim() + ' ' + accent(next);
      });
      const s = sheets[i];
      if (!reduced.matches) { s.classList.remove('enter'); void s.offsetWidth; s.classList.add('enter'); }
      if (focus) { tabs[i].focus(); tabs[i].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    }

    tabs.forEach((t, i) => {
      t.addEventListener('click', (e) => { e.preventDefault(); select(i, false); });
      t.addEventListener('keydown', (e) => {
        let j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        else if (e.key === ' ') j = i;
        if (j >= 0) { e.preventDefault(); select(j, true); }
      });
    });
    const fromHash = tabs.findIndex((t) => t.getAttribute('href') === location.hash);
    select(fromHash >= 0 ? fromHash : 0, false);
  }

  // ---------- copy buttons ----------
  function copyButtons() {
    for (const btn of document.querySelectorAll('[data-copy]')) {
      const src = btn.parentElement && btn.parentElement.querySelector('[data-copy-src]');
      if (!src) continue;
      btn.hidden = false;
      const label = btn.querySelector('span');
      btn.setAttribute('aria-label', 'Copy command');
      let timer = 0;
      btn.addEventListener('click', async () => {
        const text = src.textContent.trim();
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch {
          // Older browsers: select the text so Cmd+C works.
          const r = document.createRange(); r.selectNodeContents(src);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        }
        if (label) label.textContent = ok ? 'Copied' : 'Press ⌘C';
        btn.classList.toggle('copied', ok);
        clearTimeout(timer);
        timer = setTimeout(() => { if (label) label.textContent = 'Copy'; btn.classList.remove('copied'); }, 2200);
      });
    }
  }

  document.querySelectorAll('[data-folders]').forEach(folders);
  copyButtons();
})();
