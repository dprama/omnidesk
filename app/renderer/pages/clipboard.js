// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Clipboard: copy on one computer, paste on the other. On/off, files on/off, the file size
// limit and the recently shared items (text, image, file with size and progress).

import { h, setText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { scene } from '../art/index.js';

const css = (el, props) => {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) el.style.removeProperty(k); else el.style.setProperty(k, String(v));
  }
  return el;
};
const errText = (e) => (e && typeof e.message === 'string' && e.message) || 'Something went wrong. Try again.';
const SIZES = [10, 50, 100, 500, 1024];
const mbLabel = (n) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024} GB` : `${n} MB`);

export function fmtBytes(b) {
  if (!Number.isFinite(b)) return '';
  if (b < 1000) return `${b} B`;
  if (b < 1000 * 1000) return `${Math.round(b / 1024)} KB`;
  if (b < 1000 * 1000 * 1000) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
// ClipItem.at: epoch ms from main (engine and files module), ISO string from the mock.
export function atMs(at) {
  if (typeof at === 'number') return Number.isFinite(at) ? at : NaN;
  if (typeof at === 'string' && /^\d+$/.test(at)) return Number(at);
  return Date.parse(at);
}
export function ago(at, now = Date.now()) {
  const t = atMs(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// Item `error` codes (files module, app/main/files/README.md) -> what happened, in plain words.
export function errorText(code, outgoing) {
  switch (code) {
    case 'off': return outgoing ? 'Not sent: file sharing is off on the other computer' : 'Stopped: file sharing is off';
    case 'too-big': return outgoing ? 'Too big for the other computer\u2019s file limit' : 'Too big for this computer\u2019s file limit';
    case 'cancelled': return 'Replaced by a newer copy';
    case 'superseded': return outgoing ? 'Not pasted there: something newer was copied' : 'Not pasted: you copied something newer';
    case 'hash-mismatch': case 'bad-chunk': return 'Arrived damaged. Copy it again';
    case 'offline': case 'disconnected': case 'timeout': return 'Connection lost. Copy it again';
    case 'changed': return 'The file changed while sending. Copy it again';
    case 'gone': return 'No longer available. Copy it again';
    case 'clipboard-write': return 'Arrived, but could not be put on the clipboard';
    default: return 'Didn\u2019t arrive. Copy it again';
  }
}

const SVG = 'http://www.w3.org/2000/svg';
function thumb() {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 52 40');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.innerHTML = '<rect width="52" height="40" rx="4" fill="#1d2330"/><rect x="4" y="4" width="44" height="6" rx="1" fill="#2c3445"/>' +
    '<path d="M4 34l12-12 8 7 10-11 14 16z" fill="#6b5a3c"/><circle cx="38" cy="17" r="3" fill="#d7dbe3" fill-opacity=".7"/>';
  css(s, { width: '40px', height: '31px', display: 'block' });
  return s;
}

export default {
  id: 'clipboard', label: 'Clipboard', tab: 'Clipboard', group: 'share',
  accent: 'var(--c-clip)', icon: 'clipboard',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    const timers = new Set();
    const S = { cfg: null, items: [], devices: [], status: null, busy: false };

    /* ----- header ----- */
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), h('span', null, 'Loading'));
    const vStatus = h('span', null, '…');
    const vLast = h('span', null, '…');
    const vMax = h('span', null, '…');
    const sceneHost = h('div.lh-scene');
    el.replaceChildren();
    const header = h('header.lh', null,
      h('div', null, kick,
        h('h1', null, 'Clipboard'),
        h('p.sub', null, 'Copy on one computer, paste on the other. Text, images and files, straight over your own link.'),
        h('dl.stats', null,
          h('div', null, h('dt', null, 'Status'), h('dd', null, vStatus)),
          h('div', null, h('dt', null, 'Last shared'), h('dd', null, vLast)),
          h('div', null, h('dt', null, 'Files up to'), h('dd', null, vMax)))),
      sceneHost);

    const note = h('div.note', { hidden: true });
    css(note, { 'margin-bottom': '16px' });

    /* ----- settings ----- */
    const swOn = h('button.switch.big', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Share clipboard' });
    const onDesc = h('div.d', null, ' ');
    const swFiles = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Share files' });
    const sizeSeg = h('div.seg', { role: 'group', 'aria-label': 'Largest file to share' });
    const sizeDesc = h('div.d', null, 'Bigger files stay on the computer they were copied on.');
    const setErr = h('p.err', { role: 'alert', hidden: true });
    const r0 = h('div.row', null, h('div', null, h('b', null, 'Share clipboard'), onDesc), swOn);
    css(r0, { 'padding-top': '0' });
    const sizeRow = h('div.row', null, h('b', null, 'Files up to'), sizeDesc, sizeSeg);
    css(sizeRow, { display: 'block' });
    css(sizeSeg, { 'margin-top': '10px' });
    const settings = h('section.card', null,
      r0,
      h('div.row', null, h('div', null, h('b', null, 'Share files'), h('div.d', null, 'Copy a file in Explorer or Finder, paste it on the other computer.')), swFiles),
      sizeRow, setErr);

    /* ----- recent ----- */
    const list = h('ul', { 'aria-label': 'Recently shared, newest first' });
    css(list, { 'list-style': 'none', margin: '10px 0 0', padding: '0' });
    const empty = h('div.empty-state', { hidden: true }, icon('clipboard'), h('b', null, 'Nothing shared yet'), h('p', null, 'Copy something and it shows up here.'));
    css(empty, { 'margin-top': '12px' });
    const recent = h('section.card', null,
      h('h2', null, 'Recently shared'),
      h('p.hint', null, 'The last 20 items this session. Nothing is kept after you quit.'),
      list, empty);

    el.append(header, note, h('div.grid-2', null, settings, recent));

    let sc = null;
    try { sc = scene('clipboard-hop', sceneHost, { accent: 'var(--c-clip)', reducedMotion: shell.reducedMotion }); }
    catch (e) { console.warn('[clipboard] scene', e); }

    const devById = (id) => S.devices.find((d) => d.id === id) || null;
    const nameOf = (id) => (devById(id) || {}).name || (id === 'this' ? 'This computer' : id === '*' ? 'Other computers' : 'Another computer');
    const peers = () => S.devices.filter((d) => !d.thisDevice && d.paired);

    /* ----- render ----- */
    function renderHeader() {
      const on = S.cfg ? !!S.cfg.enabled : !!(S.status && S.status.clipboard);
      const known = !!(S.cfg || S.status);
      setText(kick.lastChild, !known ? 'Loading' : on ? 'Sharing' : 'Paused');
      vStatus.replaceChildren(h('span', { class: on ? 'good' : 'muted' }, known ? (on ? 'On' : 'Off') : '…'));
      setText(vLast, S.items[0] ? ago(S.items[0].at) : 'Nothing yet');
      setText(vMax, S.cfg ? (S.cfg.files ? mbLabel(S.cfg.maxFileMB) : 'Files off') : '…');
      if (sc) {
        const mac = peers().find((d) => d.os === 'macos') || peers()[0];
        const me = S.devices.find((d) => d.thisDevice);
        const last = S.items[0];
        const peerOnline = peers().some((d) => d.online);
        let direction = 'both';
        if (last && mac) direction = last.from === mac.id ? 'ltr' : last.to === mac.id ? 'rtl' : 'both';
        sc.update({
          enabled: on && peerOnline,
          kind: last ? last.kind : 'text',
          direction,
          names: [mac ? mac.name : 'Other computer', me ? me.name : 'This computer'],
        });
      }
    }

    function renderNote() {
      const ps = peers();
      let msg = null, btn = null;
      if (S.devices.length && !ps.length) {
        msg = [h('b', null, 'No other computer yet.'), ' Pair one and whatever you copy here is ready to paste there.'];
        btn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => shell.go('connection') }, icon('plus'), 'Pair a computer');
      } else if (ps.length && !ps.some((d) => d.online)) {
        msg = [h('b', null, `${ps.length === 1 ? ps[0].name + ' is' : 'Every other computer is'} offline.`), ' Copies stay on this computer until it\'s back.'];
      }
      if (!msg) { note.hidden = true; return; }
      const box = h('div', null, h('p', null, ...msg), btn ? h('div.btns', null, btn) : null);
      if (btn) css(box.lastChild, { 'margin-top': '10px' });
      note.replaceChildren(icon(ps.length ? 'alert' : 'devices'), box);
      note.hidden = false;
    }

    function renderSettings() {
      const c = S.cfg;
      swOn.setAttribute('aria-checked', String(!!(c && c.enabled)));
      swFiles.setAttribute('aria-checked', String(!!(c && c.files)));
      swOn.disabled = !c || S.busy;
      swFiles.disabled = !c || S.busy;
      setText(onDesc, !c ? ' ' : c.enabled ? 'Anything you copy is ready to paste on the other computer.' : 'Paused. Copies stay on the computer they were made on.');
      const sizes = c && !SIZES.includes(c.maxFileMB) ? [...SIZES, c.maxFileMB].sort((a, b) => a - b) : SIZES;
      const sig = sizes.join() + '|' + (c && c.maxFileMB) + '|' + !!(c && c.files) + S.busy;
      if (sizeSeg.dataset.sig !== sig) {
        sizeSeg.dataset.sig = sig;
        const had = sizeSeg.contains(document.activeElement) ? document.activeElement.dataset.mb : null;
        sizeSeg.replaceChildren(...sizes.map((n) => {
          const b = h('button', { type: 'button', 'data-mb': String(n), 'aria-pressed': String(!!c && c.maxFileMB === n) }, mbLabel(n));
          b.disabled = !c || !c.files || S.busy;
          b.addEventListener('click', () => save({ maxFileMB: n }, `Files up to ${mbLabel(n)}`));
          return b;
        }));
        if (had) { const f = sizeSeg.querySelector(`[data-mb="${had}"]`); if (f && !f.disabled) f.focus(); }
      }
      setText(sizeDesc, c && !c.files ? 'File sharing is off, so only text and images are shared.' : 'Bigger files stay on the computer they were copied on.');
    }

    const rows = new Map(); // id -> { li, meta, bar, fill, sig }
    function itemRow(it) {
      let ic;
      if (it.kind === 'image') ic = thumb();
      else { ic = icon(it.kind === 'file' ? 'file' : 'text', 'icon'); css(ic, { width: '20px', height: '20px' }); }
      const icBox = h('span', null, ic);
      css(icBox, {
        display: 'grid', 'place-items': 'center', width: '40px', height: '40px', flex: 'none', 'border-radius': '10px',
        background: it.kind === 'image' ? 'transparent' : 'color-mix(in oklab, var(--a) 10%, transparent)',
        border: it.kind === 'image' ? '0' : '1px solid color-mix(in oklab, var(--a) 22%, transparent)', color: 'var(--a)',
      });
      const title = it.kind === 'text' ? `“${it.text || ''}”` : (it.name || (it.kind === 'image' ? 'Image' : 'File'));
      const titleEl = h('b', { dir: 'auto' }, title); // RTL text and names stay readable
      css(titleEl, { display: 'block', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'font-weight': '600' });
      titleEl.title = title;
      const meta = h('small.muted');
      css(meta, { display: 'block', 'font-size': 'var(--fs-sm)', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' });
      const text = h('div', null, titleEl, meta);
      css(text, { 'min-width': '0', flex: '1 1 auto' });
      let bar = null, fill = null;
      if (it.kind === 'file') {
        bar = h('div', { role: 'progressbar', 'aria-label': `${it.to === 'this' ? 'Receiving' : 'Sending'} ${title}`, 'aria-valuemin': '0', 'aria-valuemax': '100' });
        css(bar, { height: '4px', 'margin-top': '7px', 'border-radius': '4px', background: 'rgba(255,255,255,.07)', overflow: 'hidden' });
        fill = h('div');
        css(fill, { height: '100%', background: 'var(--a)', 'border-radius': '4px', transition: shell.reducedMotion ? null : 'width .3s ease' });
        bar.append(fill);
        text.append(bar);
      }
      const dir = h('span.chip', { 'aria-label': `From ${nameOf(it.from)} to ${nameOf(it.to)}` },
        h('span', null, nameOf(it.from)), icon('arrow', 'icon'), h('span', null, nameOf(it.to)));
      css(dir, { 'flex': 'none' });
      css(dir.querySelector('svg'), { width: '12px', height: '12px', color: 'var(--a)' });
      const left = h('div', null, icBox, text);
      css(left, { display: 'flex', gap: '12px', 'align-items': 'center', 'min-width': '0', flex: '1 1 auto' });
      const li = h('li.row', null, left, dir);
      css(li, { 'flex-wrap': 'wrap', gap: '8px 14px' });
      return { li, meta, bar, fill, it };
    }
    function paintRow(R, it) {
      R.it = it;
      const kind = it.kind === 'image' ? 'image' : it.kind === 'file' ? 'file' : 'text';
      const bits = [];
      if (it.kind === 'image' && it.width && it.height) bits.push(`${it.width}×${it.height}`);
      if (it.kind === 'file' && Number.isFinite(it.bytes)) bits.push(fmtBytes(it.bytes));
      bits.push(kind);
      const p = Number.isFinite(it.progress) ? Math.max(0, Math.min(1, it.progress)) : 1;
      const failed = typeof it.error === 'string' && it.error !== '';
      if (failed) bits.push(errorText(it.error, it.from === 'this'));
      else if (it.kind === 'file' && p < 1) bits.push(`${it.to === 'this' ? 'receiving' : 'sending'} ${Math.round(p * 100)}%`);
      bits.push(ago(it.at));
      setText(R.meta, bits.join(' · '));
      R.meta.classList.toggle('bad', failed);
      R.meta.classList.toggle('muted', !failed);
      if (R.bar) {
        R.bar.hidden = p >= 1 || failed;
        R.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
        css(R.fill, { width: (p * 100).toFixed(1) + '%' });
      }
    }
    function renderList() {
      empty.hidden = S.items.length > 0;
      const ids = new Set(S.items.map((i) => i.id));
      for (const [id, R] of rows) if (!ids.has(id)) { R.li.remove(); rows.delete(id); }
      S.items.forEach((it, i) => {
        let R = rows.get(it.id);
        if (!R) { R = itemRow(it); rows.set(it.id, R); }
        paintRow(R, it);
        if (list.children[i] !== R.li) list.insertBefore(R.li, list.children[i] || null);
      });
      css(list, { opacity: S.cfg && !S.cfg.enabled ? '.55' : null });
    }

    function renderAll() { renderHeader(); renderNote(); renderSettings(); renderList(); }

    async function save(patch, okMsg) {
      if (!S.cfg || S.busy) return;
      S.busy = true; setErr.hidden = true;
      renderSettings();
      try {
        const r = await api.clipboard.set(patch);
        if (!alive) return;
        S.cfg = r || { ...S.cfg, ...patch };
        if (okMsg) shell.toast(okMsg);
      } catch (e) {
        if (!alive) return;
        setErr.textContent = errText(e);
        setErr.hidden = false;
      } finally {
        if (alive) { S.busy = false; renderAll(); }
      }
    }
    swOn.addEventListener('click', () => { if (S.cfg) save({ enabled: !S.cfg.enabled }, !S.cfg.enabled ? 'Clipboard is on' : 'Clipboard is off'); });
    swFiles.addEventListener('click', () => { if (S.cfg) save({ files: !S.cfg.files }, !S.cfg.files ? 'Files are shared' : 'Files are not shared'); });

    const byNewest = (a, b) => (atMs(b.at) || 0) - (atMs(a.at) || 0);
    function addItem(it) {
      if (!it || !it.id) return;
      const i = S.items.findIndex((x) => x.id === it.id);
      if (i >= 0) S.items[i] = it;
      else { S.items.unshift(it); S.items.sort(byNewest); }
      if (S.items.length > 20) S.items.length = 20;
    }

    /* ----- data ----- */
    const sub = (fn) => { try { const off = fn(); if (typeof off === 'function') offs.push(off); } catch (e) { console.warn('[clipboard]', e); } };
    sub(() => api.devices.on((list) => { if (!alive) return; const names = JSON.stringify((Array.isArray(list) ? list : []).map((d) => [d.id, d.name]));
      S.devices = Array.isArray(list) ? list : [];
      if (names !== S.names) { S.names = names; for (const R of rows.values()) R.li.remove(); rows.clear(); }
      renderAll();
    }));
    let refT = null;
    sub(() => api.status.on((s) => {
      if (!alive) return;
      const changed = !S.status || s.clipboard !== S.status.clipboard;
      S.status = s;
      if (changed && S.cfg && !S.busy && s.clipboard !== S.cfg.enabled && !refT) {
        // the command bar may have changed it
        refT = setTimeout(async () => {
          timers.delete(refT); refT = null;
          try { const c = await api.clipboard.get(); if (alive && !S.busy) { S.cfg = c; renderAll(); } } catch (_) { /* keep */ }
        }, 50);
        timers.add(refT);
      }
      renderHeader();
    }));
    sub(() => api.clipboard.onItem((it) => { if (!alive) return; addItem(it); renderList(); renderHeader(); }));

    (async () => {
      try { S.cfg = await api.clipboard.get(); } catch (e) { if (alive) { setErr.textContent = errText(e); setErr.hidden = false; } }
      try { (await api.clipboard.history() || []).slice().reverse().forEach(addItem); } catch (_) { /* empty list */ }
      if (alive) { S.items.sort(byNewest); renderAll(); }
    })();

    const tick = setInterval(() => { if (alive) { for (const R of rows.values()) paintRow(R, R.it); renderHeader(); } }, 30000);

    renderAll();

    return () => {
      alive = false;
      clearInterval(tick);
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      timers.forEach((t) => clearTimeout(t)); timers.clear();
      if (sc) { sc.stop(); sc = null; }
    };
  },
};
