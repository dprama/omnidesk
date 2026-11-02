#!/usr/bin/env bash
# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
# Collects the Linux engine binary the app needs into one relocatable folder:
#   deskflow-core            RPATH=$ORIGIN/lib
#   lib/                     Qt, ICU, OpenSSL, libei, libportal, xkb, xcb-util ... (everything
#                            that is not a base system library, see EXCLUDE below)
#   plugins/platforms/       xcb, wayland (if built), offscreen, minimal
#   qt.conf                  points Qt at ./plugins so a system Qt is never mixed in
#
# Built inside a debian:13 container in CI. Needs: patchelf, ldd, file.
#
#   build/engine/deploy-linux.sh <build-dir> <out-dir>
set -euo pipefail

BUILD_DIR=$1
mkdir -p "$2"
OUT_DIR=$(cd "$2" && pwd)
BIN="$BUILD_DIR/bin/deskflow-core"
[ -x "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }

# Qt's plugin dir for the Qt the engine was built against.
QT_PLUGINS=$(qtpaths6 --query QT_INSTALL_PLUGINS 2>/dev/null || true)
[ -n "$QT_PLUGINS" ] && [ -d "$QT_PLUGINS" ] || QT_PLUGINS=/usr/lib/x86_64-linux-gnu/qt6/plugins
[ -d "$QT_PLUGINS/platforms" ] || { echo "Qt plugins not found at $QT_PLUGINS" >&2; exit 1; }

# Base-system libraries that every desktop has and that must come from the host
# (glibc family, GPU/X server client libs, fontconfig/freetype and their deps, glib/dbus/systemd).
# Modelled on the AppImage project's excludelist.
EXCLUDE='^(ld-linux.*|linux-vdso.*|libc|libm|libdl|libpthread|librt|libresolv|libutil|libanl|libnsl|libstdc\+\+|libgcc_s|libX11|libX11-xcb|libxcb|libXau|libXdmcp|libGL|libGLX|libGLdispatch|libEGL|libOpenGL|libGLESv2|libdrm|libgbm|libwayland-client|libwayland-cursor|libwayland-egl|libfontconfig|libfreetype|libexpat|libz|libglib-2\.0|libgobject-2\.0|libgio-2\.0|libgmodule-2\.0|libgthread-2\.0|libdbus-1|libsystemd|libudev|libselinux|libmount|libblkid|libffi|libpcre2-8|libcap|libgcrypt|libgpg-error|liblzma|liblz4|libICE|libSM|libuuid|libbsd|libmd|libasound|libpulse|libatomic|libbz2|libbrotlicommon|libbrotlidec|libpng16|libharfbuzz|libgraphite2)\.so'

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/lib" "$OUT_DIR/plugins/platforms"
cp "$BIN" "$OUT_DIR/"
for p in libqxcb.so libqoffscreen.so libqminimal.so libqwayland-generic.so libqwayland.so; do
  if [ -f "$QT_PLUGINS/platforms/$p" ]; then cp "$QT_PLUGINS/platforms/$p" "$OUT_DIR/plugins/platforms/"; fi
done
for d in xcbglintegrations wayland-shell-integration wayland-decoration-client wayland-graphics-integration-client; do
  if [ -d "$QT_PLUGINS/$d" ]; then cp -R "$QT_PLUGINS/$d" "$OUT_DIR/plugins/"; fi
done

printf '[Paths]\nPrefix = .\nPlugins = plugins\n' > "$OUT_DIR/qt.conf"

# Copy the transitive closure of non-excluded shared libraries.
collect() {
  ldd "$1" 2>/dev/null | awk '/=> \//{print $1" "$3}' | while read -r name path; do
    if [[ "$name" =~ $EXCLUDE ]]; then continue; fi
    if [ ! -e "$OUT_DIR/lib/$name" ]; then
      cp -L "$path" "$OUT_DIR/lib/$name"
      collect "$OUT_DIR/lib/$name"
    fi
  done
}
collect "$OUT_DIR/deskflow-core"
find "$OUT_DIR/plugins" -name '*.so' | while read -r p; do collect "$p"; done

# RPATHs: binary -> lib/, libs -> themselves, plugins -> ../../lib (two levels down).
patchelf --set-rpath '$ORIGIN/lib' "$OUT_DIR/deskflow-core"
for l in "$OUT_DIR"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$l"; done
find "$OUT_DIR/plugins" -name '*.so' | while read -r p; do
  depth=$(( $(echo "${p#"$OUT_DIR/"}" | tr -cd '/' | wc -c) ))
  up=$(printf '../%.0s' $(seq 1 "$depth"))
  patchelf --set-rpath "\$ORIGIN/${up}lib" "$p"
done
strip --strip-unneeded "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* 2>/dev/null || true

# Check: every bundled-category dependency resolves inside OUT_DIR.
bad=0
for f in "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* $(find "$OUT_DIR/plugins" -name '*.so'); do
  while read -r name path; do
    if [[ "$name" =~ $EXCLUDE ]]; then continue; fi
    case "$path" in
      "$OUT_DIR"/*) ;;
      *) echo "unbundled: $name -> $path (from ${f#"$OUT_DIR/"})" >&2; bad=1 ;;
    esac
  done < <(env -u LD_LIBRARY_PATH ldd "$f" | awk '/=>/{print $1" "$3}')
done
[ "$bad" = 0 ] || exit 1

# Smoke test: Qt + plugins load from the bundle and the binary runs.
env -u LD_LIBRARY_PATH QT_QPA_PLATFORM=offscreen "$OUT_DIR/deskflow-core" --version

echo "max glibc symbol version needed:"
objdump -T "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
du -sh "$OUT_DIR"
find "$OUT_DIR" -maxdepth 3 | sed "s|^$OUT_DIR/\{0,1\}||" | sort
