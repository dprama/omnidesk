// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Downloads the pinned, SignPath-signed Virtual Display Driver release asset
// (github.com/VirtualDrivers/Virtual-Display-Driver, MIT), checks its SHA-256,
// extracts it and checks every extracted file's SHA-256 too.
//
//   node native/windows-vdd/fetch.mjs [outDir]     default: native/windows-vdd/dist
//
// The binaries are never committed. CI runs this before electron-builder and
// ships <outDir>/VirtualDisplayDriver as extraResources "vdd".
//
// Note: upstream names the amd64 package "x86" (its .inf targets NTamd64).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIN = Object.freeze({
  version: '25.7.23',
  asset: 'VirtualDisplayDriver-x86.Driver.Only.zip',
  url: 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip',
  sha256: 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a',
  folder: 'VirtualDisplayDriver',
  files: {
    'MttVDD.dll': 'c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05',
    'MttVDD.inf': '550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d',
    'mttvdd.cat': '08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6',
    'vdd_settings.xml': 'edb2501d6d5da17f66d15d4b97a6f4a3f0d8963165ac4a6a6259d95118288020',
  },
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(process.argv[2] || path.join(here, 'dist'));
  await mkdir(out, { recursive: true });
  const zipPath = path.join(out, PIN.asset);

  let buf = null;
  try { buf = await readFile(zipPath); if (sha256(buf) !== PIN.sha256) buf = null; } catch { /* download */ }
  if (!buf) {
    console.log(`downloading ${PIN.url}`);
    const res = await fetch(PIN.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== PIN.sha256) throw new Error(`SHA-256 mismatch for ${PIN.asset}: expected ${PIN.sha256}, got ${got}`);
    await writeFile(zipPath, buf);
  }
  console.log(`ok ${PIN.asset} sha256=${PIN.sha256}`);

  const dest = path.join(out, PIN.folder);
  await rm(dest, { recursive: true, force: true });
  // bsdtar (Windows 10+, macOS, most Linux) extracts zip files. On Windows use System32's
  // bsdtar by full path: Git Bash's GNU tar comes first on PATH, reads "D:\..." as a remote host
  // and can't open zips anyway.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zipPath, '-C', out], { stdio: 'inherit' });

  const present = new Set(await readdir(dest));
  for (const [name, want] of Object.entries(PIN.files)) {
    if (!present.has(name)) throw new Error(`missing ${name} in ${PIN.asset}`);
    const got = sha256(await readFile(path.join(dest, name)));
    if (got !== want) throw new Error(`SHA-256 mismatch for ${name}: expected ${want}, got ${got}`);
    present.delete(name);
  }
  if (present.size) throw new Error(`unexpected files in ${PIN.asset}: ${[...present].join(', ')}`);
  console.log(`ok extracted to ${dest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
