// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Multi-device: more than two computers on one desk. Mode switch, the list of paired
// computers with online / offline / last seen, and rename / forget with an in-page confirm.

import { h, setText } from '../shell/dom.js';
import { icon, LINK_LABELS } from '../shell/icons.js';
import { device, scene } from '../art/index.js';


const errText = (e) => (e && e.message) || 'Something went wrong. Try again.';
const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const osLabel = (d) => `${OS_NAMES[d.os] || d.os} ${d.osVersion || ''}`.trim();
function kindOf(d) {
  if (d.os === 'macos') return d.battery || /book|laptop/i.test(d.name) ? 'macbook' : 'mac-mini';
  return d.screens && d.screens.length >= 2 ? 'windows-pc-2' : 'windows-pc';
}
function ago(iso) {
  if (!iso) return 'a while ago';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
function stat(label, mono = true) {
  const num = h(mono ? 'span.num' : 'span'), u = h('span.u');
  const dt = h('dt', null, label);
  return { el: h('div', null, dt, h('dd', null, num, u)), dt, set(n, unit = '') { setText(num, n); setText(u, unit); } };
}

export default {
  id: 'devices', label: 'Multi-device', tab: 'Devices', group: 'devices', accent: 'var(--c-multi)', icon: 'devices',

  mount(el, api, shell) {
    let alive = true;
    const offs = [];
    let devices = [];
    let multi = null;            // { enabled } once known
    let modeBusy = false;
    const ui = new Map();        // id -> { mode: 'rename'|'forget', value, err, busy }
    const rowErr = new Map();    // id -> message shown under a row

    /* header */
    const sOnline = stat('Online'), sMode = stat('Mode', false);
    const kick = h('span.kick', null, h('i', { 'aria-hidden': 'true' }), 'Live');
    const sub = h('p.sub', null, 'More than two computers on one desk. The pointer travels between all of them.');
    const sceneHost = h('div.lh-scene', { 'aria-hidden': 'true' });
    el.replaceChildren(h('header.lh', null,
      h('div', null, kick, h('h1', null, 'Multi-device'), sub, h('dl.stats', null, sOnline.el, sMode.el)), sceneHost));
    const sc = scene('multi-desk', sceneHost, { accent: 'var(--c-multi)', reducedMotion: shell.reducedMotion });

    /* mode card */
    const bTwo = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Two devices');
    const bMulti = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Multi-device');
    bTwo.addEventListener('click', () => setMulti(false));
    bMulti.addEventListener('click', () => setMulti(true));
    const modeHint = h('p.hint', null, 'Loading…');
    const modeErr = h('p.err.mode-err', { role: 'alert', hidden: true });
    const layBtn = h('button.btn.btn-sm', { type: 'button' }, icon('layout'), 'Arrange screens');
    layBtn.addEventListener('click', () => shell.go('layout'));
    const camBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button' }, icon('camera'), 'Camera');
    camBtn.addEventListener('click', () => shell.go('camera'));
    const modeCard = h('section.card', { 'aria-labelledby': 'dev-mode-h' },
      h('h2', { id: 'dev-mode-h' }, 'Mode'), modeHint,
      h('div.seg.mode-seg', { role: 'group', 'aria-label': 'Desk mode' }, bTwo, bMulti),
      modeErr,
      h('div.note', null, icon('spark'),
        h('div', null, h('p', null, 'Camera sharing and three-way layouts need Multi-device.'), h('div.btns', null, layBtn, camBtn))));

    /* list card */
    const list = h('div', { role: 'list', 'aria-label': 'Computers on this desk' });
    const listCard = h('section.card', { 'aria-labelledby': 'dev-list-h' }, h('h2', { id: 'dev-list-h' }, 'On this desk'), list);
    el.append(h('div.grid-2', null, modeCard, listCard));

    async function setMulti(on) {
      if (modeBusy || !multi || multi.enabled === on) return;
      modeBusy = true;
      const before = multi.enabled;
      multi = { enabled: on };
      modeErr.hidden = true;
      renderMode();
      try {
        const r = await api.multi.set({ enabled: on });
        if (!alive) return;
        multi = r || { enabled: on };
        shell.toast(on ? 'Multi-device mode is on' : 'Two-device mode is on');
      } catch (e) {
        if (!alive) return;
        multi = { enabled: before };
        modeErr.textContent = errText(e);
        modeErr.hidden = false;
      }
      modeBusy = false;
      renderMode();
      renderHeader();
      renderList();
    }

    function renderMode() {
      const on = multi && multi.enabled;
      bTwo.setAttribute('aria-pressed', String(!!multi && !on));
      bMulti.setAttribute('aria-pressed', String(!!on));
      bTwo.disabled = bMulti.disabled = !multi;
      setText(modeHint, !multi ? 'Loading…' : on
        ? 'Every paired computer joins the desk as soon as it is online.'
        : 'Only this computer and one other share the desk. Turn on Multi-device to add more.');
    }

    function renderHeader() {
      // same definition as the status bar: paired devices including this one / this + online ones
      const paired = devices.filter((d) => d.thisDevice || d.paired);
      const total = paired.length;
      const on = paired.filter((d) => d.thisDevice || d.online).length;
      sOnline.set(on, `of ${total}`);
      sMode.set(!multi ? '—' : multi.enabled ? 'Multi-device' : 'Two devices');
      setText(kick.lastChild, total > 1 ? 'Live' : 'Just you');
      sc.update({ devices });
    }

    /* rows */
    function focusRow(id, sel) {
      const r = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      const t = r && r.querySelector(sel);
      if (t) t.focus();
    }

    async function doRename(d) {
      const st = ui.get(d.id);
      const name = (st.value || '').trim();
      if (!name) { st.err = 'Type a name first.'; renderList(); focusRow(d.id, 'input'); return; }
      if (name.length > 40) { st.err = 'Keep the name under 40 characters.'; renderList(); focusRow(d.id, 'input'); return; }
      if (name === d.name) { ui.delete(d.id); renderList(); focusRow(d.id, '[data-act=rename]'); return; }
      st.busy = true; st.err = ''; renderList();
      try {
        await api.devices.rename(d.id, name);
        if (!alive) return;
        ui.delete(d.id);
        shell.toast(`Renamed to ${name}`);
        renderList();
        focusRow(d.id, '[data-act=rename]');
      } catch (e) {
        if (!alive) return;
        st.busy = false; st.err = errText(e);
        renderList();
        focusRow(d.id, 'input');
      }
    }

    async function doForget(d) {
      const st = ui.get(d.id);
      st.busy = true; st.err = ''; renderList();
      try {
        await api.devices.forget(d.id);
        if (!alive) return;
        ui.delete(d.id);
        shell.toast(`${d.name} forgotten`);
        const first = list.querySelector('button');
        if (first) first.focus(); else listCard.querySelector('h2').focus?.();
      } catch (e) {
        if (!alive) return;
        st.busy = false; st.err = errText(e);
        renderList();
        focusRow(d.id, '[data-act=confirm]');
      }
    }

    function buildRow(d) {
      const off = !d.online;
      const st = ui.get(d.id);
      let hint, pill;
      if (d.thisDevice) {
        hint = `${osLabel(d)} · ${d.link ? LINK_LABELS[d.link.type] : 'No network'}`;
        pill = h('span.pill', null, h('i.dot-good', { 'aria-hidden': 'true' }), 'This device');
      } else if (off) {
        hint = `${osLabel(d)} · last seen ${ago(d.lastSeen)}`;
        pill = h('span.pill', null, h('i.dot-off', { 'aria-hidden': 'true' }), 'Offline');
      } else {
        hint = [`${osLabel(d)} · ${d.link ? LINK_LABELS[d.link.type] : 'Connected'}`,
          d.link && d.link.pingMs != null ? [' · ', h('span.num', { 'data-ping': '' }, d.link.pingMs), ' ms'] : null];
        pill = h('span.pill', null, h('i.dot-good', { 'aria-hidden': 'true' }), 'Online');
      }
      const parked = multi && !multi.enabled && !d.thisDevice && devices.filter((x) => !x.thisDevice).indexOf(d) > 0;
      if (parked) hint = [hint, ' · waits for Multi-device'];

      const nodes = [
        device(kindOf(d), { size: 62, state: off ? 'offline' : 'online' }),
        h('div', null, h('b', null, d.name), h('div.hint', null, hint)),
        pill,
      ];

      if (st && st.mode === 'rename') {
        const inp = h('input.input', { type: 'text', maxlength: '40', id: `dev-name-${d.id}`, 'aria-invalid': st.err ? 'true' : null,
          'aria-describedby': st.err ? `dev-name-err-${d.id}` : null, disabled: st.busy });
        inp.value = st.value;
        inp.addEventListener('input', () => { st.value = inp.value; });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); doRename(d); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ui.delete(d.id); renderList(); focusRow(d.id, '[data-act=rename]'); }
        });
        const save = h('button.btn.btn-primary.btn-sm', { type: 'button', disabled: st.busy }, st.busy ? 'Saving…' : 'Save');
        save.addEventListener('click', () => doRename(d));
        const cancel = h('button.btn.btn-quiet.btn-sm', { type: 'button' }, 'Cancel');
        cancel.addEventListener('click', () => { ui.delete(d.id); renderList(); focusRow(d.id, '[data-act=rename]'); });
        nodes.push(h('div.panel', null,
          h('div.field', null, h('label', { for: `dev-name-${d.id}` }, `New name for ${d.name}`), inp,
            st.err ? h('p.err', { id: `dev-name-err-${d.id}`, role: 'alert' }, st.err) : null),
          h('div.btns', null, save, cancel)));
      } else if (st && st.mode === 'forget') {
        const yes = h('button.btn.btn-danger.btn-sm', { type: 'button', 'data-act': 'confirm', disabled: st.busy }, st.busy ? 'Forgetting…' : `Forget ${d.name}`);
        yes.addEventListener('click', () => doForget(d));
        const no = h('button.btn.btn-sm', { type: 'button', 'data-act': 'keep' }, 'Keep it');
        no.addEventListener('click', () => { ui.delete(d.id); renderList(); focusRow(d.id, '[data-act=forget]'); });
        const panel = h('div.panel.danger', { role: 'group', 'aria-label': `Forget ${d.name}?` },
          h('p', null, h('b', null, `Forget ${d.name}?`)),
          h('p.hint', null, 'It leaves this desk and stops sharing. To bring it back, pair it again with a new code.'),
          st.err ? h('p.err', { role: 'alert' }, st.err) : null,
          h('div.btns', null, yes, no));
        panel.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ui.delete(d.id); renderList(); focusRow(d.id, '[data-act=forget]'); }
        });
        nodes.push(panel);
      } else {
        const rn = h('button.btn.btn-sm.btn-quiet', { type: 'button', 'data-act': 'rename', 'aria-label': `Rename ${d.name}` }, 'Rename');
        rn.addEventListener('click', () => { ui.set(d.id, { mode: 'rename', value: d.name, err: '', busy: false }); renderList(); focusRow(d.id, 'input'); });
        const acts = h('div.acts', null, rn);
        if (!d.thisDevice) {
          const fg = h('button.btn.btn-sm.btn-quiet', { type: 'button', 'data-act': 'forget', 'aria-label': `Forget ${d.name}` }, 'Forget');
          fg.addEventListener('click', () => { ui.set(d.id, { mode: 'forget', err: '', busy: false }); renderList(); focusRow(d.id, '[data-act=keep]'); });
          acts.append(fg);
        }
        nodes.push(acts);
      }
      return h('div.drow', { role: 'listitem', 'data-id': d.id }, nodes);
    }

    const rows = new Map();     // id -> { el, sig }
    function rowSig(d) {
      const st = ui.get(d.id);
      return JSON.stringify([d.name, d.online, d.thisDevice, d.os, d.osVersion, d.link && d.link.type, d.link && d.link.pingMs != null,
        d.online ? null : ago(d.lastSeen), !!d.battery, multi && multi.enabled, st && [st.mode, st.err, st.busy],
        devices.filter((x) => !x.thisDevice).indexOf(d)]);
    }
    function renderList() {
      const seen = new Set();
      let prev = null;
      for (const d of devices) {
        seen.add(d.id);
        const sig = rowSig(d);
        let r = rows.get(d.id);
        if (!r || r.sig !== sig) {
          const n = { el: buildRow(d), sig };
          if (r) {
            const had = r.el.contains(document.activeElement) ? document.activeElement : null;
            const act = had && had.getAttribute('data-act');
            r.el.replaceWith(n.el);
            if (act) { const t = n.el.querySelector(`[data-act="${act}"]`); if (t) t.focus(); }
            else if (had && had.tagName === 'INPUT') { const t = n.el.querySelector('input'); if (t) t.focus(); }
          }
          rows.set(d.id, n);
          r = n;
        }
        const pg = r.el.querySelector('[data-ping]');
        if (pg && d.link && d.link.pingMs != null) setText(pg, d.link.pingMs);
        const want = prev ? prev.nextSibling : list.firstChild;
        if (want !== r.el) list.insertBefore(r.el, want);
        prev = r.el;
      }
      for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); ui.delete(id); }
      const es = listCard.querySelector('.empty-state');
      if (devices.length === 1) {
        if (!es) {
          const b = h('button.btn.btn-primary.btn-sm', { type: 'button' }, icon('connection'), 'Pair a new device');
          b.style.setProperty('--a', 'var(--c-conn)');
          b.addEventListener('click', () => shell.go('connection'));
          listCard.append(h('div.empty-state', null, h('b', null, 'Only this computer so far'),
            h('p', null, 'Pair a second and a third computer, and they all share one mouse, keyboard and clipboard.'), h('div.btns', null, b)));
        }
      } else if (es) es.remove();
    }

    offs.push(api.devices.on((l) => {
      if (!alive || !Array.isArray(l)) return;
      devices = l;
      renderList();
      renderHeader();
    }));
    api.multi.get().then((m) => {
      if (!alive) return;
      multi = m;
      renderMode(); renderHeader(); renderList();
    }).catch((e) => {
      if (!alive) return;
      modeErr.textContent = errText(e);
      modeErr.hidden = false;
    });
    renderMode();

    const ageTimer = setInterval(() => { if (devices.length) renderList(); }, 30000);

    return () => {
      alive = false;
      clearInterval(ageTimer);
      for (const off of offs) { try { off(); } catch (_) { /* gone */ } }
      sc.stop();
    };
  },
};
