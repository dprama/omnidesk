// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Points every [data-dl] button at the right file from the latest GitHub release.
// Without JavaScript, or when the API can't be reached, the buttons keep their HTML
// default: the releases page on GitHub.
//
// pick.js prefers a release's latest.json, but the browser never downloads it: release
// files redirect to githubusercontent.com, which this page's CSP (connect-src
// api.github.com only) blocks on purpose. The API's own asset list carries the same
// names, sizes and SHA-256 digests, so the page matches asset names instead.
import { API_URL, RELEASES_URL, normalizeRelease, detectPlatform, pickDownload, fileRows } from './pick.js';

const CACHE_KEY = 'omnidesk.release.v1';
const CACHE_MS = 10 * 60 * 1000;

const $$ = (s) => Array.from(document.querySelectorAll(s));

async function platformHints() {
  const nav = navigator;
  const hints = { userAgent: nav.userAgent || '', platform: nav.platform || '', maxTouchPoints: nav.maxTouchPoints || 0 };
  const uad = nav.userAgentData;
  if (uad && typeof uad.getHighEntropyValues === 'function') {
    try {
      const v = await uad.getHighEntropyValues(['architecture', 'bitness', 'platform']);
      hints.uaPlatform = v.platform || uad.platform || '';
      hints.architecture = v.architecture || '';
      hints.bitness = v.bitness || '';
    } catch {
      hints.uaPlatform = uad.platform || '';
    }
  }
  return hints;
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && Date.now() - c.t < CACHE_MS ? c.release : null;
  } catch { return null; }
}
function writeCache(release) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), release })); } catch { /* private mode */ }
}

async function fetchRelease() {
  const cached = readCache();
  if (cached) return cached;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache', signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();
    // Keep only what we use, so the cache stays small.
    const slim = {
      tag_name: release.tag_name, html_url: release.html_url,
      assets: (release.assets || []).map((a) => ({ name: a.name, size: a.size, digest: a.digest, browser_download_url: a.browser_download_url })),
    };
    writeCache(slim);
    return slim;
  } finally {
    clearTimeout(timer);
  }
}

function setText(sel, text) {
  for (const el of $$(sel)) { el.textContent = text; el.hidden = !text; }
}

function showFallback() {
  for (const a of $$('[data-dl]')) a.href = RELEASES_URL;
  setText('[data-dl-meta]', 'Opens the latest release on GitHub. Pick the file for your computer there.');
  setText('[data-dl-note]', '');
  document.documentElement.dataset.dlState = 'fallback';
}

function fillTable(normalized) {
  const body = document.querySelector('[data-dl-files]');
  if (!body) return;
  const rows = fileRows(normalized);
  if (!rows.length) return;
  body.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    const td = (text, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = text; return c; };
    const link = document.createElement('a');
    link.href = r.url; link.textContent = r.name; link.className = 'fname';
    const name = document.createElement('td'); name.append(link);
    const sha = td(r.sha256 ? r.sha256 : 'listed on the release page', 'sha');
    if (r.sha256) sha.title = 'SHA-256';
    tr.append(td(r.osName), td(r.archName), name, td(r.sizeText || '', 'num'), sha);
    return tr;
  }));
  const ver = document.querySelector('[data-dl-version]');
  if (ver && normalized.version) ver.textContent = normalized.version;
}

async function main() {
  if (!document.querySelector('[data-dl]')) return;
  const hintsP = platformHints();
  let normalized;
  try {
    const release = await fetchRelease();
    normalized = normalizeRelease(release);
    if (release.html_url && /^https:\/\/github\.com\//.test(release.html_url)) {
      for (const a of $$('[data-dl-release]')) a.href = release.html_url;
    }
  } catch {
    showFallback();
    return;
  }
  fillTable(normalized);
  const pick = pickDownload(normalized, detectPlatform(await hintsP));
  if (!pick) {
    // Unknown OS (phone, tablet, Chromebook) or no file for it: send people to the list.
    for (const a of $$('[data-dl]')) a.href = a.dataset.dlAll || 'download.html#files';
    setText('[data-dl-label]', `Download OmniDesk${normalized.version ? ' ' + normalized.version : ''}`);
    setText('[data-dl-meta]', 'For Windows, macOS and Linux. Choose your file.');
    setText('[data-dl-note]', '');
    document.documentElement.dataset.dlState = 'list';
    return;
  }
  for (const a of $$('[data-dl]')) a.href = pick.file.url;
  setText('[data-dl-label]', pick.label);
  setText('[data-dl-meta]', pick.meta);
  setText('[data-dl-note]', pick.note);
  document.documentElement.dataset.dlState = pick.os;
}

main();
