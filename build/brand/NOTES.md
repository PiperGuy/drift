Two offset horizontal strokes and a small closing dot turn environment drift into one compact, confident mark, while the softly dimensional rounded tile keeps it premium and legible at 32px. The core palette is lemon `#c8ff4d` on near-black `#08090a`, with tile base `#141a00`.

## Icon pipeline

- `icon.svg` is the source of truth: the 1024 canvas with an 824 body on a 100 px margin and a ~185 px corner, which is the macOS grid. It uses flat layers only. Apple's HIG (App icons) says the system supplies depth, edge light and shadow, so none are baked in.
- `build/icon.png` (and the copy in `resources/icon.png` that the Linux window uses) is `icon.svg` rasterized at 1024×1024 RGBA, here with Playwright's Chromium (`page.screenshot({ omitBackground: true })`). electron-builder turns `build/icon.png` into the `.icns` during `--mac` builds. No hand-made `.icns` is checked in.
- `icon-layers/background.svg` (a full-bleed square, unmasked) and `icon-layers/mark.svg` (a transparent foreground) are the inputs for Apple's Icon Composer.

### macOS-only verification (cannot run on Linux)

1. `npm run build:mac` on macOS. Then `iconutil -c iconset dist/mac*/Drift.app/Contents/Resources/icon.icns -o /tmp/drift.iconset`, and check that every size from 16 to 512@2x (1024 px) is present and sharp.
2. In Finder, the Dock and Cmd-Tab on macOS 26, check that the icon is not shown inside the grey fallback tile, and look at it in light, dark and tinted appearances.
3. Optional, for full Liquid Glass icon rendering: build `build/icon.icon` in Icon Composer (Xcode 26+) from `icon-layers/`, then set `mac.icon: build/icon.icon` in `electron-builder.yml`. electron-builder 26.2+ compiles it with `actool`, which needs macOS 15+ and Xcode 26, and keeps an `.icns` fallback. Keep `dmg.icon` on the `.icns`.
4. Window vibrancy: launch the packaged app. The window sets `vibrancy` with no `backgroundColor` and deliberately no `transparent: true` (see `src/main/window.ts`): on macOS, Electron already treats a vibrancy window as translucent and clears the page background. Check that the window keeps its native shadow and resizes normally. Check that the sidebar shows the desktop through the window, and that the content sheet stays opaque. Turn on System Settings → Accessibility → Display → Reduce transparency, then Increase contrast, and check that the window goes solid with readable text.
