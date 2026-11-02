// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// About: version from app.info(), licence, credits (verbatim), fonts and a link to the source.

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene } from '../art/index.js';


const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const SOURCE = 'https://github.com/dprama/omnidesk';
const LICENCE = 'https://github.com/dprama/omnidesk/blob/main/LICENSE';
const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const SVG_NS = 'http://www.w3.org/2000/svg';

function logo() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<defs><linearGradient id="about-spec" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#5fd4e8"/><stop offset=".3" stop-color="#a98bff"/><stop offset=".55" stop-color="#f483a6"/>' +
    '<stop offset=".8" stop-color="#f2b860"/><stop offset="1" stop-color="#52d6aa"/></linearGradient></defs>' +
    '<rect x="4" y="7" width="24" height="19" rx="5" fill="none" stroke="url(#about-spec)" stroke-width="2.4"/>' +
    '<rect x="12" y="14" width="24" height="19" rx="5" fill="rgba(215,219,227,.16)" stroke="rgba(235,238,244,.85)" stroke-width="1.6"/>' +
    '<path d="M20 19.5v8l2.3-2 1.8 3.6 1.5-.7-1.8-3.5h3z" fill="#eef1f6"/>';
  return svg;
}

export default {
  id: 'about', label: 'About', tab: 'About', group: 'more', accent: 'var(--c-about)', icon: 'about',

  mount(el, api, shell) {
    let alive = true;

    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Version …');
    const vNum = h('span.num', null, '…'), eNum = h('span.num', null, '…'), lic = h('span', null, 'GPL-2.0-only');
    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    el.replaceChildren(h('header.lh', null,
      h('div', null, kick, h('h1', null, 'About OmniDesk'), h('p.sub', null, 'One desk for all your computers.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Version'), h('dd', null, vNum)),
          h('div', null, h('dt', null, 'Engine'), h('dd', null, eNum)),
          h('div', null, h('dt', null, 'Licence'), h('dd', null, lic)))),
      sceneHost));
    const sc = scene('about-credits', sceneHost, { accent: 'var(--c-about)', reducedMotion: shell.reducedMotion });
    sc.update({ names: ['Deskflow Developers', 'Synergy App Ltd', 'Chris Schoeneman', 'Virtual Display Driver'] });

    const title = h('h2', null, 'OmniDesk');
    const licLine = h('p.muted', null, 'Licensed under GPL-2.0-only.');
    const kv = h('dl.kv');
    const extErr = h('p.err.ext-err', { role: 'alert', hidden: true });
    const open = async (url, what) => {
      extErr.hidden = true;
      try {
        await api.app.openExternal(url);
        if (alive) shell.toast(`Opened ${what} in your browser`);
      } catch (e) {
        if (!alive) return;
        extErr.textContent = errText(e);
        extErr.hidden = false;
      }
    };
    const src = h('button.btn.btn-primary', { type: 'button' }, icon('link'), 'Source code on GitHub');
    src.addEventListener('click', () => open(SOURCE, 'the source code'));
    const licBtn = h('button.btn', { type: 'button' }, 'Read the licence');
    licBtn.addEventListener('click', () => open(LICENCE, 'the licence'));

    el.append(h('div.grid-2', null,
      h('section.card', { 'aria-label': 'OmniDesk' },
        h('div.about-top', null, logo(), h('div', null, title, licLine)),
        h('p.hint', null, 'One mouse, one keyboard and one clipboard across your computers, plus a laptop as a second screen. Free and open source, no account, no cloud.'),
        kv,
        h('div.btns', null, src, licBtn),
        extErr),
      h('section.card.credits', { 'aria-labelledby': 'about-cred-h' },
        h('h2', { id: 'about-cred-h' }, 'Credits'),
        h('p', null, 'Built on Deskflow (github.com/deskflow/deskflow). Copyright (C) 2025 Deskflow Developers, (C) 2012 Synergy App Ltd, (C) 2002 Chris Schoeneman.'),
        h('p', null, 'Second screen on Windows uses Virtual Display Driver (MIT).'),
        h('h3', null, 'Fonts'),
        h('p', null, 'Figtree and JetBrains Mono, both under the SIL Open Font License 1.1. Bundled with the app, never loaded from the internet.'))));

    api.app.info().then((i) => {
      if (!alive || !i) return;
      setText(kick.lastChild, `Version ${i.version}`);
      setText(vNum, i.version);
      setText(eNum, i.engineVersion || '—');
      setText(lic, i.licence || 'GPL-2.0-only');
      setText(title, `OmniDesk ${i.version}`);
      setText(licLine, `Licensed under ${i.licence || 'GPL-2.0-only'}.`);
      kv.replaceChildren(
        h('dt', null, 'App'), h('dd', null, h('span.num', null, i.version)),
        h('dt', null, 'Engine'), h('dd', null, h('span.num', null, i.engineVersion || '—')),
        h('dt', null, 'This computer'), h('dd', null, `${OS_NAMES[i.os] || i.os} ${i.osVersion || ''} · ${i.arch}`.trim()));
    }).catch((e) => {
      if (!alive) return;
      setText(kick.lastChild, 'Version unknown');
      setText(vNum, '—'); setText(eNum, '—');
      kv.replaceChildren(h('dt', null, 'Version'), h('dd', null, h('span.err', null, errText(e))));
    });

    return () => {
      alive = false;
      sc.stop();
    };
  },
};
