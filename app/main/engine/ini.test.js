// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ini = require('./ini');
const { enginePaths, coreIpcPath, cleanComputerName, findEngineBinary } = require('./paths');

test('ini update merges, keeps unknown keys, removes groups', () => {
  const src = '[security]\ncertificate=/x/tls/deskflow.pem\n\n[computer_Old]\nname=Old\n\n[core]\nport=24800\n';
  const out = ini.update(src, { 'core/coreMode': 2, 'server/enableClipboard': true, 'computer_New/name': 'New', 'server/externalConfigFile': 'C:/a b/c,d.conf' }, { removeGroups: (g) => g === 'computer_Old' });
  assert.equal(ini.get(out, 'security/certificate'), '/x/tls/deskflow.pem');
  assert.equal(ini.get(out, 'core/port'), '24800');
  assert.equal(ini.get(out, 'core/coreMode'), '2');
  assert.equal(ini.get(out, 'server/enableClipboard'), 'true');
  assert.equal(ini.get(out, 'computer_New/name'), 'New');
  assert.equal(ini.get(out, 'computer_Old/name'), undefined);
  assert.equal(ini.get(out, 'server/externalConfigFile'), 'C:/a b/c,d.conf');
  assert.match(out, /externalConfigFile="C:\/a b\/c,d.conf"/);
});

test('engine paths follow kAppName Deskflow, never OmniDesk', () => {
  const mac = enginePaths({ platform: 'darwin', env: {}, home: '/Users/u', exists: () => false });
  assert.equal(mac.settingsFile, '/Users/u/Library/Deskflow/Deskflow.conf');
  assert.equal(mac.trustedClients, '/Users/u/Library/Deskflow/tls/trusted-clients');
  assert.equal(mac.certificate, '/Users/u/Library/Deskflow/tls/deskflow.pem');
  const win = enginePaths({ platform: 'win32', env: {}, home: 'C:\\Users\\u', exists: () => false });
  assert.equal(win.settingsFile, 'C:\\Users\\u\\AppData\\Roaming\\Deskflow\\Deskflow.conf');
  assert.equal(win.tlsDir, 'C:\\ProgramData\\Deskflow\\tls');
  assert.equal(win.ipcPath, '\\\\.\\pipe\\deskflow-core');
  const lin = enginePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/c' }, home: '/home/u', exists: () => false });
  assert.equal(lin.settingsFile, '/c/Deskflow/Deskflow.conf');
  assert.equal(coreIpcPath('darwin', { TMPDIR: '/var/folders/x/T/' }), '/var/folders/x/T/deskflow-core');
  assert.equal(coreIpcPath('linux', {}), require('node:path').posix.join(require('node:os').tmpdir(), 'deskflow-core'));
});

test('cleanComputerName mirrors Settings::cleanComputerName', () => {
  assert.equal(cleanComputerName("Dp's MacBook Pro.local"), 'Dps_MacBook_Pro.local');
  assert.equal(cleanComputerName('-_PC-'), 'PC');
});

test('findEngineBinary prefers dev build then engine-dist', () => {
  const r = findEngineBinary({ packaged: false, repoRoot: '/r', platform: 'darwin', arch: 'x64', exists: (p) => p === '/r/engine-dist/mac-x64/deskflow-core' });
  assert.equal(r.path, '/r/engine-dist/mac-x64/deskflow-core');
  const p = findEngineBinary({ packaged: true, resourcesPath: '/res', platform: 'win32', exists: () => false });
  assert.equal(p.path, null);
});
