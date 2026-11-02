// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Which kind of link a network interface is: 'wifi' | 'ethernet' | 'usb' |
// 'bluetooth'. USB/Thunderbolt networking and Bluetooth PAN are IP links too,
// so this only labels them for the UI and picks the preferred address.
//
// macOS:   `networksetup -listallhardwareports` (Hardware Port name per device)
// Windows: PowerShell Get-NetAdapter Name, InterfaceDescription, MediaType
// Linux:   /sys/class/net/<if> (wireless/, bnep*, device path through usb)

const { execFile } = require('node:child_process');
const fs = require('node:fs');

const LINK_TYPES = ['ethernet', 'wifi', 'usb', 'bluetooth'];

// Classifies a human label (macOS hardware port, Windows description).
function classifyLabel(label, mediaType = '') {
  const s = `${label || ''}`.toLowerCase();
  const m = `${mediaType || ''}`.toLowerCase();
  if (/bluetooth/.test(s) || /bluetooth/.test(m)) return 'bluetooth';
  if (/\b(usb|rndis|thunderbolt bridge|apple mobile device|iphone|ipad|android|remote ndis)\b/.test(s) || /thunderbolt(?! ethernet)/.test(s)) return 'usb';
  if (/wi-?fi|airport|wireless|wlan|802\.11/.test(s) || /802\.11|wireless|wi-?fi/.test(m)) return 'wifi';
  return 'ethernet';
}

// `networksetup -listallhardwareports` → { en0: 'wifi', bridge0: 'usb', … }
function parseMacHardwarePorts(text) {
  const out = {};
  let port = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^Hardware Port:\s*(.+)$/))) port = m[1];
    else if ((m = line.match(/^Device:\s*(\S+)$/)) && port) { out[m[1]] = classifyLabel(port); port = null; }
  }
  return out;
}

// Get-NetAdapter … | ConvertTo-Json (one object or an array). Also accepts
// the default table text of `Select Name,InterfaceDescription,MediaType`.
function parseWindowsAdapters(text) {
  const out = {};
  const s = String(text || '').trim();
  if (!s) return out;
  if (s.startsWith('{') || s.startsWith('[')) {
    let list;
    try { list = JSON.parse(s); } catch { return out; }
    for (const a of Array.isArray(list) ? list : [list]) {
      if (a && a.Name) out[a.Name] = classifyLabel(`${a.InterfaceDescription || ''} ${a.Name}`, a.MediaType);
    }
    return out;
  }
  // Table: header line, dashes line with column widths, rows.
  const lines = s.split(/\r?\n/);
  const dashIdx = lines.findIndex((l) => /^-{2,}(\s+-{2,})*\s*$/.test(l.trim()) && l.includes('-'));
  if (dashIdx < 1) return out;
  const cols = [];
  const re = /-+/g;
  let m;
  while ((m = re.exec(lines[dashIdx]))) cols.push(m.index);
  for (const row of lines.slice(dashIdx + 1)) {
    if (!row.trim()) continue;
    const cell = (i) => row.slice(cols[i], i + 1 < cols.length ? cols[i + 1] : undefined).trim();
    const name = cell(0);
    if (name) out[name] = classifyLabel(`${cell(1)} ${name}`, cols.length > 2 ? cell(2) : '');
  }
  return out;
}

// Linux from sysfs facts: { name, wireless, devicePath }.
function classifyLinux({ name, wireless, devicePath }) {
  if (/^bnep\d/.test(name) || /bluetooth/i.test(devicePath || '')) return 'bluetooth';
  if (wireless || /^(wl|wlan)/.test(name)) return 'wifi';
  if (/\/usb\d/.test(devicePath || '') || /^(usb|enx)/.test(name)) return 'usb';
  return 'ethernet';
}

// Fallback by interface name when a platform command gave nothing.
function classifyByName(name, platform = process.platform) {
  const n = String(name).toLowerCase();
  if (/bluetooth|bnep|pan/.test(n)) return 'bluetooth';
  if (/wi-?fi|wlan|wireless|^wl/.test(n)) return 'wifi';
  if (/usb|rndis|thunderbolt|^bridge|iphone/.test(n)) return 'usb';
  if (platform === 'darwin' && n === 'en0') return 'wifi';
  return 'ethernet';
}

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

// Detects types for every interface. Results are cached by the caller.
async function detect(platform = process.platform, names = []) {
  let map = {};
  if (platform === 'darwin') {
    map = parseMacHardwarePorts(await run('/usr/sbin/networksetup', ['-listallhardwareports']));
  } else if (platform === 'win32') {
    map = parseWindowsAdapters(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-NetAdapter | Select Name,InterfaceDescription,MediaType | ConvertTo-Json -Compress']));
  } else {
    for (const name of names) {
      let wireless = false;
      let devicePath = '';
      try { wireless = fs.existsSync(`/sys/class/net/${name}/wireless`); } catch { /* none */ }
      try { devicePath = fs.realpathSync(`/sys/class/net/${name}/device`); } catch { /* virtual */ }
      map[name] = classifyLinux({ name, wireless, devicePath });
    }
  }
  for (const n of names) if (!map[n]) map[n] = classifyByName(n, platform);
  return map;
}

module.exports = { LINK_TYPES, classifyLabel, parseMacHardwarePorts, parseWindowsAdapters, classifyLinux, classifyByName, detect };
