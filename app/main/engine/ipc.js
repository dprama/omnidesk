// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Client for the engine's core IPC server (QLocalServer "deskflow-core").
// Protocol (engine/src/lib/deskflow/ipc/IpcServer.cpp, gui/ipc/IpcClient.cpp):
//   UTF-8 lines ending in "\n", "command" or "command=value".
//   Handshake: we send hello=<kVersion>+<kVersionGitSha>; server answers
//   hello=<id> (match), versionMismatch=<id> (still served, we stay connected)
//   or error=<detail> (it hangs up). Then queued messages are replayed.
//   noop -> ok (keep-alive). Server sends "bye" before it stops.

const { EventEmitter } = require('node:events');
const defaultNet = require('node:net');

// Split a buffer into complete lines; returns [lines, rest].
function splitLines(buffer) {
  const lines = [];
  let rest = buffer;
  let i;
  while ((i = rest.indexOf('\n')) >= 0) {
    lines.push(rest.slice(0, i).replace(/\r$/, ''));
    rest = rest.slice(i + 1);
  }
  return [lines, rest];
}

// "a=b=c" -> { command: 'a', value: 'b=c' }; the engine itself only reads
// parts[1], but keeping the tail is harmless and future proof.
function parseMessage(line) {
  const eq = line.indexOf('=');
  return eq < 0 ? { command: line, value: '' } : { command: line.slice(0, eq), value: line.slice(eq + 1) };
}

function formatMessage(command, value) {
  // a trailing '?' marks a query (`monitors?` -> `monitors=…`)
  if (typeof command !== 'string' || !/^[A-Za-z][\w-]*\??$/.test(command)) throw new Error('bad ipc command');
  const v = value === undefined || value === null || value === '' ? '' : String(value);
  if (/[\r\n]/.test(v)) throw new Error('ipc value must be one line');
  return v ? `${command}=${v}\n` : `${command}\n`;
}

class CoreIpcClient extends EventEmitter {
  constructor({ path, version, net = defaultNet, retryMs = 1000, keepAliveMs = 10000, log } = {}) {
    super();
    this.path = path;
    this.version = version || '';
    this.net = net;
    this.retryMs = retryMs;
    this.keepAliveMs = keepAliveMs;
    this.log = log || (() => {});
    this.state = 'idle'; // idle | connecting | handshake | connected
    this.versionMatched = null;
    this.connectionState = null;
    this.socket = null;
    this.buffer = '';
    this.wanted = false;
    this.retryTimer = null;
    this.keepAliveTimer = null;
  }

  setVersion(version) { this.version = version || ''; }

  start() {
    this.wanted = true;
    if (this.state === 'idle') this._connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this._teardown();
  }

  get connected() { return this.state === 'connected'; }

  // Generic send; resolves true when written, rejects when not connected.
  send(command, value) {
    const msg = formatMessage(command, value);
    if (this.state !== 'connected') return Promise.reject(Object.assign(new Error('engine ipc not connected'), { code: 'engine-offline' }));
    return new Promise((resolve, reject) => {
      this.socket.write(msg, 'utf8', (err) => (err ? reject(err) : resolve(true)));
    });
  }

  noop() { return this.send('noop'); }

  _connect() {
    clearTimeout(this.retryTimer);
    this.state = 'connecting';
    this.buffer = '';
    let sock;
    try {
      sock = this.net.createConnection(this.path);
    } catch (e) {
      this._scheduleRetry(e);
      return;
    }
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      this.state = 'handshake';
      sock.write(`hello=${this.version}\n`);
    });
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', (err) => { this._lastError = err; });
    sock.on('close', () => {
      const was = this.state;
      this._teardown();
      if (was === 'connected') this.emit('disconnected');
      if (this.wanted) this._scheduleRetry(this._lastError);
    });
  }

  _scheduleRetry(err) {
    this.state = 'idle';
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.wanted && this.state === 'idle') this._connect(); }, this.retryMs);
    if (this.retryTimer.unref) this.retryTimer.unref();
    this.emit('retry', err);
  }

  _teardown() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.destroy();
      this.socket = null;
    }
    this.state = 'idle';
  }

  _onData(chunk) {
    const [lines, rest] = splitLines(this.buffer + chunk);
    this.buffer = rest;
    for (const line of lines) {
      if (!line) continue;
      const { command, value } = parseMessage(line);
      if (this.state === 'handshake') {
        this._onHandshake(command, value);
        continue;
      }
      if (this.state !== 'connected') continue;
      if (command === 'bye') {
        this.emit('bye');
        continue; // socket close follows
      }
      if (command === 'connectionState') {
        this.connectionState = value;
        this.emit('connectionState', value);
      }
      this.emit('message', command, value);
    }
  }

  _onHandshake(command, value) {
    if (command === 'error') {
      this.log(`engine ipc rejected hello: ${value || 'unknown'}`);
      this.emit('rejected', value);
      if (this.socket) this.socket.destroy();
      return;
    }
    if (command === 'hello' || command === 'versionMismatch') {
      this.versionMatched = command === 'hello';
      this.state = 'connected';
      if (!this.versionMatched) {
        this.log(`engine ipc version mismatch (app sent ${this.version || '(none)'}, engine is ${value})`);
        this.emit('versionMismatch', value);
      }
      if (this.keepAliveMs > 0) {
        this.keepAliveTimer = setInterval(() => { this.noop().catch(() => {}); }, this.keepAliveMs);
        if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
      }
      this.emit('connected', { version: value, matched: this.versionMatched });
    }
  }
}

module.exports = { CoreIpcClient, splitLines, parseMessage, formatMessage };
