# Free PDF Editor 2.0

Offline-first Android PDF editor using Vite, PDF.js, pdf-lib and Capacitor.

## Features
- Local PDF opening and rendering
- Multi-page navigation and zoom
- Add text and replace visible text with whiteout/replacement text
- Highlight, rectangle and freehand-style annotations
- Undo/redo
- Page delete, blank page insertion, PDF append
- Current-page export
- Search PDF text
- Native Android save/share through Capacitor Filesystem + Share
- Browser download fallback
- Bundled PDF.js/pdf-lib assets (no CDN dependency)
- GitHub Actions Android APK build

## Build
`npm ci && npm run build && npx cap add android && npx cap sync android`

For GitHub Actions, push to `main`/`master` or run the workflow manually.

The workflow uses AdMob's Google test application ID. Replace it with your own AdMob App ID and production ad unit IDs before publishing.

## Important PDF editing note
PDFs do not have a universal "edit this text" primitive. The editor uses a safe visual replacement/whiteout technique for existing text and embeds newly added text/annotations into the exported PDF. This avoids pretending that arbitrary PDF content streams can be losslessly rewritten in the browser.
