# Changelog

## 0.1.25 - 2026-07-09

- Simplified the Gitee update manifest so manual installer links only live in the top-level `installers` map.
- Kept Tauri updater platform entries limited to updater `url` and `signature` fields.

## 0.1.24 - 2026-07-09

- Fixed macOS installer app bundle signing so the DMG-installed app includes sealed resources and validates with `codesign`.
- Kept single-workspace navigation hidden when only the RAW/JPEG pairing workspace is available.

## 0.1.23 - 2026-07-09

- Hid the workspace tab bar when only one workspace is available.
- Added explicit Gitee DMG installer links to the update manifest while keeping updater artifacts separate.

## 0.1.22 - 2026-07-08

- Restored full Gitee release asset synchronization before publishing the updater manifest.

## 0.1.21 - 2026-07-08

- Changed Gitee synchronization to mirror only the updater manifest while serving installer downloads from GitHub Releases.

## 0.1.20 - 2026-07-08

- Added retry handling for transient Gitee API connection timeouts during release synchronization.

## 0.1.19 - 2026-07-08

- Replaced Gitee latest-manifest writes with git pushes and switched release asset uploads to timed curl multipart uploads.

## 0.1.18 - 2026-07-08

- Pointed updater publishing to the actual Gitee repository path and restored Gitee sync as a required release step.

## 0.1.17 - 2026-07-08

- Made Gitee release synchronization best-effort so GitHub installer publishing is not blocked when the mirror repository is unavailable.

## 0.1.16 - 2026-07-08

- Fixed release publishing by building the macOS app updater bundle together with the DMG artifact.

## 0.1.15 - 2026-07-08

- Fixed GitHub Actions `npm ci` failures by restoring lockfile entries for npm 11 optional `@emnapi` dependencies.

## 0.1.14 - 2026-07-08

- Split the RAW/JPEG matcher and watermark workspaces into separate frontend and Tauri backend modules.
- Hid the incomplete watermark tab from the main navigation while keeping the module code isolated for later completion.
- Added release asset preparation and Gitee synchronization steps for automated installer publishing.

## 0.1.13 - 2026-07-08

- Refined the desktop UI with a more native macOS visual system, updated reports, and improved watermark workspace controls.
- Added Tauri updater integration with signed updater artifacts, a header update button, progress dialog, and relaunch flow.
- Documented the Gitee Release update workflow for domestic-network distribution without an ICP domain.
- Replaced public-facing `bigo` identifiers and update URLs with `masongzhi`.

## 0.1.12 - 2026-07-07

- Added a repeatable macOS packaging command that leaves only the final DMG in the bundle output directory.
- Applied the app icon to the generated DMG file so Finder displays the installer with the product icon.

## 0.1.11 - 2026-07-07

- Switched GitHub Release installer asset names to an ASCII app prefix so GitHub keeps a readable latest installer name.

## 0.1.10 - 2026-07-07

- Renamed GitHub Release installer assets before upload so the latest macOS and Windows installers display with the app name and platform.

## 0.1.9 - 2026-07-07

- Cleaned cached bundle output before CI packaging so GitHub Releases only include installers for the current version.

## 0.1.8 - 2026-07-07

- Renamed the app, window, and interface header to the Chinese name "照片配对助手".

## 0.1.7 - 2026-07-07

- Added automatic GitHub Release publishing for successful macOS and Windows installer builds.

## 0.1.6 - 2026-07-07

- Added root-level npm lock entries for `@emnapi/core` and `@emnapi/runtime` so both npm 10 and npm 11 can run `npm ci` in GitHub Actions.

## 0.1.5 - 2026-07-07

- Updated GitHub Actions to build with Node.js 24 and npm 11 to avoid npm 10 bundled optional dependency lockfile validation failures.

## 0.1.4 - 2026-07-07

- Added missing bundled dependency lock entries required by GitHub Actions `npm ci`.

## 0.1.3 - 2026-07-07

- Synchronized `package-lock.json` so GitHub Actions can install dependencies with `npm ci`.

## 0.1.2 - 2026-07-07

- Reworked the RAW/JPEG matcher interface with shadcn/ui, Radix UI, Tailwind CSS, and lucide icons.
- Added text-based JPEG list input, RAW format selection, native file opening, RAW thumbnails, and safer task clearing.
- Improved RAW scanning, matching, conflict review, export flow, completion dialog, and leveled runtime logs.
- Filtered tiny RAW candidates under 1 MB and treated identical-hash export conflicts as successful copies.
- Configured app and installer icons for packaged macOS and Windows builds.
- Added GitHub Actions packaging for macOS `.dmg` and Windows NSIS `.exe` installers on `main` pushes.

## 0.1.1 - 2026-07-07

- Updated the app icon to the selected liquid-glass photography workflow design.
- Regenerated Tauri icon assets for macOS, Windows, iOS, Android, and PNG sizes.
- Added repository ignore rules for dependencies, build outputs, and local backups.
