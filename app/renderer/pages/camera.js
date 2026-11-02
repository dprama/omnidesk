// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Camera (multi-device mode): one switch shares this computer's camera with every device on
// the desk. Only one camera runs at a time; the page shows whose is live and who's watching,
// and opens the live camera of another device in a viewer window (camera.watch / unwatch).
// `why` from camera.get() (e.g. permission denied) is shown above the switch.

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene, device } from '../art/index.js';

const css = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) el.style.removeProperty(k); else el.style.setProperty(k, String(v));
  }
  return el;
};
const errText = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong. Try again.';
const kindOf = (d) => (d.os === 'macos' ? (d.battery ? 'macbook' : 'mac-mini') : (d.screens && d.screens.length > 1 ? 'windows-pc-2' : 'windows-pc'));
function lastSeen(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'offline';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `last seen ${Math.max(1, m)} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `last seen ${hr} h ago`;
  const d = Math.round(hr / 24);
  return `last seen ${d} day${d > 1 ? 's' : ''} ago`;
}

export default {
  id: 'camera', label: 'Camera', tab: 'Camera', group: 'share',
  accent: 'var(--c-cam)', icon: 'camera',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    const timers = new Set();
    const S = { cam: null, multi: null, devices: [], busy: false, multiBusy: false, watchBusy: null, watchErr: null };

    /* ----- header ----- */
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), h('span', null, 'Loading'));
    const vCam = h('span', null, '…');
    const vWatch = h('span.num', null, '…');
    const sceneHost = h('div.lh-scene');
    const header = h('header.lh', null,
      h('div', null, kick,
        h('h1', null, 'Camera'),
        h('p.sub', null, 'Share one camera with every computer on the desk. The others open it in a small OmniDesk window. Only one camera runs at a time.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Camera'), h('dd', null, vCam)),
          h('div', null, h('dt', null, 'Watching'), h('dd', null, vWatch)))),
      sceneHost);

    /* ----- multi-device note ----- */
    const multiNote = h('div.note', { hidden: true });
    css(multiNote, { 'margin-bottom': '16px' });
    const multiBtn = h('button.btn.btn-sm.btn-primary', { type: 'button' }, icon('devices'), 'Turn on Multi-device mode');
    const multiErr = h('p.err', { role: 'alert', hidden: true });
    const multiBtns = h('div.btns', null, multiBtn);
    css(multiBtns, { 'margin-top': '10px' });
    multiNote.append(icon('devices'), h('div', null,
      h('p', null, h('b', null, 'Camera sharing works in Multi-device mode. '),
        h('small', null, 'It lets every computer on the desk reach the camera at once, instead of just the two sharing a mouse.')),
      multiBtns, multiErr));

    /* ----- main switch ----- */
    const swShare = h('button.switch.big', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Share my camera with every device' });
    const shareDesc = h('div.d');
    const shareErr = h('p.err', { role: 'alert', hidden: true });
    const title = h('b', null, 'Share my camera with every device');
    css(title, { 'font-size': '16px' });
    const r0 = h('div.row', null, h('div', null, title, shareDesc), swShare);
    css(r0, { padding: '0' });
    const whyText = h('p');
    const whyNote = h('div.note.cam-why', { role: 'status', hidden: true }, icon('alert'), whyText);
    const mainCard = h('section.card', null, whyNote, r0, shareErr);

    /* ----- live + watching ----- */
    const liveList = h('ul.cam-list', { 'aria-label': 'Cameras on this desk' });
    const watchList = h('ul.cam-list', { 'aria-label': 'Watching now' });
    const watchErr = h('p.err', { role: 'alert', hidden: true });
    const liveCard = h('section.card', null, h('h2', null, 'Live camera'),
      h('p.hint', null, 'One camera runs at a time. Open a shared camera to see it in a window here.'), liveList, watchErr);
    const watchHint = h('p.hint', null, 'Computers using the shared camera right now.');
    const watchCard = h('section.card', null, h('h2', null, 'Watching now'), watchHint, watchList);
    const lower = h('div.grid-2', null, liveCard, watchCard);
    css(lower, { 'margin-top': '16px' });

    el.replaceChildren(header, multiNote, mainCard, lower);

    let sc = null;
    try { sc = scene('camera-watch', sceneHost, { accent: 'var(--c-cam)', reducedMotion: shell.reducedMotion }); }
    catch (e) { console.warn('[camera] scene', e); }

    const me = () => S.devices.find((d) => d.thisDevice || d.id === 'this') || null;
    const devById = (id) => S.devices.find((d) => d.id === id) || null;
    const nameOf = (id) => (devById(id) || {}).name || (id === 'this' ? 'This computer' : 'Another computer');
    const multiOn = () => !!(S.multi && S.multi.enabled);

    function deviceRow(d, right, sub, action) {
      const art = device(kindOf(d), { size: 46, accent: 'var(--c-cam)', state: !d.online ? 'offline' : right.active ? 'active' : 'online' });
      const text = h('div.cam-t', null, h('b', null, d.name, d.thisDevice ? h('span.muted', null, ' · this computer') : null), h('div.d', null, sub));
      const left = h('div.cam-l', null, art, text);
      return h('li.row', null, left, h('div.cam-r', null, h('span.pill', null, h('i', { class: right.dot, 'aria-hidden': 'true' }), right.text), action || null));
    }
    const meId = () => (me() || { id: 'this' }).id;
    const iWatch = () => !!(S.cam && S.cam.watchers && S.cam.watchers.includes(meId()));
    function watchButton(d) {
      const on = iWatch();
      const busy = S.watchBusy === d.id;
      const b = h('button.btn.btn-sm' + (on ? '' : '.btn-primary'), { type: 'button', 'data-fk': 'watch-' + d.id,
        'aria-label': on ? `Close ${d.name}'s camera` : `Open ${d.name}'s camera` },
      icon('camera'), busy ? (on ? 'Closing…' : 'Opening…') : on ? 'Close camera' : 'Open camera');
      b.disabled = busy;
      b.addEventListener('click', () => toggleWatch(d, !on));
      return b;
    }
    async function toggleWatch(d, open) {
      if (S.watchBusy) return;
      S.watchBusy = d.id; S.watchErr = null; sig = ''; render();
      try {
        const r = open ? await api.camera.watch(d.id) : await api.camera.unwatch(d.id);
        if (!alive) return;
        if (r) S.cam = r;
        shell.toast(open ? `${d.name}'s camera is open in a window` : `${d.name}'s camera is closed`);
      } catch (e) {
        if (!alive) return;
        S.watchErr = errText(e);
      } finally {
        if (alive) { S.watchBusy = null; sig = ''; render(); }
      }
    }

    let sig = '';
    function render() {
      const cam = S.cam, m = me();
      const known = !!(cam && S.multi);
      const shared = !!(cam && cam.shared);
      const live = cam && cam.liveDeviceId;
      const watchers = (cam && cam.watchers) || [];

      setText(kick.lastChild, !known ? 'Loading' : !multiOn() ? 'Needs Multi-device' : shared || live ? (watchers.length ? 'Live' : 'Shared') : 'Off');
      whyNote.hidden = !(cam && cam.why);
      setText(whyText, (cam && cam.why) || '');
      watchErr.hidden = !S.watchErr;
      setText(watchErr, S.watchErr || '');
      vCam.replaceChildren(h('span', { class: live ? 'good' : 'muted' }, !cam ? '…' : live ? `Live on ${nameOf(live)}` : 'Off'));
      setText(vWatch, cam ? String(watchers.length) : '…');
      if (sc && cam) sc.update({ liveDeviceId: live || null, watchers });

      multiNote.hidden = !S.multi || multiOn();
      multiBtn.disabled = S.multiBusy;
      setText(multiBtn.lastChild, S.multiBusy ? 'Turning on…' : 'Turn on Multi-device mode');

      swShare.setAttribute('aria-checked', String(shared));
      swShare.disabled = !known || S.busy || (!multiOn() && !shared);
      const peersOnline = S.devices.filter((d) => !d.thisDevice && d.paired && d.online);
      setText(shareDesc, !known ? ' '
        : !multiOn() ? 'Turn on Multi-device mode first.'
          : shared ? (watchers.length ? `Your camera is on: ${watchers.length} ${watchers.length === 1 ? 'computer is' : 'computers are'} watching.` : 'Shared. Your camera stays off until another computer opens it.')
            : live && live !== meId() ? `${nameOf(live)}'s camera is shared now. Sharing yours stops it: one camera runs at a time.`
            : peersOnline.length ? 'The other computers can open it from their Camera page. It runs only while someone watches.'
              : 'No other computer is online to watch yet.');

      setText(watchHint, !live ? 'Computers using the shared camera right now.'
        : live === meId() ? 'Computers using your camera right now.' : `Computers using ${nameOf(live)}'s camera right now.`);

      const s = JSON.stringify([cam, S.watchBusy, S.devices.map((d) => [d.id, d.name, d.online, d.lastSeen])]);
      if (s === sig) return;
      sig = s;
      // keep keyboard focus on the same control across re-renders
      const fk = document.activeElement && el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.fk : null;

      // cameras on the desk: this one first
      const all = S.devices.filter((d) => d.paired !== false).sort((a, b) => (b.thisDevice ? 1 : 0) - (a.thisDevice ? 1 : 0));
      liveList.replaceChildren(...all.map((d) => {
        const isLive = live === d.id;
        const right = isLive ? { dot: 'dot-good', text: 'Live now', active: true }
          : !d.online ? { dot: 'dot-off', text: 'Offline' } : { dot: 'dot-off', text: 'Off' };
        const sub = isLive ? (d.thisDevice ? 'Your camera is the one running.' : iWatch() ? 'Open in a window on this computer.' : 'Shared. Open it to see it here.')
          : !d.online ? lastSeen(d.lastSeen) : d.thisDevice ? 'Your camera. Turn on sharing to run it.' : 'Camera off.';
        const action = isLive && !d.thisDevice && d.online ? watchButton(d) : null;
        return deviceRow(d, right, sub, action);
      }));

      const watching = watchers.map(devById).filter(Boolean);
      if (!watching.length) {
        const li = h('li.empty-state', null, icon('camera'),
          h('b', null, 'Nobody is watching'),
          h('p', null, shared ? 'On another computer, open Camera in OmniDesk and choose Open camera.' : 'Turn on sharing and the other computers can open your camera from their Camera page.'));
        watchList.replaceChildren(li);
      } else {
        watchList.replaceChildren(...watching.map((d) => deviceRow(d, { dot: 'dot-good', text: 'Watching' },
          live === (d.id) ? 'Its own camera' : `Using ${live === meId() ? 'your' : nameOf(live || (m && m.id)) + '\'s'} camera`)));
      }
      if (S.devices.length && !S.devices.some((d) => !d.thisDevice && d.paired)) {
        const b = h('button.btn.btn-sm', { type: 'button', 'data-fk': 'pair', onclick: () => shell.go('connection') }, icon('plus'), 'Pair a computer');
        watchList.append(h('li.cam-pair', null, b));
      }
      if (fk) { const n = el.querySelector(`[data-fk="${fk}"]`); if (n) n.focus(); }
    }

    swShare.addEventListener('click', async () => {
      if (!S.cam || S.busy) return;
      const v = !S.cam.shared;
      S.busy = true; shareErr.hidden = true;
      swShare.setAttribute('aria-checked', String(v));
      render();
      try {
        const r = await api.camera.setShared(v);
        if (!alive) return;
        if (r) S.cam = r;
        shell.toast(v ? 'Camera is shared' : 'Camera sharing is off');
      } catch (e) {
        if (!alive) return;
        shareErr.textContent = errText(e); shareErr.hidden = false;
      } finally {
        if (alive) { S.busy = false; sig = ''; render(); }
      }
    });
    multiBtn.addEventListener('click', async () => {
      S.multiBusy = true; multiErr.hidden = true; render();
      try {
        const r = await api.multi.set({ enabled: true });
        if (!alive) return;
        S.multi = r || { enabled: true };
        shell.toast('Multi-device mode is on');
        swShare.focus();
      } catch (e) {
        if (!alive) return;
        multiErr.textContent = errText(e); multiErr.hidden = false;
      } finally {
        if (alive) { S.multiBusy = false; render(); }
      }
    });

    /* ----- data ----- */
    const sub = (fn) => { try { const off = fn(); if (typeof off === 'function') offs.push(off); } catch (e) { console.warn('[camera]', e); } };
    sub(() => api.devices.on((list) => { if (!alive) return; S.devices = Array.isArray(list) ? list : []; render(); }));
    sub(() => api.camera.on((c) => { if (!alive || !c) return; S.cam = c; render(); }));
    // multi has no subscription: re-read it when status changes (the command bar may flip it)
    let mT = null;
    const readMulti = async () => {
      try { const r = await api.multi.get(); if (alive && !S.multiBusy && JSON.stringify(r) !== JSON.stringify(S.multi)) { S.multi = r; render(); } } catch (_) { /* keep */ }
    };
    sub(() => api.status.on(() => {
      if (!alive || mT) return;
      mT = setTimeout(() => { timers.delete(mT); mT = null; if (alive) readMulti(); }, 400);
      timers.add(mT);
    }));
    readMulti();

    render();

    return () => {
      alive = false;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      timers.forEach((t) => clearTimeout(t)); timers.clear();
      if (sc) { sc.stop(); sc = null; }
    };
  },
};
