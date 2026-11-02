// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// A small live snapshot of the backend, used by the status bar, the sidebar dots and the
// command bar (to show only commands that make sense now). Pages keep their own subscriptions.

export const state = {
  status: null,      // Status
  devices: [],       // Device[]
  screen: null,      // screen.get() shape
  camera: null,      // camera.get() shape
  mouse: null,       // mouse.get() shape (no subscription in the API: refreshed on demand)
  multi: null,       // multi.get()
  clipboard: null    // clipboard.get()
};

const listeners = new Set();
export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(state); } catch (e) { console.warn('[shell] state listener', e); } } }

let api = null;

function sub(ns, method, key) {
  const fn = api?.[ns]?.[method];
  if (typeof fn !== 'function') return;
  try {
    const un = fn((v) => { state[key] = v; emit(); });
    // some implementations may return a promise of the unsubscribe fn; ignore either way
    if (un && typeof un.then === 'function') un.catch(() => {});
  } catch (e) { console.warn(`[shell] ${ns}.${method}`, e); }
}

async function get(ns, method, key) {
  const fn = api?.[ns]?.[method];
  if (typeof fn !== 'function') return;
  try { state[key] = await fn(); } catch (e) { /* keep the old value */ }
}

export function startState(omnidesk) {
  api = omnidesk;
  sub('status', 'on', 'status');
  sub('devices', 'on', 'devices');
  sub('screen', 'on', 'screen');
  sub('camera', 'on', 'camera');
  refresh();
}

/** Re-reads the values the API can't push to us. */
export async function refresh() {
  await Promise.all([
    get('mouse', 'get', 'mouse'),
    get('multi', 'get', 'multi'),
    get('clipboard', 'get', 'clipboard')
  ]);
  emit();
}

/** Helpers */
export const deviceById = (id) => state.devices.find((d) => d.id === id) || null;
export const deviceName = (id) => {
  if (!id) return '';
  const d = deviceById(id);
  return d ? d.name : (id === 'this' ? 'this device' : id);
};
export const thisDevice = () => state.devices.find((d) => d.thisDevice || d.id === 'this') || null;
export const macBook = () =>
  state.devices.find((d) => !d.thisDevice && d.paired !== false && /macbook/i.test(d.name)) ||
  state.devices.find((d) => !d.thisDevice && d.paired !== false && d.os === 'macos') || null;
// status is pushed live, so it wins over the on-demand getters
export const clipboardOn = () => (state.status ? !!state.status.clipboard : !!state.clipboard?.enabled);
export const mouseOn = () => (state.status ? !!state.status.mouse : !!state.mouse?.enabled);
export const cursorLocked = () => !!state.mouse?.locked;
export const multiOn = () => !!state.multi?.enabled;
export const cameraShared = () => !!state.camera?.shared;
export const screenSessions = () => state.screen?.sessions || [];

/** Merges a known result into the snapshot (e.g. after a command) and notifies. */
export function patch(key, value) {
  if (value && typeof value === 'object') state[key] = { ...(state[key] || {}), ...value };
  emit();
}
