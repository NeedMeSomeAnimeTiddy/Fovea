# Fovea architecture overview

This document maps the desktop application's moving parts as they exist in the
source tree. It is a reading guide, not a specification: when the code and this
page disagree, the code wins and this page needs a fix. File paths are relative
to the repository root. The build uses `electron-vite` (`electron.vite.config.ts`),
which compiles three targets — main, preload, and renderer — with `@shared`
aliased to `src/shared` in all of them.

## Process model

| Process | Entry | Role |
| --- | --- | --- |
| Main | `src/main/app.ts` | Owns capture, storage, global shortcuts, tray, window creation, provider sidecars, and every IPC handler. |
| Preload | `src/preload/index.ts` | Exposes the typed `window.fovea` bridge through `contextBridge` and hosts the live display-stream capture (`live-video-frame.ts`). |
| Renderer `settings` | `src/renderer/settings/` | Settings window with onboarding (`OnboardingFlow.tsx`), profiles, recipes, history, and updates. |
| Renderer `capture-overlay` | `src/renderer/capture-overlay/` | Full-display selection overlay, annotation editor (`CaptureEditor.tsx`), and Analyze UI. |
| Renderer `question-window` | `src/renderer/question-window/` | The response/conversation panel opened after a capture. |
| Renderer `image-preview` | `src/renderer/image-preview/` | Full-quality screenshot viewer opened from the question window. |
| Renderer `document-render` | `src/renderer/document-render/` | Hidden pdf.js canvas host, driven by `executeJavaScript` from the main process; it has no UI and no bridge surface of its own. |

Every window is created through `secureWindow()` in
`src/main/windows/window-factory.ts`, which forces `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`, and `loadRenderer()` maps each
renderer name to its built `index.html`. `app.ts` also pins `userData` to
`%APPDATA%\Fovea` and takes the single-instance lock so Explorer launches are
queued (`src/main/shell/application-launch-queue.ts`) rather than dropped.
Regular application windows (settings, question) get their chrome, resize
partition, and transparent/solid material from `window-chrome.ts` and
`window-appearance.ts`, matching the `WindowFrame` contract in `DESIGN.md`.

## How a capture flows

1. A tray action, global shortcut (`src/main/shortcuts/shortcut-manager.ts`),
   recipe, or Settings button calls `CaptureService.begin(mode, destination)`
   (`src/main/capture/capture-service.ts`).
2. `CaptureService` opens one overlay window per display. In live mode the
   overlay's own session partition gets a `setDisplayMediaRequestHandler`, and
   the preload's `LiveVideoFrameCapture` arms a grant, opens a display stream,
   and submits one PNG frame through `capture:provide-video-frame`. The main
   process refuses a frame unless the grant is live and the frame's dimensions
   match the granted display and viewport. On builds before Windows 19041, or
   when the live path fails, the overlay falls back to a frozen `desktopCapturer`
   bitmap. Live selection can be disabled in Settings or with
   `FOVEA_DISABLE_LIVE_CAPTURE=1`.
3. `select()` crops the chosen rectangle, applies any annotation operations via
   `ImageEditorService`, writes the result into `TempScreenshotStore`, and calls
   the destination's `onCompleted()`. The default destination is
   `QuestionSessions.open()`.
4. `QuestionSessions` (`src/main/windows/question-sessions.ts`) creates a session
   holding attachments, exchanges, and provider segments, opens the question
   window, and — for a recipe with consented auto-send — sends immediately.
5. `send()` validates the profile/model selection with `ProviderRegistry`,
   creates or reuses a provider conversation, marks draft attachments as sent,
   and hands the turn to `runQuestionTurn()` in `question-turn-runner.ts`, which
   streams `ProviderEvent`s back to the renderer through `question:event` and
   persists to history when not in private mode.
6. `ProviderRegistry` (`src/main/providers/provider-registry.ts`) routes by
   `selection.provider`:
   - `chatgpt` goes to `CodexAppServerProvider`
     (`src/main/providers/codex-app-server/`). It supervises the pinned Codex CLI
     `0.144.4` binary as `codex app-server`, speaks JSON-RPC over JSONL on
     stdin/stdout through `JsonlRpcClient`, restarts with bounded backoff, and
     runs every turn with `approvalPolicy: "never"` and a read-only sandbox.
     `CodexRuntimeManager` (`src/main/runtime/`) downloads, digest-verifies, and
     removes that binary on demand; it is never bundled in the minimal installer.
   - `openai`, `anthropic`, and `openrouter` share long-lived `DirectApiProvider`
     instances; `custom` profiles get one built from the stored `baseUrl` and
     optional declared model list. `DirectApiProvider` posts to `/responses`
     (OpenAI), `/messages` (Anthropic), or `/chat/completions` (OpenRouter and
     custom), parses SSE with `sse.ts`, and attaches the provider-specific
     web-search tool only when the turn allows it.
   Secrets come from `ProfileManager` → `CredentialStore`; the registry itself
   never stores keys.

Files opened from the Explorer context menu (`src/main/shell/explorer-integration.ts`,
`analyse-arguments.ts`) and images pasted, dropped, or picked into a conversation
all pass through `FileAnalysisService` (`src/main/files/`), which normalises
images with `sharp` and renders PDFs through the `document-render` renderer over
the privileged `fovea-doc:` scheme before calling `QuestionSessions.openFiles()`.

## IPC contract

- `src/shared/contracts/ipc.ts` is the single source of truth. The `IPC` constant
  enumerates every channel name (`settings:*`, `profiles:*`, `capture:*`,
  `question:*`, `history:*`, `updates:*`, `window-chrome:*`, `external:*`), and
  the `FoveaApi` interface types the renderer-facing bridge along with the view
  states (`SettingsViewState`, `QuestionViewState`, `CaptureContext`).
- `src/preload/index.ts` implements `FoveaApi` one method per channel. Every
  invoke goes through `invokeResult()`, which unwraps the `IpcResult` envelope
  (`{ ok, value } | { ok: false, error }`) and rejects with a structured
  `AppError`. Subscriptions clone payloads before handing them to the renderer.
  The finished object is published as `window.fovea`; there is no generic
  "send any command" channel.
- `src/main/ipc/register-ipc.ts` registers handlers with a `handle()` wrapper
  that routes every result through `toIpcResult()` so renderers never see raw
  exceptions. Arguments are validated by `require*` helpers (string lengths,
  enums such as capture mode or provider kind, rectangles, recipe shape, frame
  byte bounds) before reaching a service. Sender checks bind sensitive channels
  to the window that owns them: updates only from the Settings web contents,
  window-chrome only from the matching `BrowserWindow`, and attachment imports
  only from the question window that owns the session (`QuestionSessions.owns`).
  Settings mutations call `broadcastSettings()` so every open window receives
  the fresh `SettingsViewState`.

## Storage

All persistent files live under `app.getPath('userData')` and are created in
`src/main/app.ts`:

| Path | Owner | Notes |
| --- | --- | --- |
| `settings.v2.json` | `SettingsStore` (`src/main/storage/settings-store.ts`) | Sanitised on load; a corrupt file is preserved as `*.corrupt.bak` and defaults are used. Holds profiles (without secrets), shortcuts, recipes, prompts, history/privacy preferences. |
| `credentials.v1.json` | `CredentialStore` | Per-profile API keys encrypted with Electron `safeStorage` (`encryptStringAsync`/`decryptStringAsync`); values are re-encrypted when the platform asks. |
| `history.v2.sqlite` | `ConversationHistoryStore` | `node:sqlite` `DatabaseSync` in WAL mode with `STRICT` tables and a `conversation_search` FTS5 virtual table (trigram tokenizer). Migrates a legacy `history.v1.json` on first open and applies retention on startup. |
| `conversation-images/` | `ConversationHistoryStore` | Opt-in screenshot retention; orphaned files are queued and deleted. |
| `temporary-screenshots/` | `TempScreenshotStore` | Managed `snip-*` files (mode `0o600`) for the current session; cleaned at startup and when a panel closes. |
| `runtime/` | `CodexRuntimeManager`, `CodexAppServerProvider`, PaddleOCR | Downloaded Codex binary, isolated `codex-home`/`workspace`, and packaged OCR runtime caches. |

Private mode suppresses history writes without touching exports; export logic
lives in `src/main/export/conversation-export-service.ts` and follows
`docs/conversation-export.schema.json`.

## OCR stack

`app.ts` composes one `OcrService` chain:

```
NativeFirstOcrService(WindowsOcrService, PaddleFirstOcrService(PaddleOcrService, TesseractOcrService))
```

- `WindowsOcrService` (`src/main/ocr/windows-ocr-service.ts`) shells out to
  `resources/ocr/windows-ocr.ps1` to use the Windows OCR engine and the languages
  installed in Windows Settings. `NativeFirstOcrService` runs it first and, on
  frozen screens, compares its output with the fallback result using
  `resultQualityScore()`/`mergeScreenOcrResults()`.
- `PaddleOcrService` (`paddle-ocr-service.ts`) runs `resources/ocr/paddle-ocr.py`
  in the isolated Python environment created by `npm run paddle:setup`. It is a
  development evaluation sidecar; `PaddleFirstOcrService` silently skips to the
  next engine when it is absent, fails, or returns no text.
- `TesseractOcrService` (`ocr-service.ts`) is the offline floor: the bundled
  English `tesseract.js` model with preprocessing, document deskew
  (`document-image.ts`), QR/barcode decoding via `@zxing/library`, and link,
  email, and phone entity detection.

Results are cached per attachment and surfaced as `OcrResult` regions, words,
and entities on both the normal response panel and the Analyze overlay.

## Analyze full-screen pipeline

`CaptureService.analyze()` requires a frozen (held) surface and then runs four
producers concurrently against the same PNG, emitting progressive
`CaptureAnalysis` stages (`semantic`, then `text`) to the overlay:

1. **UI Automation** — `WindowsUiAutomationService` runs
   `resources/automation/windows-ui-elements.ps1` for a snapshot of visible
   accessible elements; `mapUiAutomationFeatures()` keeps only those that
   overlap visible OCR text or detector boxes, so occluded controls never leak.
2. **Screenshot detector** — `OmniParserDetectorService`
   (`screenshot-element-detector-service.ts`) drives
   `resources/analysis/omniparser-detector.py`, which reports YuNet face
   detections, a whole-frame `icon_detect_v3` pass, then native-resolution tiles.
   When the runtime is missing the pipeline falls back to the pixel heuristics in
   `detectVisualControlFeatures()`.
3. **OCR** — the chain above with `preserveGeometry` and refinement regions.
4. **Fusion and validation** — `screen-feature-analysis.ts` merges overlapping
   text and control boxes, ranks by source, meaning, confidence, and size, and
   `validateCaptureAnalysis()` drops boxes with no visible pixels and tightens
   the rest to their edge content.

Backend selection and thresholds are controlled by the `FOVEA_ANALYZE_BACKEND`,
`FOVEA_OMNIPARSER_*`, and `FOVEA_FACE_*` variables documented in the README.
Accuracy fixtures live under `tests/fixtures/analyze` and are scored by
`scripts/evaluate-analyze.mjs`.

## Design system tiers

`DESIGN.md` is the source of truth; the code lives in
`src/renderer/design-system/`:

- **Tier 1** — `styles/tokens.css`: private `--fovea-ref-*` palette, type,
  spacing, radius, motion, and z-index scales. Nothing outside this file may read
  a reference token.
- **Tier 2** — `styles/theme-dark.css` and `styles/theme-light.css`: semantic
  `--fovea-*` tokens (canvas, surfaces, borders, elevation, focus, status).
  Components never branch on theme; the preload sets `data-theme` and
  `data-appearance` on `<html>` before first paint.
- **Tier 3** — `styles/components.css` plus the React components in
  `components/` (`Button`, `Card`, `GlassPanel`, `Switch`, `Select`, `Toast`,
  `Tooltip`, `WindowControls`, …). Private recipes use `--_` variables that
  renderer CSS must not consume.

Renderer stylesheets (`settings.css`, `overlay.css`, `question.css`,
`preview.css`) are limited to layout and screen-specific composition.

## Test layout

- **Vitest** — `vitest.config.ts` collects `tests/**/*.test.*` and excludes
  `tests/visual/`. Suites cover main-process services (capture, OCR, providers,
  storage, IPC validation), shared contracts, and renderer components with
  `@testing-library/react` under jsdom. The Codex adapter is exercised through an
  in-memory JSONL transport because a real sign-in cannot run in CI.
- **Playwright visual harness** — `playwright.visual.config.ts` starts a
  loopback-only Vite server (`tests/visual/vite.config.ts`) that serves
  `tests/visual/harness/index.html`. The harness installs a typed mock of
  `window.fovea` (`tests/visual/fixtures/fovea-api.ts`) and imports the real
  renderer entry module for `settings`, `overlay`, `question`, or `preview`.
  Specs are `*.visual.ts`; approved PNG baselines live only under
  `tests/visual/__snapshots__`, and comparison is skipped with a warning until
  baselines exist. `docs/visual-qa.md` documents review rules.
- **Lint gates** — `npm run lint` runs ESLint at `--max-warnings=0` and then two
  Node scripts: `scripts/validate-design-tokens.mjs` (no literal colours, radii,
  shadows, durations, or `--fovea-ref-*` use in renderer code without a
  `fovea-design-allow` comment) and `scripts/validate-focus-rings.mjs` (a rule
  that sets `box-shadow` on a focusable element must restate the focus ring with
  higher specificity). Both have their own Vitest coverage.
- **Other gates** — `assets:validate` checks generated icons,
  `analyze:evaluate`/`analyze:corpus:check` score Analyze fixtures, and
  `analyze:doctor` verifies optional Python runtimes and pinned model hashes.

## Release pipeline

- `.github/workflows/desktop.yml` runs on every push to `main` and every
  same-repository pull request on the self-hosted Windows runner (fork pull
  requests are skipped, since the runner is a personal machine): `npm ci`,
  restore the cached Codex sidecar, `sidecar:fetch`
  (generates `resources/codex-schema` needed by typecheck), then `typecheck`,
  `lint`, `test`, `assets:validate`, and `build`.
- `.github/workflows/visual.yml` runs the Playwright harness when renderer,
  shared, or visual files change and can produce baseline candidates via
  `workflow_dispatch`.
- `.github/workflows/website.yml` installs, lints, builds, and tests the nested
  `website/` project when it changes, on the same self-hosted runner.
- Every validation workflow uses `runs-on: [self-hosted, windows]`; only the
  signed release workflow still uses GitHub-hosted `windows-latest`.
- The runner is a Windows 11 VM on the home Proxmox server. A fresh VM needs
  Git, Node 22, PowerShell 7, and the Visual C++ 2015+ x64 redistributable
  (Electron's installer loads a native module and fails with
  `ERR_DLOPEN_FAILED` without it). The Windows time service must be running
  and the VM's RTC set to local time in Proxmox: with a skewed clock the runner
  reports "the runner registration had been deleted" and never connects.
- `.github/workflows/release.yml` fires on `v*.*.*` tags: it validates the tag
  (`build/validate-release-tag.cjs`), runs `release:check`, builds with
  `build/electron-builder.release.cjs` (`forceCodeSigning: true`, GitHub publish
  metadata, and the `foveaUpdateRelease` marker), verifies the marker and
  signatures (`build/verify-release-marker.cjs`,
  `build/verify-release-artifacts.ps1`), and creates a draft GitHub Release.
  `docs/releases.md` describes the updater security model.
- **Package-size budget** — `package-size-budget.json` caps the minimal x64
  installer at 125 MiB and the unpacked tree at 465 MiB, warning at 90%.
  `scripts/report-package-size.mjs` prints the largest files and enforces the
  ceiling as the final step of `npm run package:win`; measurements are logged in
  `docs/release-sizes.md`. Ordinary local packages stay unsigned and
  updater-disabled; only the tagged release build carries the update marker.
