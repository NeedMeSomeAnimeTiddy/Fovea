# Visual regression and UI quality checks

This workflow compares Fovea's real React renderer entry modules and CSS against approved, privacy-safe baselines. It deliberately does not start Electron, capture a desktop, sign in to a provider, read local files, or use a hosted visual-testing service.

Browser screenshots cover renderer pixels. The Windows checklist covers native composition, real display scaling, startup behavior, and GPU-dependent transparency. Neither is a substitute for the other.

## Automated coverage

`playwright.visual.config.ts` starts a loopback-only Vite harness and runs Chromium with a fixed locale, timezone, viewport, browser build, and device scale. The harness installs a typed `FoveaApi` mock before importing the production renderer entry module.

The suite covers:

- Settings Account, Appearance, onboarding, synthetic available-update, and solid fallback states;
- capture overlay idle, selection, Analyze, and error states without `desktopCapturer`;
- live-surface overlay states — idle, mid-drag selection, and the hold that precedes editing — with the harness backdrop standing in for the desktop showing through the transparent window, and without `getDisplayMedia`;
- initial question, streaming, completed answer, long answer, long error, and wide/tall/tiny attachments;
- representative light and dark appearances;
- keyboard focus, WCAG A/AA automated checks, increased contrast, and reduced motion;
- representative renderer snapshots at device scale factors 1, 1.25, 1.5, and 2.

The scale-factor projects detect renderer raster and overflow regressions. They do not emulate Windows DPI topology, Electron content bounds, or mixed-DPI placement.

## Running the suite

Install the dev dependencies and pinned Chromium build first, then run the repository script:

```powershell
npm ci
npx playwright install chromium
npm run test:visual
```

Use `npm run test:visual:headed` for local inspection. `npm run test:visual:update` produces local baseline candidates; apply the review rules below before keeping them. Open the report with:

```powershell
npx playwright show-report playwright-report/visual
```

Test output belongs in `test-results/visual` and `playwright-report/visual`. Approved PNGs belong only under `tests/visual/__snapshots__`.

On CI the `github` reporter annotates every failure with its message in the run summary, so a red
run can be diagnosed without downloading the report or the failure artifact.

## Before the first baselines exist

While `tests/visual/__snapshots__` holds no approved PNG, every screenshot assertion would fail
for the same reason and bury the assertions that describe real behaviour. The config therefore
sets `ignoreSnapshots` and prints a notice at the start of the run.

**A pass in that state is not visual coverage.** It proves only the non-screenshot assertions —
the axe checks, computed-style checks such as reduced motion and increased contrast, and the
overflow checks. Treat the suite as genuinely enforcing pixels only once baselines are committed.

The skip lifts automatically: any approved PNG anywhere under `__snapshots__` re-enables
comparison, and a run passing `--update-snapshots` never skips, so baseline generation still
writes. Nothing needs to be edited when the first baselines land.

This matters because it has already cost us. A wall of identical missing-baseline failures hid a
capture overlay that rendered no error and an increased-contrast mode that never applied; both
were failing assertions, not pixel differences, and both were invisible inside the noise.

## What the tolerance cannot see

`maxDiffPixelRatio: 0.002` allows 1,047 changed pixels in a 744 × 704 renderer, so a detail
thinner than that is invisible to the comparison. A focus ring around a single control is such a
detail: adding one leaves the baseline matching, and a regeneration correctly declines to rewrite
it, because `--update-snapshots` rewrites only snapshots that did not match.

Small indicators therefore have to be covered by assertions rather than baselines. The keyboard
focus tests compare the computed `box-shadow` before and after tabbing for exactly this reason;
their screenshots cannot distinguish a visible ring from a missing one. The same applies to focus
outlines, one-pixel borders, carets, and small status dots.

Do not respond to this by loosening or tightening the tolerance, which is a test-policy change
under the review rules below. Add the assertion instead.

## Baseline names and review

Every baseline name describes renderer, state, theme or accessibility mode, viewport where relevant, and device scale factor. For example:

```text
question--streaming--dark--transparent--504x504--dsf1.png
```

Rules:

1. Generate and compare baselines on the self-hosted Windows CI runner with the Chromium version from the lockfile. Browser rendering varies by OS, fonts, browser, headless mode, and hardware, so baselines from another environment are review aids, not replacements.
2. Pull-request CI compares only. It never runs `--update-snapshots`.
3. To request fresh images, manually dispatch the visual workflow with **Produce baseline candidate artifact** enabled. Download the artifact, inspect every candidate, and commit only intentional files.
4. Never accept a broad replacement because a run is red. Review expected, actual, and diff images and explain the intended UI change in the pull request.
5. Update only affected explicit names. A Playwright, Windows image, Chromium, font, threshold, or fixture change must be isolated from product UI changes where practical.
6. Keep `threshold: 0.2` and `maxDiffPixelRatio: 0.002` stable. A tolerance change is a test-policy change and requires separate review.
7. Freeze content, dates, viewport, caret, and ordinary animation. Do not mask real Fovea content to make a difference pass.

## Privacy and determinism

Visual fixtures are generated locally by `tests/visual/fixtures/synthetic-captures.ts`. They contain no live screenshot or account data. The bridge uses only fixed state and no-op operations.

Baseline and fixture review must reject:

- real screenshots, names, email addresses, home-directory paths, credentials, tokens, API keys, OAuth URLs, or provider responses;
- public-network requests, remote fonts, randomized values, current timestamps, or machine-specific paths;
- new Electron, filesystem, desktop-capture, provider, or login dependencies in the harness.

The reserved `.invalid` address and `C:\Synthetic` path are visibly artificial. Any new fixture source and licence must be recorded in `tests/visual/fixtures/README.md`.

## What automation does not prove

Chromium page screenshots cannot validate:

- the transparent `BrowserWindow` alpha channel against the actual desktop;
- the native shadow outside the renderer, startup flashes, focus handoff, taskbar behavior, or the transparent-to-solid retry;
- true Windows 100/125/150/200% DPI conversion, mixed-DPI movement, or multi-monitor placement;
- GPU, Remote Desktop, VM, high-contrast desktop, or optional native-material composition.

Record these as manual evidence. Do not describe an unchecked OS, scale, or GPU as passing.

## Manual test record

For each run record:

- commit and dev or packaged build;
- Windows edition, version, and build;
- physical or virtual machine, GPU/driver, and Remote Desktop status;
- monitor layout and scale factors;
- theme, contrast/motion settings, and transparent or solid material mode;
- observed result and captured evidence.

Run the complete checklist at 100% on Windows 10 and Windows 11. At 125%, 150%, and 200%, repeat the geometry, capture alignment, focus, and clipping checks. If available, move the windows and capture overlay between differently scaled monitors.

### Shared native checklist

- [ ] Settings appears only after content is ready, with no white, black, or square-corner flash.
- [ ] The question window appears adjacent to the selection without a late jump, resize, or clipped edge.
- [ ] Light and dark window startup colours match the first renderer paint.
- [ ] Focused and unfocused Settings/question surfaces remain legible; the shadow and edge treatment do not double or disappear.
- [ ] Keyboard focus is visible on canvas, glass, accent, and destructive controls in visual order.
- [ ] Reduced motion removes spectral, menu, message, typing, and selection animation without hiding state.
- [ ] Increased contrast and Windows forced colours remain readable without depending on blur or colour alone.
- [ ] At 100%, 125%, 150%, and 200%, Settings, question content, menus, tooltips, and attachment strips do not clip or overflow.
- [ ] Overlay bounds exactly match each display and pointer selection matches the captured image at every tested scale.
- [ ] Live selection shows the real desktop: video keeps playing, an open menu stays open, and hover states keep responding under the overlay.
- [ ] The overlay's own scrim, guides, capture bar, and selection outline never appear in the sent image.
- [ ] The sent frame matches the moment the rectangle was released, not the moment the overlay opened.
- [ ] Edit before sending and Analyze hold the screen at that moment, and the held image matches what was on screen.
- [ ] Cancelling with `Esc`, right-click, or a too-small selection stops the display stream; no capture indicator or stream remains after the overlay closes.
- [ ] Turning off **Settings → Capture → Region selection** switches the next capture to frozen compatibility capture without a restart, and turning it back on returns to live.
- [ ] `FOVEA_DISABLE_LIVE_CAPTURE=1` starts directly in frozen compatibility capture with no live attempt, reports the switch as unsupported, and every geometry check above still passes.
- [ ] A live failure after the overlay opens reports the fallback message and lets the area be selected again, rather than sending an unverified frame.
- [ ] Wide, tall, and tiny images crop predictably in the attachment strip and open at the correct aspect ratio.
- [ ] `--disable-transparent-windows` starts directly in a fully opaque solid fallback with no transparent holes, inset gap, or retry flash.
- [ ] Closing or cancelling each surface leaves no visible orphan window.

### Windows 10

- [ ] Default transparent Settings/question windows show the renderer-owned continuous corners, the complete 12 DIP outer inset, and one unclipped shadow.
- [ ] No square native background appears behind a rounded corner on a light or busy desktop.
- [ ] Solid fallback preserves the same content size and remains usable when native transparent resizing/maximizing is unavailable.
- [ ] Capture overlay selection and Analyze boxes stay aligned on every tested display and scale.

### Windows 11

- [ ] Repeat every shared and Windows 10 surface, fallback, shadow, scale, and startup-flash check.
- [ ] Rounded surfaces do not acquire a second native corner or shadow around the renderer-owned shape.
- [ ] If an optional native material is introduced, test it on and off, focused and unfocused, light and dark, high contrast, Remote Desktop, and solid fallback. Record **N/A** while the current implementation keeps native material disabled.

## Startup and streaming review

Performance checks are comparative evidence, not screenshot assertions:

1. Run five region captures after one warm-up and record the existing elapsed logs: `Live selection controls displayed` on the live path, and `Overlay renderer prepared`, `Screen bitmap acquired`, `Frozen bitmap encoded`, and `Frozen frame prepared and displayed` on the frozen path. Record both paths — live selection skips the bitmap work, so the two are not comparable to each other, only to their own previous run.
2. Open Settings and five question windows in both transparent and solid modes. Record visible startup flashes and elapsed readiness; do not treat the 10-second readiness timeout as an acceptable target.
3. Exercise the long synthetic streaming fixture while scrolling and tabbing through controls. Confirm input stays responsive, the response remains pinned only when appropriate, and reduced motion flushes content without progressive animation.
4. Compare the median and worst sample with the previous recorded run. Investigate material regressions instead of inventing or silently relaxing a budget.

Attach the measurements and state which observations were automated, manually observed, or not exercised.
