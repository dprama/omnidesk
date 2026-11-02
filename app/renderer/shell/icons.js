// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Stroke icons (24x24) shared by the shell. Pages may import { icon } from '../shell/icons.js'.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICONS = {
  home: '<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  mouse: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v3"/>',
  layout: '<rect x="3" y="6" width="10" height="8" rx="1.5"/><rect x="13" y="8" width="8" height="6" rx="1.5"/><path d="M6 18h12"/>',
  clipboard: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 3.5h5v3h-5z"/><path d="M9 12h6M9 15.5h4"/>',
  screen: '<rect x="2.5" y="5" width="12" height="9" rx="1.5"/><path d="M14.5 8.5h6a1 1 0 0 1 1 1V16H11"/><path d="M8 18h14"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2.5"/><path d="M16 11l5-3v8l-5-3"/>',
  connection: '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="12" r="1.2"/><path d="M12 13.5V20"/>',
  devices: '<rect x="2.5" y="5" width="8.5" height="6.5" rx="1.2"/><rect x="13" y="5" width="8.5" height="6.5" rx="1.2"/><rect x="8" y="14" width="8" height="5.5" rx="1.2"/>',
  tip: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  feedback: '<path d="M4 5h16v11H9.5L4 20z"/><path d="M8 9.5h8M8 12.5h5"/>',
  about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  text: '<path d="M5 6h14M5 10.5h14M5 15h9"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".6"/>',
  usb: '<path d="M12 3v14M9 6l3-3 3 3M8 10v2l4 3M16 9v3l-4 3"/><circle cx="12" cy="19" r="1.8"/>',
  bluetooth: '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  ethernet: '<rect x="5" y="5" width="14" height="11" rx="1.5"/><path d="M9 16v3h6v-3M9 9v3M12 9v3M15 9v3"/>',
  power: '<path d="M12 3v8"/><path d="M6.5 7a7.5 7.5 0 1 0 11 0"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
};

/** Returns an <svg> element for the named icon (aria-hidden). */
export function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export const LINK_LABELS = { ethernet: 'Ethernet', wifi: 'Wi-Fi', usb: 'USB cable', bluetooth: 'Bluetooth' };
