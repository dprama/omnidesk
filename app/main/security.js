// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// app://omnidesk/ protocol, CSP, navigation/window.open blocking, permissions.

const fs = require('node:fs');
const path = require('node:path');

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'";

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm', '.mp4': 'video/mp4',
};

// Shown when app/renderer/index.html does not exist yet. No inline script/style.
const PLACEHOLDER = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OmniDesk</title></head>'
  + '<body><h1>OmniDesk</h1><p>The interface is still being built.</p></body></html>';

function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
}

// Resolve app://omnidesk/<p> inside root; null if outside or bad host.
function resolveAppUrl(root, requestUrl) {
  let u;
  try { u = new URL(requestUrl); } catch { return null; }
  if (u.protocol !== 'app:' || u.host !== 'omnidesk') return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(root, '.' + path.posix.normalize(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function handleProtocol(protocol, root) {
  const resolvedRoot = path.resolve(root);
  protocol.handle('app', async (request) => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    const file = resolveAppUrl(resolvedRoot, request.url);
    if (!file) return new Response('Not found', { status: 404, headers });
    try {
      const data = await fs.promises.readFile(file);
      headers['Content-Type'] = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers });
    } catch {
      if (file === path.join(resolvedRoot, 'index.html')) {
        headers['Content-Type'] = MIME['.html'];
        return new Response(PLACEHOLDER, { status: 200, headers });
      }
      return new Response('Not found', { status: 404, headers });
    }
  });
}

// https only, host on the allowlist (exact host or a subdomain of it).
function isAllowedExternal(url, allowHosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return allowHosts.some((h) => host === h || host.endsWith('.' + h));
}

const MEDIA_PERMISSIONS = new Set(['media', 'display-capture', 'mediaKeySystem']);

function createSecurity({ app, session, shell, log, allowHosts }) {
  const mediaAllowed = new Set(); // webContents ids

  function allowMedia(webContents) {
    if (!webContents || typeof webContents.id !== 'number') return () => {};
    mediaAllowed.add(webContents.id);
    if (log) log(`media permission granted to webContents ${webContents.id}`);
    webContents.once('destroyed', () => mediaAllowed.delete(webContents.id));
    return () => mediaAllowed.delete(webContents.id);
  }

  function isAppUrl(url) {
    try { const u = new URL(url); return u.protocol === 'app:' && u.host === 'omnidesk'; } catch { return false; }
  }

  function decide(wc, permission, requestingUrl) {
    return !!wc && mediaAllowed.has(wc.id) && MEDIA_PERMISSIONS.has(permission) && isAppUrl(requestingUrl || wc.getURL());
  }

  function hardenSession(ses) {
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const ok = decide(wc, permission, details && details.requestingUrl);
      if (!ok && log) log(`permission denied: ${permission}`);
      cb(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => decide(wc, permission, requestingOrigin && `${requestingOrigin}/`));
    if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
  }

  function openExternal(url) {
    if (!isAllowedExternal(url, allowHosts())) return false;
    shell.openExternal(url);
    return true;
  }

  function hardenContents(contents) {
    contents.on('will-navigate', (e, url) => { e.preventDefault(); if (log) log(`navigation blocked: ${String(url).slice(0, 200)}`); });
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (!openExternal(url) && log) log(`window.open blocked: ${String(url).slice(0, 200)}`);
      return { action: 'deny' };
    });
  }

  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  hardenSession(session.defaultSession);

  return { allowMedia, openExternal, isAllowedExternal: (u) => isAllowedExternal(u, allowHosts()), hardenSession };
}

module.exports = { CSP, registerScheme, handleProtocol, resolveAppUrl, isAllowedExternal, createSecurity };
