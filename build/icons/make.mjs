#!/usr/bin/env node
// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
// Generates the OmniDesk app icons from one SVG mark, with headless Chrome. No npm deps.
//
//   node build/icons/make.mjs
//
// Writes into build/icons/:
//   icon.svg               the master artwork
//   icon.png               1024x1024 (electron-builder default)
//   512x512.png            Linux
//   png/NxN.png            Linux icon set for electron-builder (16 ... 512)
//   icon.ico               16, 24, 32, 48, 64, 128, 256 (PNG-compressed entries, Windows Vista+)
//   icon.icns              macOS (only when `iconutil` exists, i.e. on macOS; otherwise the
//                          committed icon.icns is kept)
//
// The mark: two overlapping rounded screens (the back one outlined in the spectral gradient,
// the front one frosted glass) with a white cursor, on a dark glass tile.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, pngSize } from '../lib/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// `small` simplifies the art for 16-32 px: thicker strokes, no inner glow, larger mark.
function iconSvg({ small = false } = {}) {
  // macOS Big Sur grid: 824 px tile inside a 1024 canvas, corner radius ~185.
  // Small sizes use more of the canvas so the mark stays legible.
  const pad = small ? 24 : 100;
  const size = 1024 - pad * 2;
  const r = small ? 210 : 185;
  // Mark geometry (in 1024 space), derived from the 40x40 brand symbol, scaled ~x15.
  const k = small ? 17.2 : 14.2;
  const ox = 512 - 20 * k, oy = 512 - 20 * k;
  const X = (v) => (ox + v * k).toFixed(1);
  const Y = (v) => (oy + v * k).toFixed(1);
  const S = (v) => (v * k).toFixed(1);
  const backStroke = small ? 4.2 : 2.6;
  const frontStroke = small ? 2.6 : 1.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="spec" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5fd4e8"/>
      <stop offset=".35" stop-color="#a98bff"/>
      <stop offset=".65" stop-color="#f483a6"/>
      <stop offset="1" stop-color="#f2b860"/>
    </linearGradient>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1f2b"/>
      <stop offset="1" stop-color="#0b0d12"/>
    </linearGradient>
    <radialGradient id="glowA" cx=".28" cy=".26" r=".6">
      <stop offset="0" stop-color="#5fd4e8" stop-opacity=".42"/>
      <stop offset="1" stop-color="#5fd4e8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx=".78" cy=".74" r=".62">
      <stop offset="0" stop-color="#a98bff" stop-opacity=".40"/>
      <stop offset="1" stop-color="#a98bff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowC" cx=".82" cy=".18" r=".45">
      <stop offset="0" stop-color="#f483a6" stop-opacity=".22"/>
      <stop offset="1" stop-color="#f483a6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="front" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e6eaf2" stop-opacity=".30"/>
      <stop offset="1" stop-color="#d7dbe3" stop-opacity=".12"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".30"/>
      <stop offset=".5" stop-color="#ffffff" stop-opacity=".06"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity=".02"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${small ? 0 : 18}"/>
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="${small ? 0 : 14}" stdDeviation="${small ? 0 : 22}" flood-color="#000" flood-opacity="${small ? 0 : 0.45}"/>
    </filter>
    <clipPath id="clip"><rect x="${pad}" y="${pad}" width="${size}" height="${size}" rx="${r}"/></clipPath>
  </defs>
  <g filter="url(#shadow)">
    <rect x="${pad}" y="${pad}" width="${size}" height="${size}" rx="${r}" fill="url(#tile)"/>
  </g>
  <g clip-path="url(#clip)">
    ${small ? '' : `<rect x="${pad}" y="${pad}" width="${size}" height="${size}" fill="url(#glowA)"/>
    <rect x="${pad}" y="${pad}" width="${size}" height="${size}" fill="url(#glowB)"/>
    <rect x="${pad}" y="${pad}" width="${size}" height="${size}" fill="url(#glowC)"/>`}
    <!-- back screen: spectral outline, with a soft halo -->
    ${small ? '' : `<rect x="${X(4)}" y="${Y(7)}" width="${S(24)}" height="${S(19)}" rx="${S(5)}" fill="none" stroke="url(#spec)" stroke-width="${S(backStroke * 2.2)}" opacity=".55" filter="url(#soft)"/>`}
    <rect x="${X(4)}" y="${Y(7)}" width="${S(24)}" height="${S(19)}" rx="${S(5)}" fill="none" stroke="url(#spec)" stroke-width="${S(backStroke)}"/>
    <!-- front screen: frosted glass -->
    <rect x="${X(12)}" y="${Y(14)}" width="${S(24)}" height="${S(19)}" rx="${S(5)}" fill="#141824" fill-opacity=".72"/>
    <rect x="${X(12)}" y="${Y(14)}" width="${S(24)}" height="${S(19)}" rx="${S(5)}" fill="url(#front)" stroke="#ebeef4" stroke-opacity=".88" stroke-width="${S(frontStroke)}"/>
    <!-- cursor -->
    <g transform="translate(${X(0)} ${Y(0)}) scale(${k})">
      <path d="M20 19.5v8l2.3-2 1.8 3.6 1.5-.7-1.8-3.5h3z" fill="#f4f6fa" stroke="#0b0d12" stroke-opacity=".35" stroke-width="${small ? 0 : 0.35}" stroke-linejoin="round"/>
    </g>
    <!-- glass rim -->
    <rect x="${pad + 1.5}" y="${pad + 1.5}" width="${size - 3}" height="${size - 3}" rx="${r - 1.5}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  </g>
</svg>`;
}

const page = (svg, px) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${svg}`;

// ICO with PNG-compressed entries (valid since Windows Vista; accepted by electron-builder/NSIS).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

function hasIconutil() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('which', ['iconutil'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main() {
  const big = iconSvg();
  const small = iconSvg({ small: true });
  writeFileSync(join(here, 'icon.svg'), big + '\n');

  const chrome = await launch();
  const cache = new Map();
  const render = async (px) => {
    if (cache.has(px)) return cache.get(px);
    const svg = px <= 32 ? small : big;
    const png = await chrome.screenshot({ html: page(svg, px), width: px, height: px, transparent: true });
    const got = pngSize(png);
    if (got.width !== px || got.height !== px) throw new Error(`render ${px}: got ${got.width}x${got.height}`);
    cache.set(px, png);
    return png;
  };

  try {
    writeFileSync(join(here, 'icon.png'), await render(1024));
    writeFileSync(join(here, '512x512.png'), await render(512));
    mkdirSync(join(here, 'png'), { recursive: true });
    for (const px of [16, 32, 48, 64, 128, 256, 512]) {
      writeFileSync(join(here, 'png', `${px}x${px}.png`), await render(px));
    }
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const ico = buildIco(await Promise.all(icoSizes.map(async (size) => ({ size, png: await render(size) }))));
    writeFileSync(join(here, 'icon.ico'), ico);

    if (hasIconutil()) {
      const set = join(here, '.icon.iconset');
      rmSync(set, { recursive: true, force: true });
      mkdirSync(set);
      for (const base of [16, 32, 128, 256, 512]) {
        writeFileSync(join(set, `icon_${base}x${base}.png`), await render(base));
        writeFileSync(join(set, `icon_${base}x${base}@2x.png`), await render(base * 2));
      }
      execFileSync('iconutil', ['-c', 'icns', set, '-o', join(here, 'icon.icns')]);
      rmSync(set, { recursive: true, force: true });
      console.log('icon.icns written');
    } else if (!existsSync(join(here, 'icon.icns'))) {
      console.warn('iconutil not available and no committed icon.icns: run this script on macOS once.');
    } else {
      console.log('iconutil not available: keeping committed icon.icns');
    }
  } finally {
    await chrome.close();
  }
  console.log('icons written to', here);
}

main().catch((e) => { console.error(e); process.exit(1); });
