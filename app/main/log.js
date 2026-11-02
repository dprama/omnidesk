// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Rotating app log: <userData>/logs/omnidesk.log, rotated at maxBytes into
// omnidesk.1.log … omnidesk.<keep>.log. Keeps the last lines in memory for
// app.logs.tail() and notifies subscribers for app.logs.onLine().

const fs = require('node:fs');
const path = require('node:path');

const RING_MAX = 1000;

function createLogger({ dir, maxBytes = 2 * 1024 * 1024, keep = 3, echo = false } = {}) {
  const ring = [];
  const listeners = new Set();
  let file = null;
  let size = 0;

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'omnidesk.log');
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      file = null;
    }
  }

  function rotate() {
    try {
      for (let i = keep - 1; i >= 1; i--) {
        const from = path.join(dir, `omnidesk.${i}.log`);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `omnidesk.${i + 1}.log`));
      }
      fs.renameSync(file, path.join(dir, 'omnidesk.1.log'));
    } catch {
      // keep logging into the current file if rotation fails
    }
    size = 0;
  }

  function write(scope, msg) {
    const text = String(msg).replace(/[\r\n]+$/g, '');
    for (const part of text.split(/\r?\n/)) {
      const line = `${new Date().toISOString()} ${scope}: ${part}`;
      ring.push(line);
      if (ring.length > RING_MAX) ring.shift();
      if (echo) process.stdout.write(line + '\n');
      if (file) {
        try {
          const buf = line + '\n';
          if (size + buf.length > maxBytes) rotate();
          fs.appendFileSync(file, buf);
          size += Buffer.byteLength(buf);
        } catch {
          // disk full or read-only: the ring buffer still works
        }
      }
      for (const cb of listeners) {
        try { cb(line); } catch { /* a bad subscriber must not break logging */ }
      }
    }
  }

  function scoped(scope) {
    const f = (msg) => write(scope, msg);
    f.info = f;
    f.warn = (msg) => write(scope, `warn ${msg}`);
    f.error = (msg) => write(scope, `error ${msg}`);
    f.child = (sub) => scoped(`${scope}/${sub}`);
    return f;
  }

  const root = scoped('main');
  root.tail = (n = 200) => ring.slice(-Math.max(1, Math.min(RING_MAX, n | 0)));
  root.onLine = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  root.file = file;
  return root;
}

module.exports = { createLogger };
