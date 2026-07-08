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

# Sign the bundle. TCC binds a permission to the code signature, and ad-hoc
# re-signing changes it on every build — so a granted app silently loses its
# grants after a rebuild. Preference order, best first:
#   1. A real Apple-trusted "Apple Development" identity — REQUIRED for Screen
#      Recording to stick (that TCC grant is only honoured for a trusted
#      signature; a self-signed cert can hold Accessibility but not screen
#      capture).
#   2. The stable self-signed "Orbit Self-Signed" cert — Accessibility/Mic
#      survive rebuilds, but Screen Recording will not.
#   3. Ad-hoc — nothing survives a rebuild.
# Only DEBUG builds sign here; the release is re-signed with Developer ID in CI.
sign() {
    local target="$1"
    local identifier="$2"
    # Prefer a VALID (trusted, chain-complete) Apple Development identity.
    # NOTE: the trailing `|| true` is load-bearing under `set -euo pipefail`.
    # When no such identity exists (e.g. the CI runner, where the Developer ID
    # cert is imported in a later step), `grep` exits 1, `pipefail` propagates
    # it, and the bare assignment would abort the whole script right after
    # `swift build` — before the bundle is ever assembled. Swallowing it lets us
    # fall through to the self-signed / ad-hoc paths below.
    local appledev
    appledev="$(security find-identity -v -p codesigning 2>/dev/null \
        | grep -o '"Apple Development:[^"]*"' | head -1 | tr -d '"' || true)"
    if [ -n "$appledev" ]; then
        codesign --force --sign "$appledev" --identifier "$identifier" "$target" >/dev/null 2>&1 \
            && { echo "🔏 signed with trusted identity: $appledev"; return 0; }
        echo "⚠️  signing with '$appledev' failed — trying self-signed."
    fi
    if security find-identity -p codesigning 2>/dev/null | grep -q "Orbit Self-Signed"; then
        codesign --force --sign "Orbit Self-Signed" --identifier "$identifier" "$target" >/dev/null 2>&1 \
            && { echo "🔏 signed with self-signed cert (Screen Recording won't stick — see build.sh)."; return 0; }
        echo "⚠️  self-signed failed — falling back to ad-hoc."
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
    #
    # CRITICAL: the debug build also gets a distinct EXECUTABLE name ("OrbitDev").
    # macOS Screen Recording (kTCCServiceScreenCapture) keys its list entry by the
    # EXECUTABLE name, not the bundle id — so two apps whose binaries are both
    # "Orbit" collapse into ONE "Orbit" row, and granting it only ever reaches the
    # release. A different executable name gives the dev build its own "OrbitDev"
    # row that can actually be granted. (Accessibility keys by bundle id, which is
    # why it never had this collision.)
    local exe_name
    if [ "$config" = "debug" ]; then
        bundle_id="com.orbit.app.dev"
        display_name="Orbit Dev"
        exe_name="OrbitDev"
    else
        bundle_id="com.orbit.app"
        display_name="Orbit"
        exe_name="$APP_NAME"
    fi

    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp "$bin/$APP_NAME" "$app/Contents/MacOS/$exe_name"
    cp "Info.plist" "$app/Contents/Info.plist"
    cp "Assets/Brand/Orbit.icns" "$app/Contents/Resources/Orbit.icns"
    # SwiftPM resource bundles land in Contents/Resources (the codesign-legal
    # location). CAVEAT: SwiftPM's generated `Bundle.module` accessor looks for
    # them at `Bundle.main.bundleURL/<pkg>.bundle` (the .app ROOT) or a hardcoded
    # build-machine path — NOT here — so any package that reads resources via
    # `Bundle.module` (e.g. Highlightr) fatalErrors at runtime on a signed .app
    # off the build host. Don't rely on Bundle.module resources for shipped code;
    # see Sources/Orbit/UI/MarkdownRendering.swift. These copies are harmless.
    for b in "$bin"/*.bundle; do
        [ -e "$b" ] && cp -R "$b" "$app/Contents/Resources/"
    done
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName $display_name" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $display_name" "$app/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $exe_name" "$app/Contents/Info.plist"
    sign "$app" "$bundle_id"

    echo "✅ $app ($bundle_id)"
    APP_PATH="$app"
}

case "$CMD" in
    build)   assemble debug ;;
    release) assemble release ;;
    run)
        assemble debug
        # Install to /Applications and launch from THERE — NOT from .build/.
        # macOS Screen Recording (kTCCServiceScreenCapture) refuses to register or
        # honour a grant for an app that runs from a non-standard location like
        # .build/, even when it is trusted-signed. Running the dev build from
        # /Applications (a standard location, distinct executable name "OrbitDev",
        # stable Apple Development signature) is the ONLY way its Screen Recording
        # grant appears in the list and sticks across rebuilds. Accessibility/Mic
        # don't care about location, which is why only screen capture needed this.
        # Full rationale: CLAUDE.md → "签名 / 权限规则（TCC）".
        DEV_APP="/Applications/Orbit Dev.app"
        pkill -x "OrbitDev" 2>/dev/null || true
        sleep 0.4
        rm -rf "$DEV_APP"
        cp -R "$APP_PATH" "$DEV_APP"
        open "$DEV_APP"
        echo "🚀 launched Orbit Dev (/Applications/Orbit Dev.app)"
        ;;
    clean)   rm -rf .build && echo "cleaned" ;;
    *)
        echo "usage: ./build.sh [build|run|release|clean]"
        exit 1
        ;;
esac
