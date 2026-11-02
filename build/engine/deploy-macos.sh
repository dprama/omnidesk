#!/usr/bin/env bash
# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
# Collects the macOS engine binary the app needs into one flat, relocatable folder:
#   deskflow-core            (OpenSSL is linked statically on macOS by the engine)
#   Frameworks/              Qt frameworks + any other non-system dylibs
#   platforms/, styles/, ... Qt plugins (found via the executable's own directory)
#
# macdeployqt only works on .app bundles, so we deploy into a throw-away bundle first,
# then flatten it and rewrite every @executable_path/../Frameworks reference to
# @executable_path/Frameworks. Everything is ad-hoc re-signed afterwards (unsigned build).
#
#   build/engine/deploy-macos.sh <build-dir> <out-dir>
set -euo pipefail

BUILD_DIR=$1
OUT_DIR=$2
BIN="$BUILD_DIR/bin/deskflow-core"
[ -x "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }

STAGE=$(mktemp -d)/DeskflowCore.app
mkdir -p "$STAGE/Contents/MacOS"
cp "$BIN" "$STAGE/Contents/MacOS/deskflow-core"
cat > "$STAGE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>deskflow-core</string>
  <key>CFBundleIdentifier</key><string>app.omnidesk.core-stage</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST

macdeployqt "$STAGE" -verbose=1 -always-overwrite

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$STAGE/Contents/MacOS/deskflow-core" "$OUT_DIR/"
if [ -d "$STAGE/Contents/Frameworks" ]; then cp -R "$STAGE/Contents/Frameworks" "$OUT_DIR/"; fi
if [ -d "$STAGE/Contents/PlugIns" ]; then
  # Qt also searches <applicationDirPath>/<plugin-type>/ so no qt.conf is needed.
  cp -R "$STAGE/Contents/PlugIns/." "$OUT_DIR/"
fi

# Drop what the core never uses (keeps the dmg small).
rm -rf "$OUT_DIR"/Frameworks/*.framework/Versions/*/Headers \
       "$OUT_DIR"/Frameworks/*.framework/Headers \
       "$OUT_DIR"/imageformats/libqpdf.dylib \
       "$OUT_DIR"/Frameworks/QtPdf.framework 2>/dev/null || true

# Collect every Mach-O file.
# (no mapfile: works with the bash 3.2 that ships with macOS too)
MACHO=()
while IFS= read -r f; do
  if file -b "$f" | grep -q 'Mach-O'; then MACHO+=("$f"); fi
done < <(find "$OUT_DIR" -type f \( -perm -u+x -o -name '*.dylib' \))

old='@executable_path/../Frameworks'
new='@executable_path/Frameworks'
for f in "${MACHO[@]}"; do
  chmod u+w "$f"
  # load commands
  # Qt from the online installer is universal: keep only x86_64 (this build is Intel-only).
  if lipo -archs "$f" 2>/dev/null | grep -q ' '; then lipo -thin x86_64 "$f" -output "$f.thin" && mv "$f.thin" "$f"; fi
  otool -L "$f" | awk '/^\t/{print $1}' | { grep "^$old/" || true; } | while read -r dep; do
    install_name_tool -change "$dep" "$new/${dep#"$old/"}" "$f"
  done
  # own install id
  id=$(otool -D "$f" | tail -n +2 | head -1 || true)
  if [[ "$id" == "$old/"* ]]; then install_name_tool -id "$new/${id#"$old/"}" "$f"; fi
  # rpaths
  otool -l "$f" | awk '/cmd LC_RPATH/{getline; getline; print $2}' | while read -r rp; do
    if [[ "$rp" == "$old"* ]]; then
      install_name_tool -rpath "$rp" "$new${rp#"$old"}" "$f"
    elif [[ "$rp" == /* ]]; then
      install_name_tool -delete_rpath "$rp" "$f"   # absolute build-machine paths
    fi
  done
done
if ! otool -l "$OUT_DIR/deskflow-core" | grep -F "path $new (" >/dev/null; then
  install_name_tool -add_rpath "$new" "$OUT_DIR/deskflow-core"
fi

# No reference may point outside the folder or the OS.
bad=0
for f in "${MACHO[@]}"; do
  self=$(otool -D "$f" | awk 'NR==2{print $1}')
  while read -r dep; do
    [ "$dep" = "$self" ] && continue    # a dylib's own install name is not a dependency
    case "$dep" in
      /System/*|/usr/lib/*|@rpath/*|@executable_path/Frameworks/*|@loader_path/*) ;;
      *) echo "bad reference in ${f#"$OUT_DIR/"}: $dep" >&2; bad=1 ;;
    esac
  done < <(otool -L "$f" | awk '/^\t/{print $1}')
done
[ "$bad" = 0 ] || exit 1

# install_name_tool invalidates signatures: re-sign ad-hoc, inside out.
for f in "${MACHO[@]}"; do
  if [ "$f" != "$OUT_DIR/deskflow-core" ]; then codesign --force --sign - "$f"; fi
done
for fw in "$OUT_DIR"/Frameworks/*.framework; do
  if [ -d "$fw" ]; then codesign --force --sign - "$fw"; fi
done
codesign --force --sign - "$OUT_DIR/deskflow-core"

file "$OUT_DIR/deskflow-core"
find "$OUT_DIR" -maxdepth 2 | sed "s|^$OUT_DIR/||" | sort
