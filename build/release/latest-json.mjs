#!/usr/bin/env node
// Writes latest.json for the website's Download button.
//
//   node build/release/latest-json.mjs --dir release-files --tag v2.5.0 --repo dprama/omnidesk [--out latest.json]
//
// Shape: { version, files: [{ os, arch, name, url, size, sha256 }] }
//   os   = win | mac | linux
//   arch = x64 | arm64
// File names are the canonical ones the release workflow gives the installers:
//   OmniDesk-<version>-<os>-<arch>.<exe|dmg|AppImage>

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ['dir', 'tag', 'repo']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }

const version = args.tag.replace(/^v/, '');
const pattern = /^OmniDesk-(.+)-(win|mac|linux)-(x64|arm64)\.(exe|dmg|AppImage)$/;
const files = [];
for (const name of readdirSync(args.dir).sort()) {
  const m = name.match(pattern);
  if (!m) continue;
  if (m[1] !== version) { console.error(`${name}: version ${m[1]} does not match tag ${args.tag}`); process.exit(1); }
  const path = join(args.dir, name);
  const buf = readFileSync(path);
  files.push({
    os: m[2],
    arch: m[3],
    name,
    url: `https://github.com/${args.repo}/releases/download/${encodeURIComponent(args.tag)}/${encodeURIComponent(name)}`,
    size: statSync(path).size,
    sha256: createHash('sha256').update(buf).digest('hex'),
  });
}
if (!files.length) { console.error(`no installers matching ${pattern} in ${args.dir}`); process.exit(1); }

const out = args.out || join(args.dir, 'latest.json');
writeFileSync(out, JSON.stringify({ version, files }, null, 2) + '\n');
console.log(readFileSync(out, 'utf8'));
