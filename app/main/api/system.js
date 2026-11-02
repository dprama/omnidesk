// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Battery (macOS pmset, Windows CIM, Linux sysfs), TCP ping and OS facts.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function exec(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function parsePmset(text) {
  const m = /(\d+)%;\s*([^;]+);/.exec(text || '');
  if (!m) return null;
  const state = m[2].trim().toLowerCase();
  return { percent: Number(m[1]), charging: state === 'charging' || state === 'charged' || state === 'finishing charge' || state === 'ac attached' };
}

// Win32_Battery BatteryStatus: 1 = discharging, 2 = on AC, 6-9 = charging states.
function parseCim(text) {
  if (!text || !text.trim()) return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (Array.isArray(v)) v = v[0];
  if (!v || typeof v.EstimatedChargeRemaining !== 'number') return null;
  return { percent: Math.max(0, Math.min(100, v.EstimatedChargeRemaining)), charging: [2, 3, 6, 7, 8, 9].includes(v.BatteryStatus) };
}

function readLinuxBattery(root = '/sys/class/power_supply') {
  let entries;
  try { entries = fs.readdirSync(root); } catch { return null; }
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const type = fs.readFileSync(path.join(dir, 'type'), 'utf8').trim();
      if (type !== 'Battery') continue;
      const percent = Number(fs.readFileSync(path.join(dir, 'capacity'), 'utf8').trim());
      const status = fs.readFileSync(path.join(dir, 'status'), 'utf8').trim().toLowerCase();
      if (!Number.isFinite(percent)) continue;
      return { percent, charging: status === 'charging' || status === 'full' };
    } catch { /* not a readable battery */ }
  }
  return null;
}

async function battery(platform = process.platform) {
  if (platform === 'darwin') return parsePmset(await exec('pmset', ['-g', 'batt']));
  if (platform === 'win32') {
    return parseCim(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress']));
  }
  return readLinuxBattery();
}

// Round-trip of a TCP connect to the peer's engine port (no ICMP privileges needed).
function ping(host, port = 24800, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    const t0 = process.hrtime.bigint();
    const sock = net.createConnection({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.once('connect', () => done(Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6))));
    sock.once('error', () => done(null));
  });
}

function osName(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
}

async function osVersion(platform = process.platform) {
  if (platform === 'darwin') {
    const v = await exec('sw_vers', ['-productVersion'], 3000);
    if (v) return v.trim();
  }
  if (platform === 'win32') {
    // os.release() is 10.0.<build>; build >= 22000 is Windows 11
    const build = Number(os.release().split('.')[2] || 0);
    return `${build >= 22000 ? '11' : '10'} (${os.release()})`;
  }
  return os.release();
}

function arch() { return process.arch === 'arm64' ? 'arm64' : 'x64'; }

module.exports = { battery, ping, osName, osVersion, arch, parsePmset, parseCim, readLinuxBattery };
