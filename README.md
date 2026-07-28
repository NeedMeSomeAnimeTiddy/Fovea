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
npm run build
npm run package:win
```

`npm install` downloads the official binary for the build machine's Windows
architecture, verifies its pinned SHA-256 digest, and asks that binary to
generate its complete TypeScript app-server schema under
`resources/codex-schema`. The binary and generated schema are ignored by Git;
run `npm run sidecar:fetch` to restore or verify them. `package:win` writes an
NSIS installer under `dist/`.

## Manual test

1. Run `npm run dev`, or install the generated NSIS package.
2. In Settings, click **Sign in with ChatGPT**, finish the browser flow, and
   confirm the account and plan appear. API-key auth is also available and is
   billed separately.
3. Confirm an image-capable model is selected, then press `Ctrl+Shift+Space`.
4. Enable **Edit before sending**, then drag a rectangle at least 24 × 24
    logical pixels on the primary display.
5. Confirm the selection stays on the frozen screen and the icon toolbar
   appears at the top. Try an annotation and solid redaction, then press Send
   and confirm the compact response window analyses the edited derivative.
6. Open **Ask**, choose a contextual suggestion, then use **Custom question**
   and confirm both questions and answers remain visible in the flowing
   conversation.
7. Add another snip, choose **Edit**, try arrows, rectangles, drawing, text,
   blur, and solid redaction, then undo/redo and save the edited copy. Confirm
   the edited draft is the image sent with the next question.
8. Expand **Show details**, then try the icon actions for View capture, Stop,
   Regenerate, Copy, and New capture. Press `Esc` in the capture viewer and
   confirm the response window remains open.
9. Close the panel and confirm its PNG disappears from the temporary path shown
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
- A real ChatGPT/App Server request cannot be exercised in CI because it needs
  an interactive user login; protocol tests use an in-memory transport instead.

Third-party licensing for the bundled Codex sidecar is in
`resources/licences/`. Screenshots are sent only through the selected OpenAI
authentication mode. There is no analytics, telemetry, backend, Fovea
account, history database, or non-OpenAI provider.
