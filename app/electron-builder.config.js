// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// electron-builder configuration. Upload is done by CI (`gh release upload`),
// so publish is always 'never'. Icons and the dmg background come from
// build/ (owned by the ci/art agents).

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.omnidesk.desktop', // never change: macOS privacy grants attach to it
  productName: 'OmniDesk',
  copyright: 'Copyright (C) 2026 OmniDesk contributors. GPL-2.0-only.',
  publish: 'never',
  artifactName: 'OmniDesk-${version}-${os}-${arch}.${ext}',
  directories: { output: 'dist', buildResources: '../build' },
  asar: true,
  files: [
    'package.json',
    'main/**/*',
    'preload/**/*',
    '!**/*.test.js',
    '!main/**/INTERFACES.md',
    '!mock/**',
    '!test/**',
    '!**/shots/**',
  ],
  // Renderer is served from <resources>/renderer by the app:// protocol.
  // engine/: deskflow-core with its Qt runtime next to it, as laid out by
  // build/engine/deploy-{macos.sh,windows.ps1,linux.sh} (macOS: Frameworks/ +
  // plugin folders, rpath @executable_path/Frameworks; Windows: windeployqt DLLs).
  extraResources: [
    { from: 'renderer', to: 'renderer', filter: ['**/*', '!**/shots/**', '!**/*.test.js'] },
    { from: '../engine-dist/${os}-${arch}/', to: 'engine', filter: ['**/*'] },
    // GPL-2.0 text, licence texts and third-party notices travel with every build.
    { from: '..', to: 'licenses', filter: ['LICENSE', 'LICENSES/**', 'THIRD-PARTY-NOTICES.md'] },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: '../build/icons/icon.ico',
    // Virtual Display Driver (second screen): CI runs native/windows-vdd/fetch.mjs
    // first, which fills native/windows-vdd/dist/VirtualDisplayDriver (checked SHA-256).
    // build/installer.nsh runs vdd/install-vdd.ps1 elevated.
    extraResources: [
      { from: '../native/windows-vdd/dist/VirtualDisplayDriver', to: 'vdd/VirtualDisplayDriver', filter: ['**/*'] },
      { from: '../native/windows-vdd', to: 'vdd', filter: ['install-vdd.ps1', 'vdd-task.ps1', 'LICENSE-VirtualDisplayDriver.txt'] },
    ],
  },
  nsis: {
    oneClick: false,
    // Per-machine (elevated): the firewall rules and the display driver need admin.
    perMachine: true,
    include: 'installer.nsh', // build/installer.nsh (buildResources)
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'OmniDesk',
    uninstallDisplayName: 'OmniDesk',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['x64'] }], // Intel only (owner's decision 2026-11-01)
    category: 'public.app-category.productivity',
    icon: '../build/icons/icon.icns',
    hardenedRuntime: false,
    identity: null,
    extendInfo: {
      NSLocalNetworkUsageDescription: 'OmniDesk connects to your other computers on the local network.',
      NSBonjourServices: ['_omnidesk._tcp'],
      NSCameraUsageDescription: 'OmniDesk shares this Mac\u2019s camera with your other computers when you turn on camera sharing.',
      NSScreenCaptureUsageDescription: 'OmniDesk streams a screen to your other computer when you use it as a second screen.',
    },
    // Swift CGVirtualDisplay helper (x86_64), built in CI by
    // native/macos-virtual-display/build.sh. Found at <resources>/native/ by app/main/screen.
    extraResources: [
      { from: '../native/macos-virtual-display/dist', to: 'native', filter: ['omnidesk-virtual-display'] },
    ],
  },
  dmg: {
    background: '../build/dmg/background.png',
    title: 'OmniDesk ${version}',
    // Must match build/dmg/layout.json and the slots drawn in background.html
    window: { width: 660, height: 400 },
    iconSize: 112,
    contents: [
      { x: 180, y: 200, type: 'file' },
      { x: 480, y: 200, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Utility',
    icon: '../build/icons/png',
  },
};
