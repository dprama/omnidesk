// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Zero-dependency static server for the test window.
//   /        -> app/renderer/ (or --root <dir>)
//   /mock/   -> app/mock/
// index.html gets the mock script injected before its first module script, and every
// response carries the app's CSP. Listens on 127.0.0.1, random free port.
// CLI: node app/test/serve.mjs [--root <dir>] [--port <n>]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const RENDERER_DIR = resolve(HERE, '../renderer');
export const MOCK_DIR = resolve(HERE, '../mock');
export const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'";
const MOCK_TAG = '<script src="/mock/omnidesk-mock.js"></script>';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

export function injectMock(html) {
  const m = html.match(/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>/i);
  if (m) return html.slice(0, m.index) + MOCK_TAG + '\n' + html.slice(m.index);
  return html.includes('</head>') ? html.replace('</head>', MOCK_TAG + '\n</head>') : MOCK_TAG + '\n' + html;
}

function safeJoin(base, rel) {
  const p = resolve(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

export function startServer({ root = RENDERER_DIR, port = 0 } = {}) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    const headers = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let base = root;
      if (path.startsWith('/mock/')) { base = MOCK_DIR; path = path.slice('/mock'.length); }
      if (path.endsWith('/')) path += 'index.html';
      const file = safeJoin(base, path);
      if (!file) { res.writeHead(403, headers).end('Forbidden'); return; }
      let st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        if (path === '/favicon.ico') { res.writeHead(204, headers).end(); return; }
        res.writeHead(404, headers).end('Not found'); return;
      }
      let body = await readFile(file);
      if (base === root && path === '/index.html') body = Buffer.from(injectMock(body.toString('utf8')));
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(500, headers).end(String(e && e.message));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      ok({ server, port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const { url } = await startServer({ root: opt('--root') || RENDERER_DIR, port: Number(opt('--port') || 0) });
  console.log(`OmniDesk test server: ${url}/#home  (mock: ${url}/mock/omnidesk-mock.js)`);
}
