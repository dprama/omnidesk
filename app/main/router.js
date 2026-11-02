// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Registers one ipcMain.handle per API method on channel "omnidesk:<area>.<method>".
// Every call: sender frame must be app://omnidesk/, arguments must match the
// method's shape, and the reply is { ok, value } or { ok:false, error:{code,message} }
// so the preload can reject with a plain { code, message }.

const { ApiError, badArgs } = require('./errors');

const APP_ORIGIN = 'app://omnidesk';

function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  if (!frame) return false;
  let url;
  try { url = new URL(frame.url); } catch { return false; }
  return url.protocol === 'app:' && url.host === 'omnidesk';
}

// Shape checkers: return true when ok.
const t = {
  none: () => true,
  str: (max = 500) => (v) => typeof v === 'string' && v.length <= max,
  id: (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[\w.:-]+$/.test(v),
  bool: (v) => typeof v === 'boolean',
  int: (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max,
  num: (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
  optional: (f) => (v) => v === undefined || v === null || f(v),
  oneOf: (...xs) => (v) => xs.includes(v),
  obj: (shape, { partial = false, extra = false } = {}) => (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    for (const k of Object.keys(v)) if (!shape[k] && !extra) return false;
    for (const [k, f] of Object.entries(shape)) {
      if (!(k in v)) { if (partial) continue; return false; }
      if (!f(v[k])) return false;
    }
    return true;
  },
  record: (keyF, valF, maxKeys = 64) => (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const ks = Object.keys(v);
    return ks.length <= maxKeys && ks.every((k) => keyF(k) && valF(v[k]));
  },
};

function checkArgs(spec, args) {
  if (!Array.isArray(args)) return false;
  if (args.length > spec.length) {
    // trailing undefined from optional params is fine
    if (args.slice(spec.length).some((a) => a !== undefined)) return false;
  }
  return spec.every((f, i) => f(args[i]));
}

function toError(e) {
  if (e instanceof ApiError) return e.toJSON();
  if (e && typeof e.code === 'string' && typeof e.message === 'string' && !(e instanceof Error)) return { code: e.code, message: e.message };
  return { code: 'internal', message: 'Something went wrong inside OmniDesk. The log has the details.' };
}

// methods: { 'area.method': { args: [checkers], run: async (...args) => value } }
function register(ipcMain, methods, { log } = {}) {
  const channels = [];
  for (const [name, def] of Object.entries(methods)) {
    const channel = `omnidesk:${name}`;
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) {
        if (log) log.warn(`ipc ${name} refused: untrusted sender ${event && event.senderFrame && event.senderFrame.url}`);
        return { ok: false, error: { code: 'forbidden', message: 'Not allowed.' } };
      }
      if (!checkArgs(def.args || [], args)) return { ok: false, error: badArgs(name).toJSON() };
      try {
        const value = await def.run(...args);
        return { ok: true, value: value === undefined ? null : value };
      } catch (e) {
        if (!(e instanceof ApiError) && log) log.error(`ipc ${name} failed: ${e && e.stack ? e.stack : e}`);
        return { ok: false, error: toError(e) };
      }
    });
  }
  return () => channels.forEach((c) => ipcMain.removeHandler(c));
}

module.exports = { register, isTrustedSender, checkArgs, t, APP_ORIGIN };
