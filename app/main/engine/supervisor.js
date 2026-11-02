// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Starts, stops and restarts deskflow-core, streams its output into the app
// log, writes its settings (Deskflow.conf, merged) and server config, and keeps
// the core IPC client connected.
//
// Every start logs exactly one line:
//   start mode=<server|client> helper=<absolute path> version=<engine version> pid=<pid>

const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ini = require('./ini');
const { CoreIpcClient, splitLines } = require('./ipc');
const paths = require('./paths');

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const STABLE_MS = 60000;
const EXIT_REASONS = {
  3: 'The engine rejected its start options.',
  4: 'The engine could not read its configuration.',
  5: 'Another copy of the engine is already running.',
};

// Engine log lines that explain a failed start better than its exit code does.
const LINE_REASONS = [
  [/assistive devices does not trust|Privacy & Security > Accessibility/,
    'macOS hasn\u2019t allowed OmniDesk to control the mouse and keyboard yet. Open System Settings \u2192 Privacy & Security \u2192 Accessibility and turn on OmniDesk.'],
  [/failed to create quartz event tap/,
    'macOS hasn\u2019t allowed OmniDesk to read the keyboard and mouse yet. Open System Settings \u2192 Privacy & Security \u2192 Input Monitoring and turn on OmniDesk.'],
  [/failed to initialize computer shape/,
    'No active display: the screen is asleep or closed. OmniDesk starts again when it wakes.'],
];

function reasonFromLine(line) {
  for (const [re, text] of LINE_REASONS) if (re.test(line)) return text;
  return null;
}

function run(bin, args, timeoutMs = 5000, env = process.env) {
  return new Promise((resolve) => {
    childProcess.execFile(bin, args, { timeout: timeoutMs, windowsHide: true, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}\n${stderr || ''}` });
    });
  });
}

// `deskflow-core --ipc-version` prints exactly one line `<kVersion>+<sha>`;
// trim it (\n or \r\n) before using it as the hello id. The sha is empty when the engine
// was built without git metadata (2.5.0's release engines print `1.27.0.0+`).
function parseIpcVersion(out) {
  const re = /^\d[\w.-]*\+[0-9A-Za-z]*$/;
  return String(out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => re.test(l)) || null;
}

// The decision lines (cross / no-cross) are INFO; anything less detailed hides them.
const DETAILED_ENOUGH = ['INFO', 'DEBUG', 'VERBOSE'];

// Dev runs on macOS use an engine linked against a Qt install, not the deployed
// Frameworks/ folder. macOS strips DYLD_* from the (signed) Electron process, so
// pass the Qt lib folder on explicitly: $OMNIDESK_QT_LIB, else ~/Qt/6.9.3/macos/lib.
// Packaged builds never need this (build/engine/deploy-macos.sh).
function engineEnv({ isPackaged, platform = process.platform, env = process.env, exists = fs.existsSync, home = require('node:os').homedir() } = {}) {
  if (isPackaged || platform !== 'darwin') return env;
  const dir = env.OMNIDESK_QT_LIB || env.DYLD_FRAMEWORK_PATH || path.join(home, 'Qt', '6.9.3', 'macos', 'lib');
  return exists(dir) ? { ...env, DYLD_FRAMEWORK_PATH: dir } : env;
}

function toQtPath(p) { return process.platform === 'win32' ? p.replace(/\\/g, '/') : p; }

class EngineSupervisor extends EventEmitter {
  constructor({ log, isPackaged = false, resourcesPath = '', repoRoot, userData, spawn = childProcess.spawn, pathOpts = {} }) {
    super();
    this.log = log;
    this.elog = log.child ? log.child('engine') : log;
    this.spawnFn = spawn;
    this.userData = userData;
    this.paths = paths.enginePaths(pathOpts);
    this.serverConfigFile = path.join(userData, 'engine', 'deskflow-server.conf');
    this.env = engineEnv({ isPackaged });
    const found = paths.findEngineBinary({ packaged: isPackaged, resourcesPath, repoRoot });
    this.binary = found.path;
    this.searched = found.searched;
    this.version = '';
    this.ipcVersion = '';
    this.mode = 'off';
    this.child = null;
    this.pid = null;
    this.reason = this.binary ? '' : `The OmniDesk engine was not found. Looked in: ${found.searched.join(', ')}`;
    this.attempt = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.startedAt = 0;
    this.ipc = new CoreIpcClient({ path: this.paths.ipcPath, log: (m) => this.log(m) });
    this.ipc.on('connected', (info) => { this.log(`engine ipc connected version=${info.version}${info.matched ? '' : ' (mismatch)'}`); this._emitStatus(); });
    this.ipc.on('disconnected', () => this._emitStatus());
    this.ipc.on('message', (cmd, value) => this.emit('ipc', cmd, value));
    if (!this.binary) this.log.warn(this.reason);
  }

  async detectVersion() {
    if (!this.binary || this.version) return this.version;
    const ipcRes = await run(this.binary, ['--ipc-version'], 5000, this.env);
    const ipcLine = parseIpcVersion(ipcRes.out);
    const ipcMatch = ipcLine ? [ipcLine, ipcLine] : null;
    const verRes = await run(this.binary, ['--version'], 5000, this.env);
    const verMatch = /\bv(\d[\w.+-]*?),/.exec(verRes.out) || /\bv(\d[\w.+-]*)/.exec(verRes.out);
    this.version = verMatch ? verMatch[1] : ipcMatch ? ipcMatch[1].split('+')[0] : 'unknown';
    // Fallback: without --ipc-version the hello will mismatch; the engine still
    // serves us after versionMismatch, so IPC keeps working (logged once).
    this.ipcVersion = ipcMatch ? ipcMatch[1] : this.version;
    if (!ipcMatch) this.log.warn('engine has no --ipc-version; IPC hello will report a version mismatch');
    this.ipc.setVersion(this.ipcVersion);
    return this.version;
  }

  status() {
    return {
      running: !!this.child,
      version: this.version || '',
      helperPath: this.binary || '',
      reason: this.child ? '' : this.reason,
      pid: this.pid,
      mode: this.mode,
      ipcConnected: this.ipc.connected,
      connectionState: this.ipc.connectionState,
    };
  }

  _emitStatus() { this.emit('status', this.status()); }

  // Merge values into Deskflow.conf. values: { 'group/key': v | null }.
  writeSettings(values, { removeGroups } = {}) {
    const file = this.paths.settingsFile;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    const next = ini.update(text, values, { removeGroups });
    if (next === text) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    return true;
  }

  readSetting(key) {
    try { return ini.get(fs.readFileSync(this.paths.settingsFile, 'utf8'), key); } catch { return undefined; }
  }

  writeServerConfig(text) {
    let old = null;
    try { old = fs.readFileSync(this.serverConfigFile, 'utf8'); } catch { /* none */ }
    fs.mkdirSync(path.dirname(this.serverConfigFile), { recursive: true });
    if (old !== text) fs.writeFileSync(this.serverConfigFile, text);
    this.writeSettings({ 'server/externalConfig': true, 'server/externalConfigFile': toQtPath(this.serverConfigFile) });
    return old !== text;
  }

  async start(mode) {
    if (mode !== 'server' && mode !== 'client') throw new Error(`bad engine mode ${mode}`);
    this.mode = mode;
    this.stopping = false;
    clearTimeout(this.restartTimer);
    if (!this.binary) { this._emitStatus(); return false; }
    if (this.child) return true;
    await this.detectVersion();
    try {
      const values = { 'core/coreMode': mode === 'server' ? 2 : 1 };
      const level = String(this.readSetting('log/level') || '').toUpperCase();
      if (!DETAILED_ENOUGH.includes(level)) values['log/level'] = 'INFO';
      this.writeSettings(values);
    } catch (e) {
      this.log.warn(`could not write engine settings: ${e.message}`);
    }
    const args = [mode, '--settings', this.paths.settingsFile];
    let child;
    try {
      child = this.spawnFn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.env });
    } catch (e) {
      this.reason = `The engine could not start: ${e.message}`;
      this.log.error(this.reason);
      this._scheduleRestart();
      return false;
    }
    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();
    this.lineReason = null;
    this.reason = '';
    this.log(`start mode=${mode} helper=${this.binary} version=${this.version || 'unknown'} pid=${child.pid}`);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const [lines, rest] = splitLines(buf + chunk);
        buf = rest;
        for (const l of lines) {
          if (!l.trim()) continue;
          this.elog(l);
          const why = reasonFromLine(l);
          if (why) this.lineReason = why;
          this.emit('line', l);
        }
      });
    }
    child.on('error', (e) => { this.reason = `The engine could not start: ${e.message}`; this.log.error(this.reason); });
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
    this.ipc.start();
    this._emitStatus();
    return true;
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.pid = null;
    this.log(`engine exited code=${code} signal=${signal || 'none'}`);
    if (this.stopping) {
      this.reason = 'Stopped.';
      this.ipc.stop();
      this._emitStatus();
      return;
    }
    this.reason = this.lineReason || EXIT_REASONS[code] || `The engine stopped unexpectedly (code ${code}${signal ? `, ${signal}` : ''}).`;
    if (Date.now() - this.startedAt > STABLE_MS) this.attempt = 0;
    this._scheduleRestart();
    this._emitStatus();
  }

  _scheduleRestart() {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.log(`engine restart in ${delay}ms (attempt ${this.attempt})`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { if (!this.stopping && this.mode !== 'off') this.start(this.mode); }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) { this.ipc.stop(); this._emitStatus(); return; }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
    if (this.ipc.connected) await this.ipc.send('stop').catch(() => {});
    else child.kill();
    if (await Promise.race([exited.then(() => true), wait(3000).then(() => false)])) return;
    child.kill();
    if (await Promise.race([exited.then(() => true), wait(2000).then(() => false)])) return;
    child.kill('SIGKILL');
  }

  async restart(mode = this.mode) {
    await this.stop();
    this.attempt = 0;
    if (mode === 'off') { this.mode = 'off'; this._emitStatus(); return false; }
    return this.start(mode);
  }

  send(command, value) { return this.ipc.send(command, value); }

  // Sends `command` and resolves with the value of the next `reply=` message
  // (e.g. query('monitors?', 'monitors')). Rejects on timeout / not connected.
  query(command, reply, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const onMsg = (cmd, value) => {
        if (cmd === 'error') { done(); reject(Object.assign(new Error(`engine: ${value}`), { code: 'engine-error' })); }
        else if (cmd === reply) { done(); resolve(value); }
      };
      const timer = setTimeout(() => { done(); reject(Object.assign(new Error(`engine did not answer ${command}`), { code: 'timeout' })); }, timeoutMs);
      const done = () => { clearTimeout(timer); this.ipc.off('message', onMsg); };
      this.ipc.on('message', onMsg);
      this.ipc.send(command).catch((e) => { done(); reject(e); });
    });
  }
}

module.exports = { EngineSupervisor, BACKOFF_MS, parseIpcVersion, DETAILED_ENOUGH, engineEnv, reasonFromLine };
