#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
ICON_PATH="$ROOT_DIR/src-tauri/icons/icon.icns"

if [[ ! -d "$DMG_DIR" ]]; then
  echo "DMG output directory does not exist: $DMG_DIR" >&2
  exit 1
fi

if [[ ! -f "$ICON_PATH" ]]; then
  echo "Icon file does not exist: $ICON_PATH" >&2
  exit 1
fi

VERSION="$(
  cd "$ROOT_DIR"
  node --input-type=module -e 'import fs from "node:fs"; const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); process.stdout.write(pkg.version);'
)"

PRODUCT_NAME="$(
  cd "$ROOT_DIR"
  node --input-type=module -e 'import fs from "node:fs"; const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")); process.stdout.write(config.productName);'
)"

latest_dmg=""
latest_mtime=0
while IFS= read -r -d '' candidate; do
  mtime="$(stat -f "%m" "$candidate")"
  if (( mtime > latest_mtime )); then
    latest_mtime="$mtime"
    latest_dmg="$candidate"
  fi
done < <(find "$DMG_DIR" -maxdepth 1 -type f -name "${PRODUCT_NAME}_${VERSION}_*.dmg" -print0)

if [[ -z "$latest_dmg" ]]; then
  echo "No DMG found for ${PRODUCT_NAME} ${VERSION} in $DMG_DIR" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

swift_file="$tmp_dir/set-dmg-icon.swift"
cat > "$swift_file" <<'SWIFT'
import AppKit
import Darwin
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

guard CommandLine.arguments.count == 3 else {
  fail("Usage: set-dmg-icon.swift <icon.icns> <file.dmg>")
}

let iconPath = CommandLine.arguments[1]
let filePath = CommandLine.arguments[2]

guard let image = NSImage(contentsOfFile: iconPath) else {
  fail("Unable to load icon: \(iconPath)")
}

let didSetIcon = NSWorkspace.shared.setIcon(image, forFile: filePath, options: [])
if !didSetIcon {
  fail("Unable to set Finder icon for: \(filePath)")
}
SWIFT

swift "$swift_file" "$ICON_PATH" "$latest_dmg"

find "$DMG_DIR" -maxdepth 1 -type f -name "*.dmg" ! -name "$(basename "$latest_dmg")" -delete
rm -f "$DMG_DIR/bundle_dmg.sh" "$DMG_DIR/icon.icns" "$DMG_DIR/.DS_Store"

echo "Final DMG: $latest_dmg"
