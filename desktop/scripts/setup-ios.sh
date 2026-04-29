#!/bin/bash
# Setup iOS project after `cargo tauri ios init`
#
# This script patches the generated iOS project to:
# 1. Copy custom app icons into the Xcode asset catalog
# 2. Raise IPHONEOS_DEPLOYMENT_TARGET to 17.0 so Xcode 26 / iOS 26 SDK
#    doesn't auto-link missing Swift compatibility shims
#    (swiftCompatibility56, swiftCompatibilityConcurrency,
#    swiftCompatibilityPacks) when linking libapp.a.
#
# Usage: cd desktop && bash scripts/setup-ios.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GEN_APPLE="$PROJECT_DIR/src-tauri/gen/apple"

if [ ! -d "$GEN_APPLE" ]; then
  echo "ERROR: iOS project not found at $GEN_APPLE"
  echo "Run 'cargo tauri ios init' first."
  exit 1
fi

echo "=== Patching iOS project ==="

# 1. Copy custom iOS icons into the asset catalog
CUSTOM_ICONS="$PROJECT_DIR/src-tauri/icons/ios"
APPICONSET="$GEN_APPLE/Assets.xcassets/AppIcon.appiconset"

if [ -d "$CUSTOM_ICONS" ] && [ -d "$APPICONSET" ]; then
  echo "Copying custom iOS icons..."
  cp "$CUSTOM_ICONS"/AppIcon-*.png "$APPICONSET/"

  # Write Contents.json mapping icons to device sizes
  cat > "$APPICONSET/Contents.json" << 'ICONJSON'
{
  "images": [
    { "size": "20x20", "idiom": "iphone", "filename": "AppIcon-20x20@2x.png", "scale": "2x" },
    { "size": "20x20", "idiom": "iphone", "filename": "AppIcon-20x20@3x.png", "scale": "3x" },
    { "size": "29x29", "idiom": "iphone", "filename": "AppIcon-29x29@2x.png", "scale": "2x" },
    { "size": "29x29", "idiom": "iphone", "filename": "AppIcon-29x29@3x.png", "scale": "3x" },
    { "size": "40x40", "idiom": "iphone", "filename": "AppIcon-40x40@2x.png", "scale": "2x" },
    { "size": "40x40", "idiom": "iphone", "filename": "AppIcon-40x40@3x.png", "scale": "3x" },
    { "size": "60x60", "idiom": "iphone", "filename": "AppIcon-60x60@2x.png", "scale": "2x" },
    { "size": "60x60", "idiom": "iphone", "filename": "AppIcon-60x60@3x.png", "scale": "3x" },
    { "size": "20x20", "idiom": "ipad", "filename": "AppIcon-20x20@1x.png", "scale": "1x" },
    { "size": "20x20", "idiom": "ipad", "filename": "AppIcon-20x20@2x-1.png", "scale": "2x" },
    { "size": "29x29", "idiom": "ipad", "filename": "AppIcon-29x29@1x.png", "scale": "1x" },
    { "size": "29x29", "idiom": "ipad", "filename": "AppIcon-29x29@2x-1.png", "scale": "2x" },
    { "size": "40x40", "idiom": "ipad", "filename": "AppIcon-40x40@1x.png", "scale": "1x" },
    { "size": "40x40", "idiom": "ipad", "filename": "AppIcon-40x40@2x-1.png", "scale": "2x" },
    { "size": "76x76", "idiom": "ipad", "filename": "AppIcon-76x76@1x.png", "scale": "1x" },
    { "size": "76x76", "idiom": "ipad", "filename": "AppIcon-76x76@2x.png", "scale": "2x" },
    { "size": "83.5x83.5", "idiom": "ipad", "filename": "AppIcon-83.5x83.5@2x.png", "scale": "2x" },
    { "size": "1024x1024", "idiom": "ios-marketing", "filename": "AppIcon-512@2x.png", "scale": "1x" }
  ],
  "info": { "version": 1, "author": "xcode" }
}
ICONJSON
  echo "Custom iOS icons installed"
else
  if [ ! -d "$CUSTOM_ICONS" ]; then
    echo "WARNING: No custom iOS icons found at $CUSTOM_ICONS"
  fi
  if [ ! -d "$APPICONSET" ]; then
    echo "WARNING: AppIcon.appiconset not found at $APPICONSET"
  fi
fi

# 2. Bump IPHONEOS_DEPLOYMENT_TARGET to 17.0 in the generated pbxproj.
#    Xcode 26 / iOS 26 SDK no longer ships the swiftCompatibility* shim
#    libraries. Tauri's libapp.a auto-links them when the deployment target
#    is too old, which causes:
#      ld: Undefined symbols: __swift_FORCE_LOAD_$_swiftCompatibility56, ...
#    Raising the target stops the auto-link and lets the iOS archive build.
PBXPROJ_GLOB="$GEN_APPLE"/*.xcodeproj/project.pbxproj
shopt -s nullglob
PBXPROJS=( $PBXPROJ_GLOB )
shopt -u nullglob
if [ ${#PBXPROJS[@]} -gt 0 ]; then
  for PBXPROJ in "${PBXPROJS[@]}"; do
    echo "Patching IPHONEOS_DEPLOYMENT_TARGET -> 17.0 in $PBXPROJ"
    # macOS sed needs a backup suffix; Linux sed is fine with empty quotes.
    if sed --version >/dev/null 2>&1; then
      sed -i 's/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*/IPHONEOS_DEPLOYMENT_TARGET = 17.0/g' "$PBXPROJ"
    else
      sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*/IPHONEOS_DEPLOYMENT_TARGET = 17.0/g' "$PBXPROJ"
    fi
  done
else
  echo "WARNING: No .xcodeproj/project.pbxproj found under $GEN_APPLE — skipping deployment target bump"
fi

echo ""
echo "=== iOS setup complete ==="
