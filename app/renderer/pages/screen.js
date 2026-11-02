// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Second screen, both ways: use the other computer as an extra display for this one, or
// this one as a display for the other. Picture options, live latency and frame rate,
// and a plain explanation when it can't run (offline peer, missing permission, ...).

import { h, setText } from '../shell/dom.js';
import { icon, LINK_LABELS } from '../shell/icons.js';
import { scene, device } from '../art/index.js';

const css = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) el.style.removeProperty(k); else el.style.setProperty(k, String(v));
  }
  return el;
};
const errText = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong. Try again.';
const resLabel = (r) => String(r).replace('x', '×');
const QUALITY = { latency: 'Lowest latency', balanced: 'Balanced', sharp: 'Sharpest' };
const QUALITY_HINT = {
  latency: 'Fastest response. Text can look a little soft while things move.',
  balanced: 'Good for most work: crisp text, smooth scrolling.',
  sharp: 'Sharpest picture for photos and design. Adds a few milliseconds.',
};
const kindOf = (d) => (!d ? 'windows-pc' : d.os === 'macos' ? (d.battery ? 'macbook' : 'mac-mini') : (d.screens && d.screens.length > 1 ? 'windows-pc-2' : 'windows-pc'));

export default {
  id: 'screen', label: 'Second screen', tab: 'Screen', group: 'share',
  accent: 'var(--c-screen)', icon: 'screen',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    const S = {
      scr: null, devices: [],
      opts: { resolution: '1920x1080', refresh: 60, quality: 'balanced' },
      pending: new Set(), errs: {}, linkBusy: false, linkErr: null,
    };

    /* ----- header ----- */
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), h('span', null, 'Loading'));
    const vStatus = h('span', null, '…');
    const vLat = h('span.num', null, '–');
    const vFps = h('span.num', null, '–');
    const sceneHost = h('div.lh-scene');
    const header = h('header.lh', null,
      h('div', null, kick,
        h('h1', null, 'Second screen'),
        h('p.sub', null, 'Turn the other computer into an extra display. Drag windows onto it like any monitor; your mouse and keyboard keep working across both.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Status'), h('dd', null, vStatus)),
          h('div', null, h('dt', null, 'Latency'), h('dd', null, vLat, h('span.u', null, 'ms'))),
          h('div', null, h('dt', null, 'Frame rate'), h('dd', null, vFps, h('span.u', null, 'fps'))))),
      sceneHost);

    const topNote = h('div.note', { hidden: true });
    css(topNote, { 'margin-bottom': '16px' });
    const cardsWrap = h('div.grid-2');

    /* ----- picture card ----- */
    const resSeg = h('div.seg', { role: 'group', 'aria-label': 'Resolution' });
    const refSeg = h('div.seg', { role: 'group', 'aria-label': 'Refresh rate' });
    const qSeg = h('div.seg', { role: 'group', 'aria-label': 'Quality' });
    const qHint = h('div.d');
    const pictureHint = h('p.hint', null, 'Used the next time you start a second screen.');
    const rowRes = h('div.row', null, h('b', null, 'Resolution'), h('div', null, resSeg));
    const rowRef = h('div.row', null, h('div', null, h('b', null, 'Refresh rate'), h('div.d', null, 'The rate the extra display runs at.')), refSeg);
    const rowQ = h('div.row', null, h('b', null, 'Quality'), h('div', null, qSeg), qHint);
    for (const r of [rowRes, rowQ]) { css(r, { display: 'block' }); css(r.children[1], { 'margin-top': '8px' }); }
    css(qHint, { 'margin-top': '8px' });
    const picture = h('section.card', null, h('h2', null, 'Picture'), pictureHint, rowRes, rowRef, rowQ);

    /* ----- measured card ----- */
    const bigLat = h('span.num', null, '–');
    css(bigLat, { 'font-size': '40px', 'font-weight': '600', 'letter-spacing': '-.02em' });
    const latUnit = h('span.u', null, 'ms');
    const fpsLine = h('p.hint');
    const linkHint = h('p.hint');
    const linkBtns = h('div.btns');
    const linkErr = h('p.err', { role: 'alert', hidden: true });
    const latRow = h('div', { 'aria-live': 'off' }, bigLat, latUnit);
    css(latRow, { margin: '8px 0 2px' });
    const measured = h('section.card', null, h('h2', null, 'Measured latency'), latRow, fpsLine, linkHint, linkBtns, linkErr);

    const lower = h('div.grid-2', null, picture, measured);
    css(lower, { 'margin-top': '16px' });
    el.replaceChildren(header, topNote, cardsWrap, lower);

    let sc = null;
    try { sc = scene('display-slide', sceneHost, { accent: 'var(--c-screen)', reducedMotion: shell.reducedMotion }); }
    catch (e) { console.warn('[screen] scene', e); }

    /* ----- derived ----- */
    const me = () => S.devices.find((d) => d.thisDevice || d.id === 'this') || null;
    const devById = (id) => S.devices.find((d) => d.id === id) || null;
    const nameOf = (id) => (devById(id) || {}).name || (id === 'this' ? 'This computer' : 'the other computer');
    function peer() {
      const ps = S.devices.filter((d) => !d.thisDevice && d.paired !== false);
      const sess = S.scr && S.scr.sessions[0];
      if (sess) { const other = devById(sess.sourceId === (me() || {}).id ? sess.targetId : sess.sourceId); if (other) return other; }
      const score = (d) => (d.online ? 4 : 0) + (d.battery ? 2 : 0) + (d.os !== (me() || {}).os ? 1 : 0);
      return ps.sort((a, b) => score(b) - score(a))[0] || null;
    }
    const sessions = () => (S.scr && S.scr.sessions) || [];
    const sessionFor = (src, dst) => sessions().find((s) => s.sourceId === src && s.targetId === dst) || null;
    const liveSession = () => sessions().find((s) => s.state === 'live') || sessions()[0] || null;

    /* ----- direction cards ----- */
    const cards = {};
    function buildCard(key) {
      const art = h('div', { 'aria-hidden': 'true' });
      css(art, { display: 'flex', 'align-items': 'flex-end', 'justify-content': 'center', gap: '14px', 'min-height': '84px', margin: '2px 0 14px' });
      const title = h('h3');
      const hint = h('p.hint');
      const pill = h('span.pill');
      const btn = h('button.btn', { type: 'button' });
      const why = h('div.note', { hidden: true });
      css(why, { 'margin-top': '14px' });
      const err = h('p.err', { role: 'alert', hidden: true });
      const stats = h('p.hint', { hidden: true });
      const btns = h('div.btns', null, btn, pill);
      css(btns, { 'align-items': 'center' });
      const card = h('section.card', null, art, title, hint, btns, stats, why, err);
      btn.addEventListener('click', () => onCardButton(key));
      cards[key] = { card, art, title, hint, pill, btn, why, err, stats, artSig: '' };
      return card;
    }
    cardsWrap.append(buildCard('extend'), buildCard('show'));

    function arrowEl() {
      const a = icon('arrow', 'icon');
      css(a, { width: '22px', height: '22px', color: 'var(--a)', 'margin-bottom': '26px', flex: 'none' });
      return a;
    }

    // extend: this computer gets an extra display, shown on the peer (source this, target peer)
    // show:   the peer gets an extra display, shown on this computer (source peer, target this)
    function dirOf(key) {
      const m = me(), p = peer();
      if (!m || !p) return null;
      return key === 'extend' ? { src: m, dst: p } : { src: p, dst: m };
    }
    function canOf(key) {
      const can = (S.scr && S.scr.can) || {};
      const ok = key === 'extend' ? can.extendThis : can.showHere;
      return { ok: ok !== false && !!S.scr, why: can.why };
    }

    function renderCard(key) {
      const C = cards[key];
      const d = dirOf(key);
      if (!d) { C.card.hidden = true; return; }
      C.card.hidden = false;
      setText(C.title, `Use ${d.dst.name} as a screen for ${d.src.name}`);
      setText(C.hint, key === 'extend'
        ? `${d.dst.name} shows an extra monitor for this computer. Its own desktop waits underneath.`
        : `This computer shows an extra monitor for ${d.src.name}, full screen. Press Esc twice to stop.`);
      const artSig = [kindOf(d.src), kindOf(d.dst), d.src.online, d.dst.online].join();
      const s = sessionFor(d.src.id, d.dst.id);
      if (C.artSig !== artSig + !!s) {
        C.artSig = artSig + !!s;
        const a = device(kindOf(d.src), { size: kindOf(d.src).startsWith('windows') ? 104 : 88, accent: 'var(--c-screen)', state: d.src.online ? 'online' : 'offline' });
        const b = device(kindOf(d.dst), { size: kindOf(d.dst).startsWith('windows') ? 104 : 88, accent: 'var(--c-screen)', state: !d.dst.online ? 'offline' : s ? 'active' : 'online' });
        C.art.replaceChildren(a, arrowEl(), b);
      }
      const other = sessions().find((x) => x !== s);
      const can = canOf(key);
      const pending = S.pending.has(key);
      C.btn.replaceChildren();
      C.btn.className = 'btn';
      if (s) {
        const label = s.state === 'starting' ? 'Cancel' : s.state === 'stopping' ? 'Stopping…' : 'Stop';
        C.btn.append(icon('power'), label);
        // Starting can take a while (driver, permission prompt): it can always be cancelled.
        C.btn.disabled = pending || s.state === 'stopping';
        C.btn.setAttribute('aria-label', `${label === 'Stopping…' ? 'Stopping' : label} second screen on ${d.dst.name}`);
        const dot = s.state === 'live' ? 'dot-good' : 'dot-warn';
        const text = s.state === 'live' ? `Live · ${resLabel(s.resolution)} · ${s.refresh} Hz · ${QUALITY[s.quality] || s.quality}`
          : s.state === 'starting' ? 'Starting the virtual display…' : 'Stopping…';
        C.pill.replaceChildren(h('i', { class: dot }), text);
        C.pill.hidden = false;
        C.stats.hidden = s.state !== 'live';
        setText(C.stats, s.state === 'live' ? `${s.latencyMs} ms latency · ${s.fps} fps` : '');
      } else {
        C.btn.classList.add('btn-primary');
        C.btn.append(icon('power'), pending ? 'Starting…' : 'Start');
        C.btn.setAttribute('aria-label', `Start: use ${d.dst.name} as a screen for ${d.src.name}`);
        const blocked = !can.ok || !!other || !d.src.online || !d.dst.online;
        C.btn.disabled = pending || blocked;
        C.stats.hidden = true;
        if (other) { C.pill.replaceChildren(h('i.dot-off'), 'Stop the other direction first'); C.pill.hidden = false; }
        else C.pill.hidden = true;
      }
      // why it can't run, in plain words
      let why = null;
      if (!s && !can.ok) why = can.why || (key === 'extend' ? 'This computer can\'t add a virtual display right now.' : 'This computer can\'t show a second screen right now.');
      else if (!s && !d.dst.online) why = `${d.dst.name} is offline.`;
      else if (!s && !d.src.online) why = `${d.src.name} is offline.`;
      if (why) {
        C.why.replaceChildren(icon('alert'), h('p', null, why));
        C.why.hidden = false;
      } else C.why.hidden = true;
      if (S.errs[key]) { C.err.textContent = S.errs[key]; C.err.hidden = false; } else C.err.hidden = true;
      css(C.card, { 'border-color': s && s.state === 'live' ? 'color-mix(in oklab, var(--a) 45%, transparent)' : null });
    }

    async function onCardButton(key) {
      const d = dirOf(key);
      if (!d) return;
      const s = sessionFor(d.src.id, d.dst.id);
      S.errs[key] = null;
      S.pending.add(key);
      renderCard(key);
      try {
        if (s) {
          await api.screen.stop(s.id);
          if (alive) shell.toast('Second screen stopped');
        } else {
          await api.screen.start({ sourceId: d.src.id, targetId: d.dst.id, resolution: S.opts.resolution, refresh: S.opts.refresh, quality: S.opts.quality });
          if (alive) shell.toast(`Starting second screen on ${d.dst.name}`);
        }
      } catch (e) {
        if (alive) S.errs[key] = errText(e);
      } finally {
        if (alive) { S.pending.delete(key); renderAll(); }
      }
    }

    /* ----- picture options ----- */
    let optSig = '';
    function renderOptions() {
      const o = (S.scr && S.scr.options) || { resolutions: ['1920x1080', '2560x1600'], refresh: [60], quality: ['latency', 'balanced', 'sharp'] };
      if (!o.resolutions.includes(S.opts.resolution)) S.opts.resolution = o.resolutions[0];
      if (!o.refresh.includes(S.opts.refresh)) S.opts.refresh = o.refresh[0];
      if (!o.quality.includes(S.opts.quality)) S.opts.quality = o.quality.includes('balanced') ? 'balanced' : o.quality[0];
      const sig = JSON.stringify([o, S.opts]);
      setText(qHint, QUALITY_HINT[S.opts.quality] || '');
      setText(pictureHint, sessions().length ? 'A second screen is running. Changes apply the next time you start one.' : 'Used the next time you start a second screen.');
      if (sig === optSig) return;
      optSig = sig;
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.opt : null;
      const seg = (box, key, values, label) => box.replaceChildren(...values.map((v) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(S.opts[key] === v), 'data-opt': key + ':' + v }, label(v));
        b.addEventListener('click', () => { S.opts[key] = v; renderOptions(); });
        return b;
      }));
      seg(resSeg, 'resolution', o.resolutions, resLabel);
      seg(refSeg, 'refresh', o.refresh, (v) => `${v} Hz`);
      seg(qSeg, 'quality', o.quality, (v) => QUALITY[v] || v);
      if (focused) { const f = el.querySelector(`[data-opt="${focused}"]`); if (f) f.focus(); }
    }

    /* ----- measured + link ----- */
    let usbBtn = null, usbPeer = null;
    function renderMeasured() {
      const s = liveSession();
      const p = peer();
      const link = p && p.link;
      const linkName = link ? (LINK_LABELS[link.type] || link.type) : null;
      if (s && s.state === 'live') {
        setText(bigLat, String(s.latencyMs));
        setText(latUnit, ` ms${linkName ? ' over ' + linkName : ''}`);
        setText(fpsLine, `${s.fps} frames per second at ${resLabel(s.resolution)}.`);
      } else {
        setText(bigLat, '—');
        setText(latUnit, ' ms');
        setText(fpsLine, s ? 'Measuring as soon as the picture arrives…' : 'Measured live while a second screen runs.');
      }
      // one persistent button (re-created nodes would drop keyboard focus on every tick)
      if (!usbBtn) {
        usbBtn = h('button.btn.btn-sm.btn-primary', { type: 'button' }, icon('usb'), h('span', null, 'Use USB cable'));
        usbBtn.addEventListener('click', async () => {
          const d = usbPeer;
          if (!d || S.linkBusy) return;
          S.linkBusy = true; linkErr.hidden = true; renderMeasured();
          try { await api.connection.setLink(d.id, 'usb'); if (alive) shell.toast(`${d.name} now uses the USB cable`); }
          catch (e) { if (alive) { linkErr.textContent = errText(e); linkErr.hidden = false; } }
          finally { if (alive) { S.linkBusy = false; renderMeasured(); } }
        });
        linkBtns.replaceChildren(usbBtn);
      }
      let showUsb = false;
      usbPeer = p;
      if (!p) setText(linkHint, '');
      else if (!p.online || !link) setText(linkHint, `${p.name} is offline, so there's no link to measure.`);
      else if (link.type === 'usb') setText(linkHint, `${p.name} is on a USB cable, the fastest link for video.`);
      else if (link.type === 'ethernet') setText(linkHint, `${p.name} is wired over Ethernet. That's a good link for video.`);
      else {
        showUsb = (link.available || []).includes('usb');
        setText(linkHint, `${p.name} is on ${linkName}. Plug in a USB cable for lower latency.`
          + (link.type === 'bluetooth' ? ' Bluetooth is too slow for video.' : ''));
      }
      // the button goes away once the cable is in use: keep focus inside the page
      if (!showUsb && document.activeElement === usbBtn) el.focus({ preventScroll: true });
      usbBtn.hidden = !showUsb;
      usbBtn.disabled = S.linkBusy;
      setText(usbBtn.lastChild, S.linkBusy ? 'Switching…' : 'Use USB cable');
    }

    /* ----- header ----- */
    function renderHeader() {
      const s = liveSession();
      const m = me(), p = peer();
      const pc = [m, p].find((d) => d && d.os === 'windows') || m;
      const mac = [m, p].find((d) => d && d !== pc) || p;
      if (!S.scr) { setText(kick.lastChild, 'Loading'); vStatus.replaceChildren('…'); }
      else if (!s) { setText(kick.lastChild, p && p.online && m && (canOf('extend').ok || canOf('show').ok) ? 'Ready' : 'Unavailable'); vStatus.replaceChildren(h('span.muted', null, 'Off')); }
      else {
        const where = nameOf(s.targetId);
        setText(kick.lastChild, s.state === 'live' ? 'Live' : s.state === 'starting' ? 'Starting' : 'Stopping');
        vStatus.replaceChildren(h('span', { class: s.state === 'live' ? 'good' : 'warn' },
          s.state === 'live' ? `Live on ${where}` : s.state === 'starting' ? `Starting on ${where}` : 'Stopping'));
      }
      setText(vLat, s && s.state === 'live' ? String(s.latencyMs) : '–');
      setText(vFps, s && s.state === 'live' ? String(s.fps) : '–');
      if (sc) {
        const direction = s && pc && s.sourceId !== pc.id ? 'mac-to-pc' : 'pc-to-mac';
        sc.update({ direction, live: !!(s && s.state === 'live'), names: [pc ? pc.name : 'Windows PC', mac ? mac.name : 'MacBook'] });
      }
    }

    function renderNote() {
      const p = peer();
      if (S.devices.length && !p) {
        const btn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => shell.go('connection') }, icon('plus'), 'Pair a computer');
        const box = h('div', null, h('p', null, h('b', null, 'Pair a second computer first. '),
          (S.scr && S.scr.can && S.scr.can.why) || 'Second screen needs another computer to show the picture.'), h('div.btns', null, btn));
        css(box.lastChild, { 'margin-top': '10px' });
        topNote.replaceChildren(icon('screen'), box);
        topNote.hidden = false;
      } else topNote.hidden = true;
    }

    function renderAll() {
      renderHeader(); renderNote();
      renderCard('extend'); renderCard('show');
      renderOptions(); renderMeasured();
    }

    /* ----- data ----- */
    const sub = (fn) => { try { const off = fn(); if (typeof off === 'function') offs.push(off); } catch (e) { console.warn('[screen]', e); } };
    sub(() => api.devices.on((list) => { if (!alive) return; S.devices = Array.isArray(list) ? list : []; renderAll(); }));
    sub(() => api.screen.on((v) => { if (!alive || !v) return; S.scr = v; renderAll(); }));
    (async () => {
      try { const v = await api.screen.get(); if (alive && !S.scr) { S.scr = v; renderAll(); } } catch (_) { /* screen.on covers it */ }
    })();

    renderAll();

    return () => {
      alive = false;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      if (sc) { sc.stop(); sc = null; }
    };
  },
};
