// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// node --test site/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeRelease, detectPlatform, pickDownload, parseAssetName, formatSize, fileRows,
  latestJsonAsset, APPLE_SILICON_NOTE,
} from '../js/pick.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const release = fixture('release.json');
const latest = fixture('latest.json');
const byNames = normalizeRelease(release);
const byLatest = normalizeRelease(release, latest);

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
};

test('fixture: asset names and latest.json give the same four files', () => {
  assert.equal(byNames.version, '2.5.0');
  assert.equal(byLatest.version, '2.5.0');
  const key = (r) => r.files.map((f) => `${f.os}-${f.arch}:${f.name}:${f.size}:${f.sha256}`).sort();
  assert.deepEqual(key(byNames), key(byLatest));
  assert.equal(byNames.files.length, 4, 'blockmaps, latest.yml, latest.json and SHA256SUMS are skipped');
  assert.ok(latestJsonAsset(release));
});

test('Windows x64 (userAgentData)', () => {
  const p = detectPlatform({ uaPlatform: 'Windows', architecture: 'x86', bitness: '64', userAgent: UA.winChrome });
  assert.deepEqual(p, { os: 'win', arch: 'x64' });
  const r = pickDownload(byNames, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-win-x64.exe');
  assert.equal(r.label, 'Download OmniDesk 2.5.0 for Windows');
  assert.equal(r.meta, 'Installer · x64 · 98.4 MB');
  assert.equal(r.note, '');
  assert.match(r.file.url, /^https:\/\/github\.com\/dprama\/omnidesk\/releases\/download\/v2\.5\.0\//);
});

test('Windows x64 (user agent only, Firefox)', () => {
  const p = detectPlatform({ userAgent: UA.winFirefox, platform: 'Win32' });
  assert.deepEqual(p, { os: 'win', arch: 'x64' });
  assert.equal(pickDownload(byLatest, p).file.name, 'OmniDesk-2.5.0-win-x64.exe');
});

test('Windows arm64', () => {
  const p = detectPlatform({ uaPlatform: 'Windows', architecture: 'arm', bitness: '64', userAgent: UA.winChrome });
  assert.deepEqual(p, { os: 'win', arch: 'arm64' });
  const r = pickDownload(byNames, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-win-arm64.exe');
  assert.equal(r.meta, 'Installer · Arm64 · 95.2 MB');
});

test('Windows arm64 falls back to x64 when the release has no Arm build', () => {
  const noArm = { ...byNames, files: byNames.files.filter((f) => f.arch !== 'arm64') };
  const r = pickDownload(noArm, { os: 'win', arch: 'arm64' });
  assert.equal(r.file.name, 'OmniDesk-2.5.0-win-x64.exe');
  assert.match(r.note, /emulation/);
});

test('Intel Mac', () => {
  const p = detectPlatform({ uaPlatform: 'macOS', architecture: 'x86', bitness: '64', userAgent: UA.macChrome });
  assert.deepEqual(p, { os: 'mac', arch: 'x64' });
  const r = pickDownload(byNames, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-mac-x64.dmg');
  assert.equal(r.label, 'Download OmniDesk 2.5.0 for macOS');
  assert.equal(r.meta, 'Disk image · Intel (x64) · 112 MB');
  assert.equal(r.note, '');
});

test('Apple silicon Mac gets the Intel build plus the Rosetta note', () => {
  const p = detectPlatform({ uaPlatform: 'macOS', architecture: 'arm', bitness: '64', userAgent: UA.macChrome });
  assert.deepEqual(p, { os: 'mac', arch: 'arm64' });
  const r = pickDownload(byLatest, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-mac-x64.dmg');
  assert.equal(r.note, APPLE_SILICON_NOTE);
});

test('Mac on Safari (architecture unknown) still gets the dmg and the note', () => {
  const p = detectPlatform({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 });
  assert.deepEqual(p, { os: 'mac', arch: null });
  const r = pickDownload(byNames, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-mac-x64.dmg');
  assert.equal(r.note, APPLE_SILICON_NOTE);
});

test('Linux gets the AppImage', () => {
  const p = detectPlatform({ userAgent: UA.linux, platform: 'Linux x86_64' });
  assert.deepEqual(p, { os: 'linux', arch: 'x64' });
  const r = pickDownload(byNames, p);
  assert.equal(r.file.name, 'OmniDesk-2.5.0-linux-x64.AppImage');
  assert.equal(r.label, 'Download OmniDesk 2.5.0 for Linux');
  assert.equal(r.meta, 'AppImage · x64 · 121 MB');
});

test('unknown platforms get no pick (caller links to the releases page)', () => {
  for (const hints of [
    { userAgent: UA.android, platform: 'Linux armv8l' },
    { uaPlatform: 'Android', architecture: 'arm', userAgent: UA.android },
    { uaPlatform: 'Chrome OS', architecture: 'x86', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' },
    { userAgent: UA.iphone, platform: 'iPhone' },
    { userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }, // iPad asking for desktop site
    {},
  ]) {
    const p = detectPlatform(hints);
    assert.equal(p.os, 'unknown', JSON.stringify(hints));
    assert.equal(pickDownload(byNames, p), null);
  }
});

test('missing asset: no pick, and nothing throws on empty or odd releases', () => {
  const noMac = { ...byNames, files: byNames.files.filter((f) => f.os !== 'mac') };
  assert.equal(pickDownload(noMac, { os: 'mac', arch: 'x64' }), null);
  assert.equal(pickDownload(byNames, { os: 'linux', arch: 'arm64' }), null, 'no Linux Arm build');
  assert.deepEqual(normalizeRelease({ tag_name: 'v2.5.0', assets: [] }), { version: '2.5.0', files: [] });
  assert.deepEqual(normalizeRelease(null), { version: null, files: [] });
  assert.equal(pickDownload(normalizeRelease({}), { os: 'win', arch: 'x64' }), null);
  // A broken latest.json is ignored in favour of the asset names.
  assert.equal(normalizeRelease(release, { files: [{ os: 'win', name: 'x' }] }).files.length, 4);
});

test('helpers', () => {
  assert.deepEqual(parseAssetName('OmniDesk-2.5.0-win-arm64.exe'), { version: '2.5.0', os: 'win', arch: 'arm64', ext: 'exe' });
  assert.equal(parseAssetName('OmniDesk-2.5.0-win-x64.exe.blockmap'), null);
  assert.equal(parseAssetName('latest.json'), null);
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(2400 * 1024), '2.3 MB');
  assert.equal(formatSize(500 * 1024), '500 KB');
  assert.deepEqual(fileRows(byNames).map((r) => `${r.os}-${r.arch}`), ['win-x64', 'win-arm64', 'mac-x64', 'linux-x64']);
});
