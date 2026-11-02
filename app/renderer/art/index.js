// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only

// OmniDesk art: a monochrome device kit and one calm scene per feature.
//
//   device(kind, { size, accent, state }) -> SVGSVGElement
//     kind: 'windows-pc' | 'windows-pc-2' | 'macbook' | 'mac-mini'
//     state: 'online' | 'offline' | 'active'   size: px width (number) or CSS width (string)
//
//   scene(name, host, { accent, reducedMotion }) -> { update(data), stop() }
//     Fills `host` (sized by ResizeObserver), pauses when hidden/off-screen,
//     draws one still frame with reducedMotion. stop() cancels everything and removes the SVG.
//
// No inline styles in markup: colors are set through CSSOM (style.setProperty) so the
// app's CSP (style-src 'self') is respected.

import { device as kitDevice } from './kit.js';
import { runScene } from './engine.js';
import desk from './scenes/desk.js';
import radar from './scenes/radar.js';
import screenMap from './scenes/screen-map.js';
import clipboardHop from './scenes/clipboard-hop.js';
import displaySlide from './scenes/display-slide.js';
import cameraWatch from './scenes/camera-watch.js';
import multiDesk from './scenes/multi-desk.js';
import tipJar from './scenes/tip-jar.js';
import feedbackNote from './scenes/feedback-note.js';
import aboutCredits from './scenes/about-credits.js';

const SCENES = {
  desk,
  radar,
  'screen-map': screenMap,
  'clipboard-hop': clipboardHop,
  'display-slide': displaySlide,
  'camera-watch': cameraWatch,
  'multi-desk': multiDesk,
  'tip-jar': tipJar,
  'feedback-note': feedbackNote,
  'about-credits': aboutCredits,
};

export function device(kind, opts = {}) {
  return kitDevice(kind, opts || {});
}

export function scene(name, host, opts = {}) {
  const def = SCENES[name];
  if (!def) throw new TypeError(`Unknown scene "${name}". Known: ${Object.keys(SCENES).join(', ')}`);
  if (!host || typeof host.appendChild !== 'function') throw new TypeError('scene() needs a host element');
  return runScene(host, opts || {}, def);
}
