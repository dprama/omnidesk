// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// The page registry: what the shell knows about each page before its module loads.
// A loaded page module's own label/tab/accent/icon take precedence for its sheet.

export const PAGES = [
  { id: 'home', label: 'Home', tab: 'Home', group: 'home', accent: 'var(--c-home)', icon: 'home' },
  { id: 'mouse', label: 'Mouse & keyboard', tab: 'Mouse', group: 'share', accent: 'var(--c-mouse)', icon: 'mouse' },
  { id: 'layout', label: 'Screen layout', tab: 'Layout', group: 'share', accent: 'var(--c-layout)', icon: 'layout' },
  { id: 'clipboard', label: 'Clipboard', tab: 'Clipboard', group: 'share', accent: 'var(--c-clip)', icon: 'clipboard' },
  { id: 'screen', label: 'Second screen', tab: 'Screen', group: 'share', accent: 'var(--c-screen)', icon: 'screen' },
  { id: 'camera', label: 'Camera', tab: 'Camera', group: 'share', accent: 'var(--c-cam)', icon: 'camera' },
  { id: 'connection', label: 'Connection', tab: 'Connection', group: 'devices', accent: 'var(--c-conn)', icon: 'connection' },
  { id: 'devices', label: 'Multi-device', tab: 'Devices', group: 'devices', accent: 'var(--c-multi)', icon: 'devices' },
  { id: 'tip', label: 'Tip', tab: 'Tip', group: 'more', accent: 'var(--c-tip)', icon: 'tip' },
  { id: 'feedback', label: 'Feedback', tab: 'Feedback', group: 'more', accent: 'var(--c-fb)', icon: 'feedback' },
  { id: 'about', label: 'About', tab: 'About', group: 'more', accent: 'var(--c-about)', icon: 'about' }
];

export const GROUPS = [
  { id: 'home', title: '' },
  { id: 'share', title: 'Share' },
  { id: 'devices', title: 'Devices' },
  { id: 'more', title: 'More' }
];

export const page = (id) => PAGES.find((p) => p.id === id) || null;
