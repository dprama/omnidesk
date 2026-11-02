// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// The live status bar, the sidebar status dots and the "this device" card.
// The visible bar updates instantly; screen readers get a throttled polite summary of
// meaningful changes only (never the ticking ping).

import { $, $$, h, setText } from './dom.js';
import { icon, LINK_LABELS } from './icons.js';
import { toast } from './toast.js';
import { state, onState, deviceName, thisDevice, cursorLocked, cameraShared, screenSessions } from './state.js';

const ANNOUNCE_EVERY = 3000;
let els = null;
let lastSpoken = null;
let pending = null;
let lastAt = 0;
let timer = 0;

function build() {
  const root = $('#status');
  root.replaceChildren();
  const item = (cls, ...kids) => h('span.sb' + (cls ? '.' + cls : ''), null, ...kids);

  const connDot = h('i.dot-good', { 'aria-hidden': 'true' });
  const connN = h('b.num');
  const connTotal = h('span');
  const cursorB = h('b');
  const clipB = h('b');
  const linkIcon = h('span.sb-ic');
  const linkText = h('span');
  const ping = h('b.num');
  const pingWrap = h('span', null, ' · ', ping, ' ms');
  const encIcon = h('span.sb-ic');
  const encText = h('span');

  const conn = item('', connDot, connN, connTotal);
  const cursor = item('', icon('mouse'), 'Cursor on ', cursorB);
  const clip = item('', icon('clipboard'), 'Clipboard ', clipB);
  const link = item('', linkIcon, linkText, pingWrap);
  const enc = item('right', encIcon, encText);
  // A button: the full reason (e.g. which macOS permission is missing) doesn't fit the bar.
  const engine = h('button.sb.warn-t.sb-btn', { type: 'button' }, icon('alert'), 'Engine stopped');
  engine.hidden = true;
  engine.addEventListener('click', () => {
    const why = state.status && state.status.engine && state.status.engine.reason;
    toast(why || 'The engine stopped. OmniDesk is restarting it.');
  });

  root.append(engine, conn, cursor, clip, link, enc);
  els = { conn, connDot, connN, connTotal, cursor, cursorB, clipB, link, linkIcon, linkText, ping, pingWrap, enc, encIcon, encText, engine };
}

function setIcon(holder, name) {
  if (holder.dataset.icon === name) return;
  holder.dataset.icon = name;
  holder.replaceChildren(icon(name));
}

function render() {
  const s = state.status;
  if (!els) build();
  if (!s) return;

  els.engine.hidden = !s.engine || s.engine.running !== false;
  if (!els.engine.hidden) els.engine.title = s.engine.reason || '';

  setText(els.connN, s.connected ?? 0);
  setText(els.connTotal, ` of ${s.total ?? 0} device${s.total === 1 ? '' : 's'} connected`);
  // connected counts this device too, so "good" means at least one other device is online
  els.connDot.className = s.connected > 1 ? 'dot-good' : 'dot-off';

  setText(els.cursorB, s.cursorOn ? deviceName(s.cursorOn) : 'nowhere');
  setText(els.clipB, s.clipboard ? 'on' : 'off');

  if (s.link) {
    setIcon(els.linkIcon, s.link.type || 'link');
    setText(els.linkText, `${deviceName(s.link.deviceId)} · ${LINK_LABELS[s.link.type] || s.link.type}`);
    els.pingWrap.hidden = s.link.pingMs == null;
    setText(els.ping, s.link.pingMs ?? '');
  } else {
    setIcon(els.linkIcon, 'link');
    setText(els.linkText, 'No link yet');
    els.pingWrap.hidden = true;
  }

  setIcon(els.encIcon, s.encrypted ? 'lock' : 'unlock');
  setText(els.encText, s.encrypted ? 'Encrypted' : 'Not encrypted');
  els.enc.classList.toggle('warn-t', !s.encrypted);
  els.enc.title = s.encrypted ? 'End-to-end encrypted' : 'The link is not encrypted';

  queueAnnounce(s);
}

/* ---------- throttled, polite announcements ---------- */
function summary(s) {
  return {
    conn: `${s.connected} of ${s.total} devices connected`,
    cursor: `Cursor on ${s.cursorOn ? deviceName(s.cursorOn) : 'nowhere'}`,
    clip: `Clipboard ${s.clipboard ? 'on' : 'off'}`,
    link: s.link ? `${deviceName(s.link.deviceId)} over ${LINK_LABELS[s.link.type] || s.link.type}` : 'No link',
    enc: s.encrypted ? 'Encrypted' : 'Not encrypted',
    engine: s.engine && s.engine.running === false ? `Engine stopped. ${s.engine.reason || ''}`.trim() : ''
  };
}

function queueAnnounce(s) {
  pending = summary(s);
  if (!lastSpoken) { lastSpoken = pending; return; }      // never announce the first render
  const wait = Math.max(0, lastAt + ANNOUNCE_EVERY - Date.now());
  if (!timer) timer = setTimeout(flush, wait);
}

function flush() {
  timer = 0;
  if (!pending) return;
  const changed = Object.keys(pending).filter((k) => pending[k] !== lastSpoken[k] && pending[k]).map((k) => pending[k]);
  lastSpoken = pending;
  if (!changed.length) return;
  lastAt = Date.now();
  const live = $('#statusLive');
  if (live) live.textContent = changed.join('. ') + '.';
}

/* ---------- sidebar dots + this-device card ---------- */
function renderSide() {
  const s = state.status;
  const dots = {
    mouse: s ? !!s.mouse && !cursorLocked() : null,
    clipboard: s ? !!s.clipboard : null,
    screen: state.screen ? screenSessions().length > 0 : null,
    camera: state.camera ? cameraShared() : null
  };
  for (const el of $$('[data-st]')) {
    const v = dots[el.dataset.st];
    el.hidden = v == null;
    if (v != null) el.classList.toggle('off', !v);
  }

  const foot = $('#sideFoot');
  const me = thisDevice();
  if (!foot) return;
  if (!me) { foot.hidden = true; return; }
  const osName = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }[me.os] || me.os;
  const ver = me.osVersion ? (String(me.osVersion).toLowerCase().startsWith(String(osName).toLowerCase()) ? me.osVersion : `${osName} ${me.osVersion}`) : osName;
  const mons = Array.isArray(me.screens) ? me.screens.length : 0;
  const linkType = me.link?.type || s?.link?.type;
  const parts = [ver, mons ? `${mons} monitor${mons === 1 ? '' : 's'}` : null, linkType ? LINK_LABELS[linkType] || linkType : null].filter(Boolean);
  const key = me.name + '|' + parts.join('|');
  if (foot.dataset.key === key) return;
  foot.dataset.key = key;
  foot.replaceChildren(h('b', null, me.name), ' · this device', h('br'), parts.join(' · '));
  foot.hidden = false;
}

export function startStatus() {
  build();
  const footer = $('.status');
  if (footer && !$('#statusLive')) footer.append(h('span.sr-only', { id: 'statusLive', role: 'status', 'aria-live': 'polite' }));
  onState(() => { render(); renderSide(); });
  render();
  renderSide();
}
