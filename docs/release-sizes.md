# Windows release sizes

Record the output of `npm run package:size:check` for every release architecture.
Sizes use MiB (1,048,576 bytes). “Full installed” is the minimal unpacked package
plus the optional verified ChatGPT runtime; settings, history, and caches are excluded.

## 0.1.0 baseline — 2026-08-04

| Architecture | Minimal installer | Minimal unpacked | ChatGPT runtime | Full installed | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| x64 | 111.6 MiB (116,970,213 B) | 414.8 MiB (434,937,301 B) | 325.3 MiB (341,142,832 B) | 740.1 MiB (776,080,133 B) | Measured |
| ARM64 | ≤125.0 MiB release budget | ≤465.0 MiB release budget | 280.3 MiB (293,900,080 B) | ≤745.3 MiB release budget | Measure on ARM64 release runner |

## 0.1.0 with the Explorer right-click menu — 2026-08-06

| Architecture | Minimal installer | Minimal unpacked | Change vs baseline | Status |
| --- | ---: | ---: | ---: | --- |
| x64 | 112.0 MiB (117,411,779 B) | 417.7 MiB (437,972,853 B) | +0.4 MiB installer, +2.9 MiB unpacked | Measured |

The increase is the PDF.js renderer bundle for `document-render`. `pdfjs-dist` is a
development dependency because Vite inlines it into that renderer at build time; keeping it
out of `dependencies` also keeps its optional `@napi-rs/canvas` binary, which Fovea never
uses, out of the package. Adding it as a runtime dependency instead costs about 15 MiB of
installer and 69 MiB unpacked, which breaches both ceilings.

The previous x64 package bundled Codex: its installer was 192.1 MiB and its unpacked
directory was 774.8 MiB. The minimal x64 build therefore removes about 80.5 MiB from
the installer and 360.0 MiB from the installed core for users of API-key providers.

## 0.1.0 with English-only Electron locales — 2026-08-12

| Architecture | Minimal installer | Minimal unpacked | Change vs 2026-08-06 | Status |
| --- | ---: | ---: | ---: | --- |
| x64 | 104.3 MiB (109,373,023 B) | 374.4 MiB (392,557,643 B) | −8.0 MiB installer, −45.5 MiB unpacked | Measured |

Electron ships 55 Chromium locale `.pak` files totalling about 47 MiB. Fovea's interface is
English only, and these files carry Chromium's own strings — context menus on text fields,
the internal PDF viewer, permission prompts — not Fovea's. `electronLanguages` keeps `en-US`
and `en-GB`, which are 1.1 MiB together.

Chromium falls back to its default strings when a user's system locale has no `.pak`, so this
does not affect whether Fovea starts or which OCR languages are available; local OCR reads its
languages from Windows, not from Electron. Verified by launching the packaged build with
`--lang=de-DE`, whose locale is no longer present.

Before this change the unpacked package sat at 90.3% of its ceiling and had begun warning.

The three `tesseract.js-core` LSTM builds — plain, SIMD, and relaxed SIMD, 2.7 MiB each — are
deliberately all retained. `tesseract.js` selects one at runtime through `wasm-feature-detect`
and `require`s it by name, so a build that is detected but not shipped throws instead of
falling back. Electron 43.2.0 (Chromium 150, V8 15.0) reports both `simd` and `relaxedSimd` as
available in the main process and in a worker thread, meaning only the relaxed SIMD build
loads on such a machine, but that has been observed on one machine rather than established as
a floor. Removing about 5.4 MiB unpacked is not worth risking local OCR on hardware or an
Electron build that reports otherwise, especially now that the locale change has restored
headroom.

## Release procedure

1. Run `npm run package:win` on each release architecture.
2. Copy the exact installer and unpacked values printed by the size report into this table.
3. Add the pinned runtime size from `resources/runtime/codex-runtime-manifest.json`.
4. Investigate every warning and update `package-size-budget.json` only with a documented reason.
