// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Pure logic behind the Download button: read a GitHub release, work out the visitor's
// platform, pick the right file. No DOM, no network, so it runs in node --test as well.

export const REPO = 'dprama/omnidesk';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

const OS_NAMES = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
// The one file type we offer per OS, in order of preference.
const PREFERRED_EXT = { win: ['exe'], mac: ['dmg'], linux: ['appimage'] };
const NAME_RE = /^OmniDesk-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(win|mac|linux)-(x64|arm64)\.([A-Za-z0-9]+)$/;

export const APPLE_SILICON_NOTE = 'Runs on Intel Macs; on Apple silicon it needs Rosetta.';

const ext = (name) => (name.split('.').pop() || '').toLowerCase();

/** Parse an asset name like OmniDesk-2.5.0-win-x64.exe. Returns null when it doesn't match. */
export function parseAssetName(name) {
  const m = NAME_RE.exec(String(name || ''));
  if (!m) return null;
  return { version: m[1], os: m[2], arch: m[3], ext: m[4].toLowerCase() };
}

function cleanSha(s) {
  if (typeof s !== 'string') return null;
  const hex = s.replace(/^sha256:/i, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function validFile(f) {
  return f && OS_NAMES[f.os] && (f.arch === 'x64' || f.arch === 'arm64') &&
    typeof f.name === 'string' && typeof f.url === 'string' && /^https:\/\//.test(f.url);
}

/**
 * Turn a GitHub "latest release" response (and, when available, the parsed latest.json
 * asset) into { version, files: [{ os, arch, name, url, size, sha256 }] }.
 * latest.json wins when it is present and well formed; otherwise asset names are matched.
 */
export function normalizeRelease(release, latestJson) {
  if (latestJson && Array.isArray(latestJson.files)) {
    const files = latestJson.files.filter(validFile).map((f) => ({
      os: f.os, arch: f.arch, name: f.name, url: f.url,
      size: Number(f.size) > 0 ? Number(f.size) : null, sha256: cleanSha(f.sha256),
    }));
    if (files.length) {
      const version = String(latestJson.version || '').replace(/^v/, '') || versionFromTag(release) || parseAssetName(files[0].name)?.version || null;
      return { version, files };
    }
  }
  const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
  const files = [];
  for (const a of assets) {
    const p = parseAssetName(a && a.name);
    if (!p || !a.browser_download_url) continue;
    files.push({
      os: p.os, arch: p.arch, name: a.name, url: a.browser_download_url,
      size: Number(a.size) > 0 ? Number(a.size) : null, sha256: cleanSha(a.digest), version: p.version,
    });
  }
  const version = versionFromTag(release) || (files[0] && files[0].version) || null;
  return { version, files: files.map(({ version: _v, ...f }) => f) };
}

function versionFromTag(release) {
  const t = release && typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(t);
  return m ? m[1] : null;
}

/** Find the latest.json asset in a GitHub release, if any. */
export function latestJsonAsset(release) {
  const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
  return assets.find((a) => a && a.name === 'latest.json') || null;
}

/**
 * Work out { os: 'win'|'mac'|'linux'|'unknown', arch: 'x64'|'arm64'|null }.
 * hints = { uaPlatform, architecture, bitness } from userAgentData (optional),
 *         userAgent, platform (navigator.platform), maxTouchPoints.
 */
export function detectPlatform(hints = {}) {
  const ua = String(hints.userAgent || '');
  const plat = String(hints.platform || '');
  const uaPlatform = String(hints.uaPlatform || '');
  const hiArch = String(hints.architecture || '').toLowerCase();
  const touch = Number(hints.maxTouchPoints || 0);

  let os = 'unknown';
  if (uaPlatform) {
    if (/^windows$/i.test(uaPlatform)) os = 'win';
    else if (/^macos$/i.test(uaPlatform)) os = 'mac';
    else if (/^linux$/i.test(uaPlatform)) os = 'linux';
    // Android, Chrome OS, iOS etc. stay unknown: there is no build for them.
  } else if (/android|iphone|ipad|ipod|cros/i.test(ua)) {
    os = 'unknown';
  } else if (/windows nt|win64|win32/i.test(ua) || /^win/i.test(plat)) {
    os = 'win';
  } else if (/macintosh|mac os x/i.test(ua) || /^mac/i.test(plat)) {
    // iPadOS asks for the desktop site with a Mac user agent; it has a touch screen.
    os = touch > 1 ? 'unknown' : 'mac';
  } else if (/linux|x11/i.test(ua) || /linux/i.test(plat)) {
    os = 'linux';
  }

  let arch = null;
  if (hiArch) arch = hiArch.startsWith('arm') ? 'arm64' : (hiArch.startsWith('x86') ? 'x64' : null);
  else if (/\b(arm64|aarch64)\b/i.test(ua) || /arm|aarch64/i.test(plat)) arch = 'arm64';
  else if (/\b(x86_64|x64|win64|wow64|amd64)\b/i.test(ua)) arch = 'x64';
  // Every Mac reports "Intel Mac OS X" in its user agent, so the UA says nothing on a Mac.
  if (os === 'mac' && !hiArch) arch = null;
  return { os, arch };
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!(n > 0)) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function byPreference(os) {
  const order = PREFERRED_EXT[os] || [];
  return (f) => {
    const i = order.indexOf(ext(f.name));
    return i < 0 ? 99 : i;
  };
}

/**
 * Pick the file for a platform. Returns null when there is nothing suitable (unknown OS,
 * or no file for it); the caller then links to the releases page instead.
 * Result: { file, os, osName, label, meta, note }.
 */
export function pickDownload(normalized, platform) {
  const files = (normalized && normalized.files) || [];
  const version = normalized && normalized.version;
  const { os, arch } = platform || {};
  if (!OS_NAMES[os]) return null;
  const rank = byPreference(os);
  const usable = files.filter((f) => f.os === os && rank(f) < 99).sort((a, b) => rank(a) - rank(b));
  if (!usable.length) return null;

  let file = null;
  let note = '';
  if (os === 'mac') {
    // One Mac build, Intel (x64). Apple silicon runs it under Rosetta.
    file = usable.find((f) => f.arch === 'x64') || usable[0];
    if (arch !== 'x64') note = APPLE_SILICON_NOTE;
  } else if (os === 'win') {
    const want = arch === 'arm64' ? 'arm64' : 'x64';
    file = usable.find((f) => f.arch === want) || null;
    if (!file && want === 'arm64') {
      file = usable.find((f) => f.arch === 'x64') || null;
      if (file) note = 'No Arm build in this release; the x64 build runs under Windows emulation.';
    }
  } else if (os === 'linux') {
    if (arch === 'arm64') file = usable.find((f) => f.arch === 'arm64') || null;
    else file = usable.find((f) => f.arch === 'x64') || null;
  }
  if (!file) return null;

  const osName = OS_NAMES[os];
  const archName = os === 'mac' ? 'Intel (x64)' : (file.arch === 'arm64' ? 'Arm64' : 'x64');
  const kind = { exe: 'Installer', dmg: 'Disk image', appimage: 'AppImage' }[ext(file.name)] || ext(file.name);
  const meta = [kind, archName, formatSize(file.size)].filter(Boolean).join(' · ');
  const label = `Download OmniDesk${version ? ' ' + version : ''} for ${osName}`;
  return { file, os, osName, label, meta, note };
}

/** Rows for the "all files" table, in a stable order. */
export function fileRows(normalized) {
  const order = { win: 0, mac: 1, linux: 2 };
  const files = ((normalized && normalized.files) || []).filter((f) => byPreference(f.os)(f) < 99 || ext(f.name) === 'zip');
  return files.slice().sort((a, b) => (order[a.os] - order[b.os]) || (a.arch === 'x64' ? -1 : 1) - (b.arch === 'x64' ? -1 : 1))
    .map((f) => ({ ...f, osName: OS_NAMES[f.os], archName: f.os === 'mac' ? 'Intel (x64)' : (f.arch === 'arm64' ? 'Arm64' : 'x64'), sizeText: formatSize(f.size) }));
}
