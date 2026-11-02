// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Runs native/macos-virtual-display (Swift, private CGVirtualDisplay API).
// The helper prints one JSON line with the CGDirectDisplayID (which is also
// Electron's display.id and desktopCapturer's display_id) and keeps the
// monitor alive until its stdin closes; so the monitor also disappears if
// OmniDesk crashes.

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const NAME = 'omnidesk-virtual-display';

function defaultHelperPath({ isPackaged = false, resourcesPath = '' } = {}) {
  if (isPackaged) return path.join(resourcesPath, 'native', NAME);
  return path.join(__dirname, '..', '..', '..', 'native', 'macos-virtual-display', 'dist', NAME);
}

function createMacHelper({ helperPath, spawn = childProcess.spawn, startTimeoutMs = 8000, stopTimeoutMs = 3000, log = () => {} } = {}) {
  const live = new Set();

  function available() {
    try { fs.accessSync(helperPath, fs.constants.X_OK); return true; } catch { return false; }
  }

  function create({ width, height, refresh, hidpi = false }) {
    return new Promise((resolve, reject) => {
      const args = ['--width', String(width), '--height', String(height), '--refresh', String(refresh), '--name', 'OmniDesk Display'];
      if (hidpi) args.push('--hidpi');
      let child;
      try { child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
      live.add(child);
      let buf = '';
      let settled = false;
      let exited = false;
      let onRemoved = null;
      const settle = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { kill(); reject(err); } else resolve(val); };
      const timer = setTimeout(() => settle(Object.assign(new Error('The virtual display helper did not answer.'), { code: 'helper-timeout' })), startTimeoutMs);
      function kill() { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => { if (!exited) try { child.kill('SIGKILL'); } catch { /* gone */ } }, stopTimeoutMs).unref?.(); }

      child.stderr.on('data', (d) => log(`helper: ${String(d).trim().slice(0, 300)}`));
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ok === false) { settle(Object.assign(new Error(`Virtual display failed: ${msg.message || msg.error}`), { code: msg.error === 'api-missing' ? 'unsupported' : 'helper-failed' })); continue; }
          if (typeof msg.displayId === 'number' && !settled) {
            log(`virtual display ${msg.displayId} ${msg.width}x${msg.height}@${msg.refresh}`);
            settle(null, {
              displayId: String(msg.displayId),
              remove() {
                if (exited) return Promise.resolve();
                return new Promise((r) => { onRemoved = r; kill(); });
              },
              onExit(cb) { child.once('exit', cb); },
            });
          }
        }
      });
      child.on('error', (e) => settle(Object.assign(new Error(`Could not start the virtual display helper: ${e.message}`), { code: 'helper-failed' })));
      child.on('exit', (code, sig) => {
        exited = true;
        live.delete(child);
        log(`helper exited code=${code} signal=${sig || ''}`);
        settle(Object.assign(new Error(`The virtual display helper stopped (code ${code}).`), { code: 'helper-failed' }));
        if (onRemoved) onRemoved();
      });
    });
  }

  // Synchronous last-resort cleanup (process exit).
  function killAll() { for (const c of live) { try { c.stdin.end(); c.kill('SIGTERM'); } catch { /* gone */ } } }

  return { helperPath, available, create, killAll };
}

module.exports = { createMacHelper, defaultHelperPath, NAME };
