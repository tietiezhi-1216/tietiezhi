#!/usr/bin/env bash
#
# Orbit build helper.
#
# `swift build` only produces a bare executable. A macOS GUI app that requests
# Microphone / Accessibility permissions and runs as a menu-bar agent needs a
# real .app bundle: an Info.plist and a (here ad-hoc) code signature so macOS
# gives it a stable identity for TCC. This script builds the executable,
# assembles that bundle, signs it, and — for `run` — launches it.
#
# Usage:
#   ./build.sh build      # compile + assemble Orbit.app (debug)
#   ./build.sh run        # build, then (re)launch the app
#   ./build.sh release    # compile + assemble in release config
#   ./build.sh clean      # remove build artifacts
#
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Orbit"
CMD="${1:-build}"
APP_PATH=""

# Sign the bundle. Prefer the stable self-signed identity (see
# scripts/dev-signing-setup.sh) so macOS keeps Accessibility / Microphone grants
# across rebuilds; fall back to ad-hoc if it isn't set up. TCC binds a permission
# to the code signature, and ad-hoc re-signing changes it on every build — which
# is why a granted app silently stops being able to paste after a rebuild.
SIGN_IDENTITY="Orbit Self-Signed"
sign() {
    local target="$1"
    local identifier="$2"
    if security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
        codesign --force --sign "$SIGN_IDENTITY" --identifier "$identifier" "$target" >/dev/null 2>&1 \
            && return 0
        echo "⚠️  signing with '$SIGN_IDENTITY' failed — falling back to ad-hoc."
    else
        echo "ℹ️  no stable signing identity — using ad-hoc (run scripts/dev-signing-setup.sh once"
        echo "    so Accessibility permission survives rebuilds)."
    fi
    codesign --force --sign - --identifier "$identifier" "$target" >/dev/null 2>&1 || true
}

assemble() {
    local config="$1"
    echo "▶ swift build -c $config"
    swift build -c "$config"

    local bin app bundle_id display_name
    bin="$(swift build -c "$config" --show-bin-path)"
    app="$bin/$APP_NAME.app"

    # Debug builds get a distinct bundle id + name so the locally-run dev app and
    # an installed release build stop sharing a TCC identity and clobbering each
    # other's Microphone / Accessibility grants. configDirectory() is hardcoded to
    # com.orbit.app, so both variants still share settings & history.
    if [ "$config" = "debug" ]; then
        bundle_id="com.orbit.app.dev"
        display_name="Orbit Dev"
    else
        bundle_id="com.orbit.app"
        display_name="Orbit"
    fi

    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp "$bin/$APP_NAME" "$app/Contents/MacOS/$APP_NAME"
    cp "Info.plist" "$app/Contents/Info.plist"
    cp "Assets/Brand/Orbit.icns" "$app/Contents/Resources/Orbit.icns"
    # SwiftPM resource bundles (e.g. Highlightr's highlight.js) must live in the
    # app's Resources so Bundle.module resource lookup works at runtime.
    for b in "$bin"/*.bundle; do
        [ -e "$b" ] && cp -R "$b" "$app/Contents/Resources/"
    done
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName $display_name" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $display_name" "$app/Contents/Info.plist"
    sign "$app" "$bundle_id"

    echo "✅ $app ($bundle_id)"
    APP_PATH="$app"
}

case "$CMD" in
    build)   assemble debug ;;
    release) assemble release ;;
    run)
        assemble debug
        pkill -x "$APP_NAME" 2>/dev/null || true
        sleep 0.4
        open "$APP_PATH"
        echo "🚀 launched $APP_NAME"
        ;;
    clean)   rm -rf .build && echo "cleaned" ;;
    *)
        echo "usage: ./build.sh [build|run|release|clean]"
        exit 1
        ;;
esac
