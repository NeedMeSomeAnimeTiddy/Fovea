# Fovea prototype

Fovea is a Windows-first Electron prototype for capturing a region, display, or
focused window, receiving a visual answer, and asking focused follow-up questions.
It supports multi-monitor capture, repeat-last capture, reusable capture recipes,
local image paste/drop/import, a tray menu, searchable local history, and private
Markdown or versioned JSON exports. OpenAI, Anthropic, and OpenRouter API-key
profiles work with the minimal installer. ChatGPT subscription sign-in is an
explicit optional download of the official Codex CLI `0.144.4`, which runs
`codex app-server` locally over JSONL/stdin/stdout.

The application is currently packaged and displayed under its original temporary
name, **Fovea**. This repository is the new Fovea home; product-name rebranding
is intentionally left for a future enhancement rather than mixed into the initial
repository preparation.

The integration follows the current official [Codex App Server documentation](https://developers.openai.com/codex/app-server)
and pins the official [OpenAI Codex 0.144.4 release](https://github.com/openai/codex/releases/tag/rust-v0.144.4).

## Shipped workflows

Capability audit last updated: **11 August 2026**.

- Capture a region, current display, or focused window from the tray, Settings,
  or a configurable global shortcut. Repeat-last reuses the last capture mode.
- Select a region over the live desktop, so video, menus, and hover states keep
  running while the rectangle is dragged. Editing and Analyze hold the screen on
  demand; unsupported Windows builds, a Settings switch, or any runtime failure
  fall back to the existing frozen capture.
- Ask through ChatGPT subscription sign-in or direct OpenAI, Anthropic, and
  OpenRouter profiles. A conversation can switch profiles and models between turns.
- Paste, drop, or pick PNG, JPEG, and WebP images into an open conversation. Fovea
  validates and decodes each image in the main process and works from managed
  temporary copies; original files are never modified. Imports are capped at 10
  images per conversation, 20 MiB per source, 25 MiB after normalization, 40
  megapixels, and 16,384 pixels per side.
- Save conversations locally with configurable retention and separately opt in to
  screenshot retention. Private mode suppresses history writes without disabling
  explicit export of the open conversation.
- Export an active or saved conversation as readable Markdown or
  [versioned JSON](docs/conversation-export.schema.json).
  Screenshot files and provider/model metadata are independent, off-by-default
  options shown in a preview before writing.
- Create ordered capture recipes that combine a capture mode, prompt, provider/model
  choice, web preference, optional local OCR, and shortcut. Auto-send is opt-in and
  requires a separate confirmation; imported recipes are disabled and lose consent.
- Review the exact provider, custom API address, model, and screenshots used by the
  next request. Draft screenshots can be opened for redaction or removed before Send.
- Compare synthetic renderer states with the Playwright visual workflow and use the
  documented Windows 10/11 checklist for native transparency, scaling, and startup QA.
- In marked, code-signed production x64 releases, opt in to stable GitHub Release
  checks, review notes, then explicitly download and start the verified installer.

## Setup and commands

Use Windows 10/11 on x64 or ARM64 with a current Node.js/npm for development:

```powershell
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:visual
npm run ocr:benchmark -- capture.png
npm run paddle:setup
npm run ocr:benchmark:paddle -- capture.png
npm run build
npm run release:check
npm run package:win
```

`npm install` installs only the desktop development dependencies. Run
`npm run sidecar:fetch` when developing the ChatGPT adapter; that command downloads
the official binary for the build machine's Windows architecture, verifies its
pinned SHA-256 digest, and generates the TypeScript app-server schema under
`resources/codex-schema`. The binary and generated schema are ignored by Git and
are not included in the minimal installer. `package:win` writes an NSIS installer
under `dist/`, prints its largest files, and enforces the package-size budget.
The ordinary local package remains unsigned and updater-disabled. See
[the signed release procedure](docs/releases.md) for the separate fail-closed
production x64 build and [the visual QA guide](docs/visual-qa.md) for baseline review.

The root `npm test` command discovers only desktop Vitest files, while root lint
also checks the Playwright harness. Playwright owns execution of `tests/visual/`
through the `test:visual` commands. The nested `website/` project keeps its
independent `npm test` and `npm run lint` commands and dependency set.

## Package-size budget

The minimal Windows package must remain at or below 125 MiB for the installer and
465 MiB unpacked. The release check warns at 90% of either ceiling and the packaging
job fails above it. Budgets live in `package-size-budget.json`; measured minimal and
full sizes per architecture are recorded in [the release-size log](docs/release-sizes.md).

The ChatGPT runtime is never downloaded at startup. Settings and onboarding disclose
its pinned download/disk size before the user chooses to install it. Interrupted,
offline, or corrupt downloads are discarded, and only a matching SHA-256 binary is
made executable. Removing the runtime leaves provider profiles, settings, and
conversation history intact.

## Live region selection

Region selection draws over the live desktop rather than over a still bitmap, so
video keeps playing, menus stay open, and hover states keep responding while the
rectangle is dragged. The overlay marks itself as excluded from screen capture,
which keeps its own scrim, guides, and capture bar out of the resulting image.

A display stream is opened in the preload only while a selection is active. It is
warmed when the pointer goes down, one PNG frame is taken at the moment the
selection is committed, and every track is stopped afterwards — including when
the grant, playback, or encoding fails. The main process validates that frame
against the display it granted: an unarmed or expired grant is refused, and the
frame must match the overlay's viewport and stay inside the selected rectangle.

Two actions need a still image and therefore hold the current screen before they
run:

- **Edit before sending** freezes the moment the rectangle is released, then
  opens the annotation toolbar over that held frame.
- **Analyze full screen** holds the screen first and reports features against the
  held bitmap.

Frozen compatibility capture remains the fallback and is chosen automatically:

- on Windows builds before 19041, which cannot exclude the overlay from its own
  capture, and on any non-Windows platform;
- when a live attempt fails at runtime — a denied or unavailable display stream,
  a stream that never produces a frame, or a display topology change mid-capture.

When live selection fails after the overlay is already open, Fovea says so and
asks for the area to be selected again rather than sending a frame it could not
verify.

**Settings → Capture → Region selection** turns live selection off for good on a
machine where it misbehaves; the switch is unavailable where the platform cannot
support it at all. Turning it back on also clears a fallback recorded earlier in
the session, so a fixed machine does not need a restart to retry. For a one-off
diagnostic run, `FOVEA_DISABLE_LIVE_CAPTURE=1` forces frozen capture for the
whole session and hides the switch's effect entirely.

On Windows, text extraction first uses the operating system's local OCR engine
and the recognition languages installed in Windows Settings. When the isolated
PaddleOCR evaluation runtime is installed, full-screen analysis compares
Windows OCR with PP-OCRv6 and keeps the stronger result. The bundled English
Tesseract model remains an offline fallback when PaddleOCR is not installed,
fails, or finds no useful text. Enabling **Extract text locally** reveals
an optional capture-language picker; **Automatic** uses the Windows preference.
The last available language selected in the capture bar is remembered for the
next capture.
**Analyze full screen** works from a still bitmap of the visible desktop — taken
before the overlay appears in frozen compatibility capture, or held on demand
from live selection — and treats that bitmap as the source of truth. When the optional
OmniParser runtime is installed, its `icon_detect_v3` screenshot model finds
interactive regions and OpenCV YuNet adds locally detected human faces as
searchable targets; Windows UI Automation may add a role, accessible name, or
tooltip only after matching one of those visible regions or visible OCR text.
Accessibility data can no longer create a box on its own, so controls from
occluded apps do not leak onto the held screen.
Overlapping results are fused so a named button is one target rather than a
control box plus duplicate text boxes. Results render progressively—semantic
anchors and sentence-level OCR first, followed by native-resolution visual
refinement.
Targets are ranked by source, meaning, confidence, and size; repeated clicks at
an overlap cycle through every target under the pointer so a large container
cannot hide a smaller box. Overlapping static text fragments are clustered by
geometry and token similarity, with the most complete line retained. Every
candidate is also checked against the held bitmap: uniform rectangles without
visible pixels are removed, while accepted visual boxes are tightened to their
actual edge content. It draws clickable boxes without sending the desktop to a
provider. Choosing a box opens a small menu of preset questions plus quick
actions to extract its text locally, copy recognized text, or identify and
verify it with web search. Only that boxed region and the chosen question or
action continue to the response window.
Normal capture OCR keeps the fast native-first behavior, while full-screen
Analyze runs Windows and PaddleOCR concurrently after the held screen is
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

Generate controlled 1920 × 1080, dense small-text, high-resolution retry, and
96-line masked-refinement fixtures, or benchmark real captures with:

```powershell
npm run ocr:fixture
npm run ocr:benchmark:paddle -- .\.paddle-ocr-cache\fixtures\screen-text.png .\.paddle-ocr-cache\fixtures\screen-dense.png .\.paddle-ocr-cache\fixtures\screen-retry.png
npm run ocr:benchmark:paddle -- .\.paddle-ocr-cache\fixtures\screen-many.png .\.paddle-ocr-cache\fixtures\screen-many-masked.png
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

### Screenshot-native control detection

Install the isolated OmniParser runtime from PowerShell:

```powershell
npm run omniparser:setup
npm run dev
```

Setup pins the current Microsoft OmniParser source adapter and downloads the
`icon_detect_v3` inference weight from the model's pinned Hugging Face revision.
Microsoft documents this icon-detection checkpoint as AGPL-licensed because it
inherits the original YOLO model's license; it is therefore an opt-in development
runtime and is not redistributed in the installer. Setup also installs OpenCV
and the MIT-licensed YuNet face detector from the official OpenCV model zoo.
Both downloaded model files are checked against pinned SHA-256 digests. It uses
a separate `.venv-omniparser` environment and
ignored `.omniparser-runtime` model directory. Once installed, Analyze enables
it automatically. Setup installs a CUDA-enabled PyTorch wheel when
`nvidia-smi` is available and otherwise installs the CPU wheel; pass
`-TorchIndexUrl` directly to `scripts/setup-omniparser.ps1` to override that
choice.

The held bitmap is shown before the model starts loading. The resident worker
first reports faces detected from that native bitmap, then a whole-screen
control pass (up to a 1920-pixel long edge by default),
then scans overlapping 1280-pixel tiles at native pixel density. This improves
small adjacent toolbar controls without returning to the old 960 × 540
bottleneck or delaying capture-window startup.

Useful test overrides are:

```powershell
$env:FOVEA_ANALYZE_BACKEND = 'omniparser' # require the new backend
$env:FOVEA_OMNIPARSER_DEVICE = 'cuda'     # auto, cpu, or cuda
$env:FOVEA_OMNIPARSER_FULL_NATIVE = '1'  # native full frame plus native tiles
$env:FOVEA_OMNIPARSER_CONFIDENCE = '0.08'
$env:FOVEA_FACE_CONFIDENCE = '0.82'       # lower finds more faces; higher rejects more false positives
$env:FOVEA_OMNIPARSER_TILE_SIZE = '1280'
npm run dev
```

Use `FOVEA_ANALYZE_BACKEND=heuristic` to compare the previous backend. Custom
runtimes can be supplied with `FOVEA_OMNIPARSER_PYTHON`,
`FOVEA_OMNIPARSER_ROOT`, `FOVEA_OMNIPARSER_MODEL`, and `FOVEA_FACE_MODEL`.

For repeatable accuracy work, put paired `*.expected.json` and `*.actual.json`
files under `tests/fixtures/analyze`, then run:

```powershell
npm run analyze:evaluate
npm run analyze:evaluate -- --json
```

The report separates overall and tiny-control recall, precision, duplicate
boxes, forbidden/occluded-region false positives, invalid labels, and detector
time. See `tests/fixtures/analyze/README.md` for the annotation schema.

The repository also carries a deterministic 20-screenshot subset of the
Apache-2.0 ScreenSpot test split. Each screenshot has one source-provided target
annotation, provenance, dimensions, and a SHA-256 digest. To reproduce the
downloads and exercise the real screenshot-native Analyze pipeline, run:

```powershell
npm run analyze:corpus:fetch
npm run analyze:regression
```

`npm run analyze:doctor` checks the optional local Python runtimes, bridge
self-tests, and pinned model hashes. Add `-- --strict-dev` to require all local
development models, or `-- --strict-package` to verify that a future installer
has staged full Python runtimes. `npm run release:check` runs type checking,
linting, unit tests, asset validation, the production build, stored Analyze
evaluations, and the runtime doctor before packaging.

### OpenAI-compatible providers

Settings → Account groups the provider picker into **Built in** (OpenAI,
Anthropic, OpenRouter), **OpenAI-compatible**, and **On this computer**.
Everything outside the first group is stored as a custom profile: choosing one
only prefills its documented address, which stays editable.

| Provider | Address |
| --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| xAI (Grok) | `https://api.x.ai/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together AI | `https://api.together.ai/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` |
| Z.AI (GLM) | `https://api.z.ai/api/paas/v4` |
| Alibaba (Qwen) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

**Other (OpenAI-compatible)** takes any address you type. Local servers accept
any token, so the key field is prefilled with a placeholder for those. Endpoints
without `GET /models` can declare a comma-separated model list instead.

Fovea sends a picture with every request, so a profile is only useful with a
vision-capable model. Fovea cannot detect that in advance for these addresses,
so it offers every model the endpoint reports; picking a text-only one is
reported as **This model cannot read images** rather than a raw protocol error.
Not every provider above serves a vision model — DeepSeek's hosted V4 API and
Cerebras are text-only at the time of writing. To use DeepSeek's open-weight
vision models (DeepSeek-VL2, Janus, DeepSeek-OCR), serve them locally with vLLM
or Ollama and use the **On this computer** entry instead.

The address must be `https://`; plain `http://` is accepted only for `localhost`
and loopback addresses, because the API key and every screenshot travel to that
host. Credentials embedded in the URL and query strings are rejected.

Fovea cannot inspect an unknown endpoint's capabilities, so unlike the built-in
providers it does not filter the model list to confirmed image-capable models —
every model the endpoint reports is offered, and choosing a text-only one
surfaces that endpoint's own error. Custom profiles use chat completions with
`image_url` content parts; the OpenRouter web-search tool is never sent to them.

### Windows right-click menu

Settings → Capture → **Add Fovea to the Windows right-click menu** adds an
**Analyse with Fovea** entry for pictures and PDF files in File Explorer and on
the Desktop. Fovea writes only per-user `HKCU\Software\Classes\
SystemFileAssociations` keys, so no elevation is needed and turning the switch
off removes them again. On Windows 11 the entry appears under **Show more
options**.

The entry opens a submenu:

| Action | What it does |
| --- | --- |
| **Analyse** | Opens the response window and answers automatically. |
| **Extract text** | Reads the text locally. No provider request, no key, works offline. |
| **Ask a question...** | Attaches the file and waits, so you write the first question. |
| **Ask: &lt;name&gt;** | One entry per saved prompt, asking that question about the file. |
| **Search the web about this** | Answers with web search preferred. Needs a provider that supports it. |

Prompts saved in Settings → Prompts appear below the fixed actions in their
saved order, and the menu is rewritten whenever one is added, edited, or
deleted. Only the prompt's identifier travels on the command line; its text is
looked up locally, so a prompt deleted since the menu was written simply opens
an empty conversation.

The prompts sit beside the actions rather than in a submenu of their own because
static registry verbs support exactly one level of cascade. Nesting further
requires a COM shell extension loaded into Explorer, which this app does not
ship.

Choosing one opens the normal response window with the file already attached;
an existing Fovea keeps running and simply opens another conversation. Pictures
are converted to PNG locally and capped at
2000 pixels on the long edge. A PDF has its first five pages drawn as images,
and text is read from up to fifty pages and sent as clearly labelled untrusted
reference data. Selecting several files opens one conversation containing all of
them, up to eight files. Fovea reads only the files that were right-clicked, and
the originals are never modified, moved, or deleted.

## Manual test

1. Run `npm run dev`, or install the generated NSIS package.
2. In Settings, either add an API-key profile or explicitly install the optional
   ChatGPT runtime, review its disclosed size, click **Sign in with ChatGPT**, and
   finish the browser flow. Confirm the account and plan appear.
3. Confirm an image-capable model is selected, then press the default
   `Ctrl+Alt+Shift+Space` shortcut. Repeat with a second display if available, then
   use the tray menu for current-display, focused-window, and repeat-last capture.
4. Toggle **Extract text locally** in the capture bar, make a selection, and
   confirm the recognised text appears in the normal response panel. Try Stop,
   Copy, and any detected URL, email, phone, QR-code, or barcode action.
5. Choose **Analyze full screen** in the capture bar and confirm the screen is
   held and identified features are boxed across it. Select a box, choose one of
   its preset **Ask** questions, and confirm that exact question opens in the
   response window with the boxed region.
6. Enable **Edit before sending**, then drag a rectangle at least 24 × 24
   logical pixels on each available display.
7. Confirm the screen is held at the moment the rectangle is released and the
   icon toolbar appears at the top. Try an annotation and solid redaction, then
   press Send and confirm the compact response window analyses the edited
   derivative.
8. With something moving on screen — a video or an open menu — start a region
   capture and confirm it keeps moving under the overlay, that the overlay's own
   scrim and capture bar do not appear in the sent image, and that the sent frame
   matches the moment of release rather than the moment the overlay opened.
9. Turn off **Settings → Capture → Region selection**, repeat steps 3–7 against
   the frozen compatibility path, then turn it back on and confirm the next
   capture is live again without a restart. Repeat once with
   `FOVEA_DISABLE_LIVE_CAPTURE=1` and confirm the switch reports the platform as
   unsupported.
10. Open **Ask**, choose a contextual suggestion, then use **Custom question**
    and confirm both questions and answers remain visible in the flowing
    conversation.
11. Paste an image into the conversation, drop several PNG/JPEG/WebP files, and
    use **Choose images**. Confirm previews appear, an unsupported or corrupt file
    reports a per-file error, originals remain unchanged, and edit/OCR/remove work.
12. Add another snip, choose **Edit**, try arrows, rectangles, drawing, text,
    blur, and solid redaction, then undo/redo and save the edited copy. Confirm
    the edited draft is the image sent with the next question.
13. Expand **Show details**, then try the icon actions for View capture, Stop,
    Regenerate, Copy, and New capture. Press `Esc` in the capture viewer and
    confirm the response window remains open.
14. Export the open conversation first without optional metadata, then with
    screenshots and provider/model metadata. Inspect both Markdown and JSON output,
    cancel once at the save dialog, and confirm cancellation leaves no partial files.
15. Create a disabled recipe, duplicate and reorder it, resolve a deliberate
    shortcut conflict, then enable and run it. Confirm it opens with the prompt and
    options visible before Send. Enable auto-send only after reviewing its warning;
    changing the prompt or provider must revoke that consent.
16. Close the panel and confirm its managed images disappear from the temporary
    path shown in Settings. In **History**, search for and reopen the conversation,
    export it, then delete it. Confirm private mode prevents a new conversation from
    entering History while still allowing explicit export from its open panel.
17. Run at least one turn on every configured path: ChatGPT, OpenAI, Anthropic,
    and OpenRouter. Where a credential or runtime is unavailable, confirm the UI
    reports that limitation without losing the conversation draft.

## Architecture and security

Electron's main process owns capture, filesystem access, global shortcuts,
window creation, credential-sidecar startup, and all app-server traffic. Three
small React renderers (settings, selection overlay, and question panel) use a
typed, allow-listed preload bridge with `contextIsolation: true`,
`nodeIntegration: false`, and renderer sandboxing. There is no generic command
IPC channel.

Live region selection is the one path where a renderer produces image data. The
main process installs a display-media request handler scoped to the capture
overlay's own session partition, and the grant is armed per selection, bound to
the granting display, and expires on a timeout. A returned frame is refused
unless a grant is live, the PNG decodes, its dimensions are self-consistent and
plausible for that display, and the reported viewport and rectangle match what
the overlay was given. Failing any of those checks drops the frame rather than
falling through to a partially trusted image.

`CodexAppServerProvider` handles ChatGPT subscription profiles, while direct API
adapters support OpenAI, Anthropic, and OpenRouter without the optional runtime.
The ChatGPT adapter supervises the pinned sidecar, correlates JSON-RPC responses,
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

- Mixed-DPI multi-monitor capture depends on Windows' reported display scale and
  should be smoke-tested on the target hardware even though every display is
  available for capture.
- Live region selection needs Windows build 19041 or later for capture exclusion
  and a display stream that starts within a few seconds. GPU, Remote Desktop, and
  virtual-machine composition vary, so the frozen fallback is a supported mode
  rather than a failure state, and `FOVEA_DISABLE_LIVE_CAPTURE=1` forces it.
- Windows sandbox availability still depends on the host Windows configuration.
  Even if sandbox initialization fails, approval requests are never surfaced or
  accepted and the assistant is explicitly instructed not to use tools.
- The Explorer entry appears in the Windows 11 legacy menu under **Show more
  options** rather than at the top level. The modern menu requires an
  MSIX-packaged app with a signed `IExplorerCommand` handler, which the unsigned
  NSIS installer cannot provide.
- Ordinary local installers are unsigned, updater-disabled, and package only the
  architecture used for the build. The production update path is x64-only and still
  requires signing credentials plus an installed N-to-N+1 acceptance run before its
  first published rollout. Optional ChatGPT runtime downloads are pinned independently
  for x64 and ARM64.
- PaddleOCR is currently a development evaluation sidecar. The Python runtime
  and models are not included in the NSIS installer yet; packaged builds safely
  continue to Tesseract when that sidecar is absent.
- OmniParser control detection is also a development sidecar. Its Python
  runtime, pinned source, and model weight are not included in the NSIS
  installer yet; packaged builds safely retain the screenshot heuristics when
  that runtime is absent.
- A real ChatGPT/App Server request cannot be exercised in CI because it needs
  an interactive user login; protocol tests use an in-memory transport instead.

Third-party licensing for the optional Codex runtime is in `resources/licences/`.
Screenshots are sent only through the provider profile selected for that conversation.
There is no analytics, telemetry, backend, or Fovea account.

Pull requests use [the repository template](.github/pull_request_template.md) to
require a lightweight documentation-impact check whenever shipped behavior,
manual verification, privacy, packaging, or known limitations change.
