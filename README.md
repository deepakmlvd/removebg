# Cutout — local background removal

Everything runs in the browser on your machine. Photos are never uploaded.

## Run

```powershell
.\start.ps1
```

## Production build

Install the build dependencies once, then generate the deployable, minimized output:

```powershell
npm install
npm run build
npm start
```

The deployment files are written to `dist/`. JavaScript and CSS are minimized; the application and worker are additionally obfuscated. The `vendor/` and `assets/` directories are copied unchanged because the runtime and model resources must retain their expected names and license notices.

The first run downloads the model and ONNX runtime (about 330 MB, via `setup.mjs`). Startup verifies all model files and resumes an incomplete download if needed, so a partially interrupted setup is repaired automatically. After that it works offline. Open `http://127.0.0.1:8765`. The page must be served over http (not opened as a file) so the worker, WebGPU and multi-threading can start.

## Features

| Area | What you get |
| --- | --- |
| Removal | One-step AI cutout, transparent background, auto-runs on open/drop/paste |
| Edge refine | Shift edge, feather, contrast, defringe, invert mask |
| Manual fix | Erase / restore brush (size, hardness, strength), undo/redo, reset to AI mask |
| Backgrounds | Transparent, solid, gradient, blurred original, your own photo, presets |
| Subject | Scale, nudge, crop to subject with padding, drop shadow |
| Preview | Before/after slider, zoom, pan |
| Download | PNG / WebP / JPEG at 25%, 50%, 75%, 100%, 150%, and 200% (lowest to highest); copy PNG; Ctrl+S |

Shortcuts: `E` erase, `R` restore, `H` pan, `[` `]` brush size, `Ctrl+Z` / `Ctrl+Y`, `Ctrl+S`, `Space` to pan.

## Speed

- Model runs in a Web Worker so the page stays responsive; the model is preloaded on page load.
- WebGPU with the fp16 model; automatic fallback to multi-threaded WASM (quantized model) if WebGPU is unavailable. `?cpu` forces CPU.
- Measured on an Intel Xe-LPG laptop (1200×800 photo): about 0.5 s per cutout after warm-up (about 2 s for the first), about 3 s on CPU.
- Edge, background and size changes never re-run the model.
- Not benchmarked against online tools: cloud tools add upload and download time, so a 2× advantage is likely for typical photos, but measure it on your own images.

## Files

- `index.html`, `styles.css`, `app.js` — UI, mask editing, compositing, export
- `infer-worker.js` — inference worker
- `vendor/` — `@imgly/background-removal` 1.7.0 (patched to load ONNX Runtime locally and use safe thread settings) and ONNX Runtime Web 1.21
- `assets/` — model weights (created by `setup.mjs`)
- `serve.mjs` — static server that sends the COOP/COEP headers required for multi-threading

## Notes

- `@imgly/background-removal` is AGPL-licensed; check that is acceptable for your internal use.
- AdSense rails are included above and below the editor. AdSense may not serve ads on localhost; configure the publisher account and production domain before release.
- Google Analytics is configured with measurement ID `G-BCKTBN727F`; update your privacy notice and consent flow as required before public launch.
- The page includes a descriptive title, meta description, and natural search phrase near the brand for background-removal SEO.
- The production host allowlist includes `removebg.hipalab.com`; localhost and `127.0.0.1` remain available for local development. Other hosts render a blank page.
- Hair and fur edges: use Detail mode, then the Erase/Restore brush and Defringe.
