// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Turns the Virtual Display Driver monitor on/off on Windows without a native
// addon and without a UAC prompt per session. native/windows-vdd/install-vdd.ps1
// (run elevated once by the installer) sets up:
//   %ProgramData%\OmniDesk\vdd\installed.json      marker
//   %ProgramData%\OmniDesk\vdd\request\request.json  we write this (users may)
//   %ProgramData%\OmniDesk\vdd\status\status.json    SYSTEM answers here
//   task \OmniDesk\VirtualDisplay                    runs vdd-task.ps1 as SYSTEM
// The driver's own control pipe (\\.\pipe\MTTVirtualDisplayPipe, UTF-16LE
// commands such as PING / RELOAD_DRIVER / SETDISPLAYCOUNT n) is used only to
// check that the driver is loaded.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const TASK = '\\OmniDesk\\VirtualDisplay';
const PIPE = '\\\\.\\pipe\\MTTVirtualDisplayPipe';

function defaultRoot() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'OmniDesk', 'vdd');
}

function defaultRunTask() {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', ['/Run', '/TN', TASK], { windowsHide: true, timeout: 15000 }, (err, _out, stderr) => {
      if (err) reject(Object.assign(new Error(`schtasks: ${String(stderr || err.message).trim()}`), { code: 'vdd-task' }));
      else resolve();
    });
  });
}

// The driver reads commands as wchar_t (UTF-16LE).
function encodePipeCommand(cmd) {
  if (typeof cmd !== 'string' || !/^[A-Z_]{2,32}( [\w.-]{1,64})?$/.test(cmd)) throw new Error('bad pipe command');
  return Buffer.from(cmd, 'utf16le');
}

function validMode(m) {
  return m && Number.isInteger(m.width) && Number.isInteger(m.height) && Number.isInteger(m.refresh)
    && m.width >= 640 && m.width <= 7680 && m.height >= 480 && m.height <= 4320 && m.refresh >= 24 && m.refresh <= 240;
}

function createVdd({
  root = defaultRoot(),
  runTask = defaultRunTask,
  pipePath = PIPE,
  pollMs = 200,
  timeoutMs = 25000,
  log = () => {},
} = {}) {
  const fsp = fs.promises;
  const reqFile = path.join(root, 'request', 'request.json');
  const statusFile = path.join(root, 'status', 'status.json');
  let chain = Promise.resolve();

  function installed() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, 'installed.json'), 'utf8'));
      return { installed: true, version: m.version || '', instanceId: m.instanceId || '' };
    } catch {
      return { installed: false, why: 'The OmniDesk virtual display driver is not installed. Reinstall OmniDesk and allow the driver step.' };
    }
  }

  async function readStatus() {
    try { return JSON.parse(await fsp.readFile(statusFile, 'utf8')); } catch { return null; }
  }

  async function run(action, mode) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = { nonce, action, ...(mode ? { width: mode.width, height: mode.height, refresh: mode.refresh } : {}) };
    const tmp = `${reqFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(body));
    await fsp.rename(tmp, reqFile);
    await runTask();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await readStatus();
      if (st && st.nonce === nonce) {
        if (st.ok) { log(`vdd ${action} ok${mode ? ` ${mode.width}x${mode.height}@${mode.refresh}` : ''}`); return st; }
        throw Object.assign(new Error(st.error === 'driver-missing'
          ? 'The virtual display driver is missing. Reinstall OmniDesk.'
          : `The virtual display could not be turned ${action}: ${st.error || 'unknown error'}`), { code: 'vdd-failed' });
      }
      if (Date.now() > deadline) throw Object.assign(new Error(`The virtual display did not turn ${action} in time.`), { code: 'vdd-timeout' });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // Serialise: never two task runs at once.
  function queue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  return {
    root,
    installed,
    enable(mode) {
      if (!validMode(mode)) return Promise.reject(Object.assign(new Error('bad display mode'), { code: 'bad-args' }));
      return queue(() => run('on', mode));
    },
    disable() { return queue(() => run('off')); },
    // For process exit: no waiting. Writes the request and starts the task detached.
    disableSync() {
      try {
        fs.writeFileSync(reqFile, JSON.stringify({ nonce: crypto.randomBytes(16).toString('hex'), action: 'off' }));
        spawn('schtasks.exe', ['/Run', '/TN', TASK], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch { /* best effort */ }
    },
    // Sends one command on the driver pipe; resolves with the reply text ('' if none).
    pipeCommand(cmd, { timeout = 1500 } = {}) {
      const data = encodePipeCommand(cmd);
      return new Promise((resolve, reject) => {
        const sock = net.connect(pipePath);
        const chunks = [];
        const done = (err) => { clearTimeout(t); sock.destroy(); if (err) reject(err); else resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '')); };
        const t = setTimeout(() => done(), timeout);
        sock.on('connect', () => sock.write(data));
        sock.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).length > 4096) done(); });
        sock.on('error', (e) => done(Object.assign(new Error(`driver pipe: ${e.code || e.message}`), { code: 'vdd-pipe' })));
        sock.on('end', () => done());
      });
    },
  };
}

module.exports = { createVdd, encodePipeCommand, validMode, TASK, PIPE };
