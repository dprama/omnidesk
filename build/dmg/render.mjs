#!/usr/bin/env node
// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
// Renders build/dmg/background.html to the dmg window backgrounds with headless Chrome.
//
//   node build/dmg/render.mjs
//
// Writes build/dmg/background.png (660x400) and build/dmg/background@2x.png (1320x800).
// electron-builder picks up the @2x file next to background.png for Retina.
// Network is disabled while rendering; fonts come from app/renderer/fonts or the system.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { launch, pngSize } from '../lib/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const layout = JSON.parse(readFileSync(join(here, 'layout.json'), 'utf8'));
const { width, height } = layout.window;
const url = pathToFileURL(join(here, 'background.html')).href;

const chrome = await launch();
try {
  for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const png = await chrome.screenshot({ url, width, height, scale, out: join(here, name) });
    const got = pngSize(png);
    if (got.width !== width * scale || got.height !== height * scale) {
      throw new Error(`${name}: expected ${width * scale}x${height * scale}, got ${got.width}x${got.height}`);
    }
    console.log(`${name} ${got.width}x${got.height}`);
  }
} finally {
  await chrome.close();
}
