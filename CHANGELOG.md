# Changelog

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
