# Fovea prototype

Fovea is a Windows-first Electron prototype for selecting part of the screen,
receiving an automatic visual answer, and asking focused follow-up questions. It bundles the
official Codex CLI `0.144.4` executable and runs `codex app-server` locally over
JSONL/stdin/stdout; no global Codex, Node.js, Rust, Python, or separate server is
needed by an installed user.

The application is currently packaged and displayed under its original temporary
name, **Fovea**. This repository is the new Fovea home; product-name rebranding
is intentionally left for a future enhancement rather than mixed into the initial
repository preparation.

The integration follows the current official [Codex App Server documentation](https://developers.openai.com/codex/app-server)
and pins the official [OpenAI Codex 0.144.4 release](https://github.com/openai/codex/releases/tag/rust-v0.144.4).

## Setup and commands

Use Windows 10/11 on x64 or ARM64 with a current Node.js/npm for development:

```powershell
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run ocr:benchmark -- capture.png
npm run paddle:setup
npm run ocr:benchmark:paddle -- capture.png
npm run build
npm run package:win
```

`npm install` downloads the official binary for the build machine's Windows
architecture, verifies its pinned SHA-256 digest, and asks that binary to
generate its complete TypeScript app-server schema under
`resources/codex-schema`. The binary and generated schema are ignored by Git;
run `npm run sidecar:fetch` to restore or verify them. `package:win` writes an
NSIS installer under `dist/`.

On Windows, text extraction first uses the operating system's local OCR engine
and the recognition languages installed in Windows Settings. When the isolated
PaddleOCR evaluation runtime is installed, frozen-screen analysis compares
Windows OCR with PP-OCRv6 and keeps the stronger result. The bundled English
Tesseract model remains an offline fallback when PaddleOCR is not installed,
fails, or finds no useful text. Enabling **Extract text locally** reveals
an optional capture-language picker; **Automatic** uses the Windows preference.
The last available language selected in the capture bar is remembered for the
next capture.
**Analyze full screen** records the foreground window before the capture overlay
appears and limits its local Windows UI Automation snapshot to that window, so
occluded apps cannot leak boxes onto the frozen screen. It then combines those
semantic controls and roles with full-screen word-level OCR and bounded visual
feature detection on the frozen bitmap.
Overlapping results are fused so a named button is one target rather than a
control box plus duplicate text boxes. Results render progressively—semantic
controls first, sentence-level OCR next, and only strong visual candidates last.
Targets are ranked by source, meaning, confidence, and size; repeated clicks at
an overlap cycle through every target under the pointer so a large container
cannot hide a smaller box. Overlapping static text fragments are clustered by
geometry and token similarity, with the most complete line retained. Every
candidate is also checked against the frozen bitmap: uniform rectangles without
visible pixels are removed, while accepted visual boxes are tightened to their
actual edge content. It draws clickable boxes without sending the desktop to a
provider. Choosing a box opens a small menu of preset questions plus quick
actions to extract its text locally, copy recognized text, or identify and
verify it with web search. Only that boxed region and the chosen question or
action continue to the response window.
Normal capture OCR keeps the fast native-first behavior, while full-screen
Analyze runs Windows and PaddleOCR concurrently after the frozen overlay is
already visible. Recent native and fallback results are cached locally for
repeated captures. Low-confidence photographed Tesseract text also gets a
bounded black-and-white recovery pass. Clearly photographed pages are
perspective-corrected, modest text skew is straightened, and wide word gaps are
preserved as table or column separators. Captures can return several QR codes
or barcodes, rather than only the first one found.

Detected links, email addresses, and phone numbers appear beside their Copy
action in the normal response panel. Opening one always asks for confirmation;
only validated web, email, and phone targets are handed to Windows. Other QR
content and barcodes remain copy-only.

`ocr:benchmark` runs the bundled English fallback model and small-image
preprocessing used by the app, entirely on the development machine. Pass one
or more representative PNG/JPEG captures to compare confidence, recognised
character count, preprocessing, and elapsed time. If `capture.txt` exists beside
`capture.png`, the benchmark also reports character and word error rates.
Add `--json` before the image paths for machine-readable output:

```powershell
npm run ocr:benchmark -- --json .\samples\small-text.png .\samples\document.png
```

PP-OCRv6 is evaluated in an isolated Python 3.11 environment and does not
modify the system Python installation. `paddle:setup` installs the pinned
PaddleOCR 3.7.0/PaddlePaddle 3.2.2 runtime and downloads all unique evaluation
models into ignored repository folders. The three Fovea profiles are:

- `small`: small detector and small recognizer.
- `medium`: small detector and medium recognizer.
- `large`: medium detector and medium recognizer, the largest PP-OCRv6 pair.

Generate controlled 1920 × 1080, dense small-text, and high-resolution retry
fixtures, or benchmark real captures with:

```powershell
npm run ocr:fixture
npm run ocr:benchmark:paddle -- .\.paddle-ocr-cache\fixtures\screen-text.png .\.paddle-ocr-cache\fixtures\screen-dense.png .\.paddle-ocr-cache\fixtures\screen-retry.png
npm run ocr:benchmark:paddle -- --profiles small,medium .\samples\capture.png
```

Frozen-screen OCR uses a bounded 1080p detector pass after the overlay is
visible. Sparse results receive one 4K-bounded retry, so higher-resolution
analysis does not delay the capture window opening.

The app defaults to the small profile. Set
`FOVEA_PADDLE_OCR_PROFILE=medium` or `large` before `npm run dev` to test
another profile. Set `FOVEA_PADDLE_MKLDNN=0` only when diagnosing the slower
portable CPU path. PaddlePaddle 3.3.x is intentionally not used because its
Windows oneDNN/PIR path currently crashes during PP-OCRv6 inference.

## Manual test

1. Run `npm run dev`, or install the generated NSIS package.
2. In Settings, click **Sign in with ChatGPT**, finish the browser flow, and
   confirm the account and plan appear. API-key auth is also available and is
   billed separately.
3. Confirm an image-capable model is selected, then press `Ctrl+Shift+Space`.
4. Toggle **Extract text locally** in the capture bar, make a selection, and
   confirm the recognised text appears in the normal response panel. Try Stop,
   Copy, and any detected URL, email, phone, QR-code, or barcode action.
5. Choose **Analyze full screen** in the capture bar and confirm identified
   features are boxed across the frozen display. Select a box, choose one of
   its preset **Ask** questions, and confirm that exact question opens in the
   response window with the boxed region.
6. Enable **Edit before sending**, then drag a rectangle at least 24 × 24
    logical pixels on the primary display.
7. Confirm the selection stays on the frozen screen and the icon toolbar
   appears at the top. Try an annotation and solid redaction, then press Send
   and confirm the compact response window analyses the edited derivative.
8. Open **Ask**, choose a contextual suggestion, then use **Custom question**
   and confirm both questions and answers remain visible in the flowing
   conversation.
9. Add another snip, choose **Edit**, try arrows, rectangles, drawing, text,
   blur, and solid redaction, then undo/redo and save the edited copy. Confirm
   the edited draft is the image sent with the next question.
10. Expand **Show details**, then try the icon actions for View capture, Stop,
   Regenerate, Copy, and New capture. Press `Esc` in the capture viewer and
   confirm the response window remains open.
11. Close the panel and confirm its PNG disappears from the temporary path shown
   in Settings. In **History**, search for and reopen the conversation, then
   delete it. **Clean temporary files** removes any remaining temporary PNGs.

## Architecture and security

Electron's main process owns capture, filesystem access, global shortcuts,
window creation, credential-sidecar startup, and all app-server traffic. Three
small React renderers (settings, selection overlay, and question panel) use a
typed, allow-listed preload bridge with `contextIsolation: true`,
`nodeIntegration: false`, and renderer sandboxing. There is no generic command
IPC channel.

`CodexAppServerProvider` is the only `VisionProvider` implementation. It
initializes and supervises the pinned sidecar, correlates JSON-RPC responses,
continues after malformed lines, streams typed notifications, and restarts with
bounded backoff after an unexpected exit. Codex owns OAuth tokens and refresh;
its isolated `CODEX_HOME` prefers Windows Credential Manager through the
`keyring` credential store. Fovea does not log API keys, tokens, full OAuth
URLs, or screenshots.

Every model turn uses `approvalPolicy: "never"` and the read-only sandbox.
Fovea automatically declines command, file-change, permission, and
interactive-tool requests, and immediately interrupts a turn if a command,
file-change, connector, dynamic-tool, or web-search item starts. The
visual-assistant instruction also forbids tools and file changes. Provider
threads remain ephemeral and are deleted when a panel closes. Conversation
metadata and messages can be kept in a versioned local store with configurable
retention; private mode disables those writes. Screenshot history is separately
opt-in and defaults off. Edited derivatives are produced locally, and an
unredacted temporary source is deleted once the derivative replaces it.

## Known limitations

- Capture is intentionally limited to the primary display. DPI scaling is
  handled using the captured bitmap's physical-to-logical ratio, but mixed-DPI
  multi-monitor selection is not implemented yet.
- The prototype has no tray UI. Closing Settings leaves the process running so
  the global shortcut continues to work; quit it from Task Manager or the
  development terminal.
- Windows sandbox availability still depends on the host Windows configuration.
  Even if sandbox initialization fails, approval requests are never surfaced or
  accepted and the assistant is explicitly instructed not to use tools.
- The installer is unsigned, has no auto-update support, and packages only the
  architecture used for the build.
- PaddleOCR is currently a development evaluation sidecar. The Python runtime
  and models are not included in the NSIS installer yet; packaged builds safely
  continue to Tesseract when that sidecar is absent.
- A real ChatGPT/App Server request cannot be exercised in CI because it needs
  an interactive user login; protocol tests use an in-memory transport instead.

Third-party licensing for the bundled Codex sidecar is in
`resources/licences/`. Screenshots are sent only through the selected OpenAI
authentication mode. There is no analytics, telemetry, backend, Fovea
account, history database, or non-OpenAI provider.
