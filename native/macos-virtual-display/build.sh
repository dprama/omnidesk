#!/bin/sh
# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
#
# Builds the x86_64 helper (the Mac target is Intel only).
#   ./build.sh [outdir]      default outdir: ./dist
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/dist"}
mkdir -p "$out"
xcrun swiftc \
  -O \
  -target x86_64-apple-macos11.0 \
  -import-objc-header "$here/Sources/CGVirtualDisplayPrivate.h" \
  -framework CoreGraphics -framework Foundation \
  -o "$out/omnidesk-virtual-display" \
  "$here/Sources/main.swift"
# Ad-hoc signature so the binary runs inside an unsigned app bundle.
codesign --force --sign - "$out/omnidesk-virtual-display" >/dev/null 2>&1 || true
file "$out/omnidesk-virtual-display"
