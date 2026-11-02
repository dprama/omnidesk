// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Engine file locations. These mirror engine/src/lib/common/Settings.{h,cpp}
// and Constants.h.in and are on docs/DO-NOT-RENAME.md: they are derived from
// kAppName "Deskflow" / kAppId "deskflow", never from "OmniDesk".

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'Deskflow'; // kAppName
const APP_ID = 'deskflow'; // kAppId
const CORE_IPC_NAME = 'deskflow-core'; // kCoreIpcName

function exeName(platform = process.platform) {
  return platform === 'win32' ? 'deskflow-core.exe' : 'deskflow-core';
}

// QLocalServer naming: Windows named pipe; elsewhere QDir::tempPath()/<name>.
function coreIpcPath(platform = process.platform, env = process.env) {
  if (platform === 'win32') return `\\\\.\\pipe\\${CORE_IPC_NAME}`;
  const tmp = (env.TMPDIR || os.tmpdir() || '/tmp').replace(/\/+$/, '') || '/tmp';
  return path.posix.join(tmp, CORE_IPC_NAME);
}

// Settings::Settings() load order: (Win) portable, (mac/linux) $XDG_CONFIG_HOME,
// then user file, then system file, else user file.
function engineSettingsFile({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let userDir;
  let systemDir;
  if (platform === 'win32') {
    userDir = P.join(home, 'AppData', 'Roaming', APP_NAME);
    systemDir = P.join((env.SystemDrive || 'C:') + '\\', 'ProgramData', APP_NAME);
  } else if (platform === 'darwin') {
    userDir = P.join(home, 'Library', APP_NAME);
    systemDir = P.join('/Library', APP_NAME);
  } else {
    userDir = P.join(home, '.config', APP_NAME);
    systemDir = P.join('/etc', APP_NAME);
  }
  const userFile = P.join(userDir, `${APP_NAME}.conf`);
  const systemFile = P.join(systemDir, `${APP_NAME}.conf`);
  if (platform !== 'win32' && env.XDG_CONFIG_HOME) return P.join(env.XDG_CONFIG_HOME, APP_NAME, `${APP_NAME}.conf`);
  if (exists(userFile)) return userFile;
  if (exists(systemFile)) return systemFile;
  return userFile;
}

// settingsPath(): Windows (non-portable) → C:\ProgramData\Deskflow, else the
// settings file's folder. tls/ lives under it.
function engineSettingsDir(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    const env = opts.env || process.env;
    return path.win32.join((env.SystemDrive || 'C:') + '\\', 'ProgramData', APP_NAME);
  }
  return path.posix.dirname(engineSettingsFile(opts));
}

function enginePaths(opts = {}) {
  const platform = opts.platform || process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const settingsFile = engineSettingsFile(opts);
  const settingsDir = engineSettingsDir(opts);
  const tlsDir = P.join(settingsDir, 'tls');
  return {
    settingsFile,
    settingsDir,
    tlsDir,
    certificate: P.join(tlsDir, `${APP_ID}.pem`),
    trustedServers: P.join(tlsDir, 'trusted-servers'),
    trustedClients: P.join(tlsDir, 'trusted-clients'),
    ipcPath: coreIpcPath(platform, opts.env || process.env),
  };
}

// Where the deskflow-core binary lives. Packaged: <resources>/engine/.
// Dev: engine/build/bin/, then engine-dist/<os>-<arch>/.
function findEngineBinary({ packaged, resourcesPath, repoRoot, platform = process.platform, arch = process.arch, exists = fs.existsSync }) {
  const exe = exeName(platform);
  const osName = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform] || platform;
  const candidates = packaged
    ? [path.join(resourcesPath, 'engine', exe)]
    : [
        path.join(repoRoot, 'engine', 'build', 'bin', exe),
        path.join(repoRoot, 'engine', 'build', 'bin', 'Deskflow.app', 'Contents', 'MacOS', exe),
        path.join(repoRoot, 'engine-dist', `${osName}-${arch}`, exe),
      ];
  for (const c of candidates) if (exists(c)) return { path: path.resolve(c), searched: candidates };
  return { path: null, searched: candidates };
}

// Settings::cleanComputerName
function cleanComputerName(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim().replace(/ /g, '_').replace(/[^\w.-]/g, '');
  s = s.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  return s.slice(0, 255);
}

module.exports = {
  APP_NAME, APP_ID, CORE_IPC_NAME, exeName, coreIpcPath, engineSettingsFile, engineSettingsDir,
  enginePaths, findEngineBinary, cleanComputerName,
};
