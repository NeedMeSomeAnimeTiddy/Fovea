# Fovea design system

This document is the source of truth for Fovea's visual language and renderer UI contracts. Issue #13 establishes the foundations, shared primitives, renderer proof, and enforcement described here without redesigning a screen.

## Product character

Fovea is precise, lightweight, and quietly futuristic. Its identity comes from near-black depth, strongly rounded floating surfaces, restrained cyan and violet accents, fine borders, readable simulated glass, compact controls, and deliberate motion.

The visual hierarchy should feel calm before it feels novel:

- Content and task state are more prominent than decoration.
- Cyan identifies primary action, focus, links, and selection. Violet is a secondary accent, not a competing primary.
- Glass is a layered material over an app-owned canvas. It is not a view through to the Windows desktop.
- Illumination is local and functional. Focus, selection, and exceptional status may glow subtly; ordinary surfaces do not.
- Controls are compact but remain easy to target with a mouse, keyboard, touchpad, or assistive technology.
- Motion explains response and hierarchy within 120–240 ms. Nothing pulses, drifts, or animates for ambience.

### Non-goals

Fovea must not resemble a generic dashboard, Windows Settings clone, RGB gaming launcher, or excessively glowing AI interface. It does not depend on Windows 11 Mica, acrylic, native rounded corners, vibrancy, desktop blur, `backdrop-filter`, animated gradients, animated noise, or persistent ambient glow.

No renderer should introduce a parallel colour scheme, radius scale, shadow family, motion vocabulary, or component style. The shared state-driven spectral window edge is the sole continuous brand-motion surface and is active only while it communicates work.

## Delivery boundary

Issue #13 has three deliberately separate outcomes:

1. **Create the system:** tokens, foundations, component contracts, accessibility rules, glass/fallback behaviour, and enforcement. Phases 2, 3, and 5 provide these foundations.
2. **Prove the system:** Phase 4 minimally migrates the existing Settings, capture overlay, and question/conversation renderers without changing their flows or layout concepts.
3. **Redesign screens:** later issues may reconsider information architecture, rounded-window infrastructure, layouts, or interaction design. Those changes do not belong to Issue #13.

All three renderer entries import the shared CSS before their renderer-owned layout styles. The proof migration is complete; renderer redesign remains deferred.

## Three-tier token architecture

### Tier 1 — private references

`styles/tokens.css` owns raw palette anchors under `--fovea-ref-*`. Only that file and `theme-*.css` may consume them. Components and renderer styles must never use reference tokens.

| Family | Frozen anchors |
| --- | --- |
| Neutral | `--fovea-ref-neutral-0: #ffffff`; `--fovea-ref-neutral-50: #f3f6fb`; `--fovea-ref-neutral-200: #cad2de`; `--fovea-ref-neutral-300: #98a3b3`; `--fovea-ref-neutral-400: #8591a2`; `--fovea-ref-neutral-600: #495363`; `--fovea-ref-neutral-700: #2a303b`; `--fovea-ref-neutral-800: #181d26`; `--fovea-ref-neutral-900: #0f131a`; `--fovea-ref-neutral-950: #090b10`; `--fovea-ref-neutral-1000: #05070a` |
| Cyan | `--fovea-ref-cyan-200: #a9edfb`; `--fovea-ref-cyan-300: #67d9f5`; `--fovea-ref-cyan-400: #43c5e7`; `--fovea-ref-cyan-600: #217c95`; `--fovea-ref-cyan-800: #123e4c` |
| Violet | `--fovea-ref-violet-200: #d5ceff`; `--fovea-ref-violet-300: #aa9cff`; `--fovea-ref-violet-500: #7c6ee6`; `--fovea-ref-violet-800: #312867` |
| Green | `--fovea-ref-green-300: #7edca3`; `--fovea-ref-green-700: #236a45`; `--fovea-ref-green-900: #102a1f` |
| Amber | `--fovea-ref-amber-300: #f3c677`; `--fovea-ref-amber-700: #775113`; `--fovea-ref-amber-900: #2a1d09` |
| Red | `--fovea-ref-red-300: #ff8f9b`; `--fovea-ref-red-600: #c94d61`; `--fovea-ref-red-800: #6f2635`; `--fovea-ref-red-900: #35141c` |
| Blue | `--fovea-ref-blue-300: #77c8ff`; `--fovea-ref-blue-700: #276d9f`; `--fovea-ref-blue-900: #0b2236` |

The palette is intentionally small. Adding an anchor requires a semantic need and contrast evidence; aesthetic convenience is not enough.

### Tier 2 — public semantic tokens

`styles/theme-dark.css` maps reference values to public meaning. Foundations, components, and renderer-local layout/domain CSS consume these `--fovea-*` names. Future themes must implement the same contract.

### Tier 3 — private component recipes

Phase 3's `components.css` may define aliases beginning `--_` inside component selectors. They compose Tier 2 values for a particular variant/state and are not public. Renderer styles must not reference them.

### Naming and ownership rules

- Public CSS custom properties use `--fovea-*`.
- Shared component classes use `.fui-*`.
- `tokens.css` owns invariant scales and reference anchors.
- `theme-*.css` owns semantic colour, surface, border-colour, shadow, glow, focus-colour, disabled-colour, loading-colour, and status mappings.
- Only theme files may select `[data-theme]`.
- Components and renderers consume semantic names and never branch on a theme.
- Renderer CSS continues to own geometry and screen-specific layout. Layout measurements are not design-token violations unless they restate a shared control, spacing, radius, shadow, or motion decision.

## Public semantic contract

The tables below are exhaustive for Phase 2. CSS and documentation must change together when this contract changes.

### Canvas, content, and interaction colours

| Token | Meaning |
| --- | --- |
| `--fovea-color-canvas` | Opaque application canvas and future BrowserWindow startup paint |
| `--fovea-color-canvas-deep` | Deepest owned backdrop and sunken regions |
| `--fovea-color-scrim` | Capture/overlay dimming layer |
| `--fovea-color-selection-fill` | Capture selection interior |
| `--fovea-color-selection-border` | Capture selection outline and text selection background |
| `--fovea-color-text-primary` | Primary readable content |
| `--fovea-color-text-secondary` | Supporting content |
| `--fovea-color-text-tertiary` | Muted metadata that still meets normal-text contrast |
| `--fovea-color-text-inverse` | Dark text on a light neutral surface |
| `--fovea-color-text-on-accent` | Text/icons on cyan or destructive action fills |
| `--fovea-color-text-disabled` | Disabled labels; disabled content is contrast-exempt but must remain legible |
| `--fovea-color-accent` | Primary action, selected state, and default focus family |
| `--fovea-color-accent-hover` | Primary-action hover |
| `--fovea-color-accent-pressed` | Primary-action pressed state |
| `--fovea-color-accent-secondary` | Restrained violet emphasis |
| `--fovea-color-link` | Inline link foreground |
| `--fovea-color-link-hover` | Inline link hover foreground |
| `--fovea-color-danger` | Destructive action foreground/fill |
| `--fovea-color-danger-hover` | Destructive hover treatment |
| `--fovea-color-danger-surface` | Dark error/destructive surface |
| `--fovea-color-on-danger` | Text/icon on destructive fill |

### Surfaces and simulated glass

| Token | Meaning |
| --- | --- |
| `--fovea-surface-base` | Default opaque content surface |
| `--fovea-surface-sunken` | Recessed fields, code, and media wells |
| `--fovea-surface-raised` | Cards and raised controls |
| `--fovea-surface-overlay` | Highest opaque overlay surface |
| `--fovea-glass-fill-subtle` | Lowest-emphasis translucent panel fill |
| `--fovea-glass-fill-default` | Standard translucent panel fill |
| `--fovea-glass-fill-strong` | High-legibility translucent panel fill |
| `--fovea-glass-fill-solid-fallback` | Opaque replacement for every glass fill |
| `--fovea-glass-highlight` | Single static internal illumination gradient |
| `--fovea-glass-edge-light` | Fine top/edge glass keyline |
| `--fovea-edge-glow-ambient` | Theme-tuned diffuse cyan, violet, and soft-rose window halo |

### Borders

| Token | Meaning |
| --- | --- |
| `--fovea-border-width` | Standard one-pixel keyline |
| `--fovea-border-width-strong` | Strong/two-pixel state boundary |
| `--fovea-border-style` | Shared border style |
| `--fovea-border-subtle` | Low-emphasis separation |
| `--fovea-border-default` | Normal control/surface boundary |
| `--fovea-border-strong` | High-contrast separation |
| `--fovea-border-interactive` | Hover/selected interactive boundary |
| `--fovea-border-disabled` | Disabled control boundary |
| `--fovea-border-control` | Complete standard-control border recipe |
| `--fovea-border-surface` | Complete opaque-surface border recipe |
| `--fovea-border-glass` | Complete glass-surface border recipe |

### Shadows, elevation, glow, and layering

| Token | Meaning |
| --- | --- |
| `--fovea-shadow-surface` | Low raised-surface shadow |
| `--fovea-shadow-floating` | Floating panel shadow |
| `--fovea-shadow-overlay` | Highest modal/overlay shadow |
| `--fovea-shadow-inset-highlight` | Fine internal top highlight |
| `--fovea-shadow-window` | Restrained renderer-owned exterior window shadow that decays within the transparent native inset |
| `--fovea-elevation-flat` | No shadow |
| `--fovea-elevation-surface` | Semantic surface elevation recipe |
| `--fovea-elevation-floating` | Semantic floating elevation recipe |
| `--fovea-elevation-overlay` | Semantic overlay elevation recipe |
| `--fovea-glow-accent` | Restrained active/selection accent glow |
| `--fovea-glow-focus` | Optional restrained focus illumination |
| `--fovea-glow-status-error` | Optional restrained urgent-error illumination |
| `--fovea-z-content` | Ordinary renderer content |
| `--fovea-z-chrome` | Renderer-owned window chrome |
| `--fovea-z-overlay` | Modals/popovers |
| `--fovea-z-tooltip` | Tooltip layer above overlays |

Elevation tokens are complete shadow recipes; z-index tokens only order layers. Neither implies native window elevation.

### Typography

| Group | Tokens |
| --- | --- |
| Families | `--fovea-font-ui`, `--fovea-font-mono` |
| Sizes | `--fovea-type-caption`, `--fovea-type-label`, `--fovea-type-body-sm`, `--fovea-type-body`, `--fovea-type-title-sm`, `--fovea-type-title`, `--fovea-type-display` |
| Line height | `--fovea-leading-tight`, `--fovea-leading-ui`, `--fovea-leading-body` |
| Weight | `--fovea-weight-regular`, `--fovea-weight-medium`, `--fovea-weight-semibold`, `--fovea-weight-bold` |
| Tracking | `--fovea-tracking-label`, `--fovea-tracking-eyebrow` |

The UI stack starts with Segoe UI Variable and falls back to Segoe UI on Windows 10. Cascadia Mono falls back to Consolas. Renderer styles select a role; they do not introduce numeric font sizes or font families.

### Spacing, targets, and radii

| Group | Tokens |
| --- | --- |
| Spacing | `--fovea-space-0`, `--fovea-space-1`, `--fovea-space-2`, `--fovea-space-3`, `--fovea-space-4`, `--fovea-space-6`, `--fovea-space-8`, `--fovea-space-10`, `--fovea-space-12`, `--fovea-space-16`, `--fovea-space-20` |
| Control targets | `--fovea-control-target-minimum`, `--fovea-control-target-compact`, `--fovea-control-target-default`, `--fovea-control-target-icon` |
| Radii | `--fovea-radius-xs`, `--fovea-radius-sm`, `--fovea-radius-md`, `--fovea-radius-lg`, `--fovea-radius-xl`, `--fovea-radius-round` |

The minimum standalone target is 24 × 24 CSS pixels. Fovea controls default to 32–36 pixels; WindowControls use at least 36 × 36 pixels. Inline text links are the only routine target-size exception. Controls use `md`, cards/panels use `lg` or `xl`, metadata uses `sm`, and only pills use `round`.

### Motion and easing

| Group | Tokens |
| --- | --- |
| Durations | `--fovea-motion-instant`, `--fovea-motion-fast`, `--fovea-motion-standard`, `--fovea-motion-deliberate` |
| Easings | `--fovea-ease-standard`, `--fovea-ease-enter`, `--fovea-ease-exit` |
| Spectral activity cycles | `--fovea-spectral-cycle-gentle`, `--fovea-spectral-cycle-thinking`, `--fovea-spectral-cycle-streaming` |

The duration scale is 120, 160, 200, and 240 ms. Components transition only required properties—normally colour, background, border, shadow, opacity, and at most 1–2 px of press movement. No ambient or decorative continuous motion is allowed.

### Focus, disabled, and loading

| Token | Meaning |
| --- | --- |
| `--fovea-focus-color` | Coloured outer focus keyline |
| `--fovea-focus-inner-color` | Dark inner focus keyline for bright controls |
| `--fovea-focus-width` | Inner keyline width |
| `--fovea-focus-offset` | Outer keyline separation/outline offset |
| `--fovea-focus-ring` | Complete default two-colour focus recipe |
| `--fovea-focus-ring-danger` | Complete error/destructive focus recipe |
| `--fovea-disabled-opacity` | Optional decorative-content fallback, not a blanket component treatment |
| `--fovea-color-text-disabled` | Disabled text |
| `--fovea-surface-disabled` | Disabled surface |
| `--fovea-border-disabled` | Disabled border |
| `--fovea-cursor-disabled` | Disabled cursor |
| `--fovea-loading-opacity` | Optional secondary-content attenuation while loading |
| `--fovea-color-loading-indicator` | Spinner/progress indicator colour |

Focus uses `:focus-visible` and is never communicated by a border-colour change alone. Disabled controls use native `disabled` where possible, suppress hover/press motion, and use semantic foreground/surface/border values. Loading is distinct from disabled: a loading control blocks duplicate activation, sets `aria-busy="true"`, retains a stable accessible name and width, and supplies visible progress text or Spinner.

### Status families

Each family exposes `foreground`, `surface`, `border`, and `icon`:

- `--fovea-status-info-foreground`, `--fovea-status-info-surface`, `--fovea-status-info-border`, `--fovea-status-info-icon`
- `--fovea-status-success-foreground`, `--fovea-status-success-surface`, `--fovea-status-success-border`, `--fovea-status-success-icon`
- `--fovea-status-warning-foreground`, `--fovea-status-warning-surface`, `--fovea-status-warning-border`, `--fovea-status-warning-icon`
- `--fovea-status-error-foreground`, `--fovea-status-error-surface`, `--fovea-status-error-border`, `--fovea-status-error-icon`

Status always combines visible text with a consistent monochrome icon or another non-colour cue. Colour never carries meaning alone.

## Dark theme and future appearance resolution

The application remains dark. `theme-dark.css` maps both `:root` and `:root[data-theme='dark']`; no light values exist in Issue #13.

The future appearance contract is:

- `data-appearance="system|dark|light"` stores user intent.
- `data-theme="dark|light"` stores the resolved theme.
- A future appearance coordinator resolves `system` from `prefers-color-scheme` before renderer paint and updates it when the OS changes.
- A future `theme-light.css` maps the exact Tier 2 names in this document.
- Components and renderer CSS never select either attribute. Only theme files select `[data-theme]`; persistence, typed preload IPC, and Settings UI belong to a later issue.

`data-transparency="off"` is an independent material preference. It does not imply light/dark appearance and does not require desktop-transparency detection.

## Glass and solid fallbacks

Glass is simulated over the opaque `--fovea-color-canvas`. A GlassPanel may combine exactly:

1. one glass fill;
2. one fine glass border;
3. one elevation recipe; and
4. at most one static `--fovea-glass-highlight` layer.

There is no desktop content behind the material and no blur dependency. Settings and question sessions use transparent, frameless BrowserWindows with renderer-owned application surfaces. The capture overlay remains transparent for functional capture reasons.

`WindowFrame` is application chrome, not a `GlassPanel` variant. Settings and every question session use this same frame. In transparent mode it owns a 12 CSS-pixel outer inset, a 20 CSS-pixel surface radius, the complete eight-region resize partition, and `--fovea-shadow-window`. One local `--window-frame-inset` property references `--fovea-space-6` for the surface and all eight regions, so fractional physical-pixel mapping cannot make their logical boundaries drift. The inset is interactive resize chrome rather than decorative padding. Maximized and solid modes remove the inset, radius, renderer shadow, and custom resize regions. The solid fallback uses the opaque `#090b10` native canvas and native opaque resize/maximize; it can be selected with `--disable-transparent-windows` or, in development, `FOVEA_DISABLE_TRANSPARENT_WINDOWS=1`. This native material fallback is independent of `data-transparency="off"`.

Both window kinds remain hidden until Electron `ready-to-show` and the renderer-ready handshake have arrived. A bounded readiness timeout records the window kind, attempt, material, native identifiers, elapsed time, each readiness flag, current-window status, and destruction status. A failed transparent attempt is destroyed and retried once in solid mode; an explicitly selected or retrying solid attempt never loops. Successful solid startup also records whether it was an automatic fallback. These diagnostics contain no capture, question, provider, or user data.

Window bounds, work areas, restore bounds, minimums, and cursor sampling stay in Electron DIP. Fractional metrics are normalized to integer BrowserWindow bounds contained within the reported work area. Relevant `bounds`, `workArea`, and `scaleFactor` display-metric changes, plus display removal, end active resize; re-fit saved floating bounds; update the effective minimum for small work areas; and re-fit application-maximized transparent bounds. This covers taskbar edge/work-area changes and removal of the display that owned restore bounds while preserving negative desktop coordinates.

Transparent resize begins only for one of the eight closed resize-edge values. Renderer pointer moves are coalesced to one animation-frame request, and main additionally coalesces requests to a 16 ms interval before sampling the current cursor. Resize end flushes the final cursor position, cancels queued work, and clears the session. Pointer up, cancellation, capture loss, blur, minimize, close, renderer teardown, controller disposal, and relevant display changes all terminate resize; pointer-capture release tolerates Windows revoking capture during native lifecycle changes.

When `[data-transparency='off']` is present, or increased contrast is requested, translucent fills resolve to solid fallbacks, decorative gradients/glows are removed, and borders strengthen. Forced-colours mode lets the user agent replace authored colours and uses system `Canvas`, `CanvasText`, `Highlight`, and `HighlightText` for the page, selection, and focus outline.

The main-process constant `WINDOW_BACKGROUND_COLOR` must be `#090b10`, matching `--fovea-color-canvas`. This intentional cross-language duplicate prevents a bright startup flash and must be reviewed whenever the canvas anchor changes.

## Component state contracts

Phase 2 documents these contracts; Phase 3 implements them. Native elements and attributes remain the source of interaction semantics.

| Primitive | Rest and hover | Focus and pressed | Disabled and loading | Error/status guidance |
| --- | --- | --- | --- | --- |
| Button | Semantic variant fill/text/border; hover uses the corresponding hover token and elevation change | `:focus-visible` two-colour ring; pressed uses pressed colour plus at most 1–2 px movement | Native `disabled`; loading also sets `aria-busy`, blocks repeat activation, keeps label/width, and shows Spinner or progress text | `danger` is an action variant, not a substitute for an error message |
| IconButton | Same interaction model as Button; icon uses `currentColor` | Same ring/press treatment; tooltip is optional assistance only | Same disabled/loading rules; a non-empty accessible label is always required | Destructive icon actions use danger treatment; state is never icon colour alone |
| TextInput/TextArea | Base/sunken surface and control border; hover strengthens the border | Focus ring surrounds, rather than replaces, the border | Native disabled/read-only semantics; a busy surrounding form owns `aria-busy` | Invalid fields set `aria-invalid`, use error border/ring, and connect visible error text with `aria-describedby` |
| Select | Native select with the shared field frame and control visuals | Native keyboard interaction plus shared focus ring | Native disabled; a busy form disables it and exposes progress outside the control | Same `aria-invalid` and described error contract as inputs |
| Switch | Native checkbox supplies semantics; track/thumb provide checked and hover cues | Focus ring covers the complete hit target; checked and pressed remain distinguishable without motion | Native disabled; during async change the labelled wrapper may be `aria-busy` and the checkbox disabled | Visible error text and status icon; checked/error are not distinguished by colour alone |
| Card/GlassPanel | Non-interactive surface by default | No focus/pressed state unless it contains or is explicitly composed as an interactive element | No generic disabled state | Status belongs in content/StatusBanner, not a decorative surface tint alone |
| Badge | Text is mandatory; optional status icon; no hover/focus for non-interactive badges | If actionable, use Button/Link semantics instead of making Badge interactive | Loading badge uses visible text plus Spinner; disabled belongs to its owning control | Info/success/warning/error tones always retain text and icon/non-colour cue |
| StatusBanner | Stable semantic fill/border/text/icon; no hover for a passive banner | Focus only for interactive descendants | Loading uses `role="status"`, progress text, and optional Spinner | `role="status"` by default; urgent errors may opt into `role="alert"`; visible heading/text is required |
| WindowControls | Neutral/ghost rest; close becomes destructive on hover | Labelled IconButton focus ring; pressed retains a no-drag hit region | Disabled only when the native action is genuinely unavailable; loading is not applicable | Close uses destructive hover plus an accessible label, never colour alone |
| Spinner | Small transform-only indicator in normal motion | Not focusable | Static busy glyph under reduced motion; hidden from AT when paired with labelled busy content | Standalone use needs an accessible label |

## Primitive delivery scope

Implemented in Phase 3 and proven in Phase 4:

- Button, IconButton, TextInput, TextArea, Select, Switch
- Card, GlassPanel
- Badge, Spinner, StatusBanner
- WindowControls

Documented now but deferred beyond Issue #13:

- **Tooltip:** must support hover/focus parity, a 400–600 ms show delay, Escape dismissal, non-interactive default content, portal/clipping policy, touch behaviour, `role="tooltip"`, and must never be the sole accessible name.
- **EmptyState:** must provide a required heading, concise body, optional monochrome illustration, one primary and at most one secondary action, responsive width, and status-appropriate tone. No current renderer has a real empty-state consumer.

## Iconography

- Do not add an icon package in Issue #13. Use small local inline SVG components only where an implemented primitive requires one.
- Use a `24 × 24` viewBox. Render at 16 px in compact controls/status, 18 px by default, and 20 px in WindowControls.
- Default stroke is 1.75 with round caps and joins. Use fill only when the metaphor requires it.
- Icons are monochrome and use `currentColor`; no gradients, multicolour state art, emoji, or raster icons for functional controls.
- Decorative icons use `aria-hidden="true"` and `focusable="false"`.
- Icon-only buttons require a non-empty programmatic label. Tooltip never supplies the only accessible name.
- Window close uses a stable SVG, not a font-dependent multiplication glyph.

## Accessibility targets

- WCAG 2.2 AA: normal text at least 4.5:1; large text at least 3:1; meaningful component boundaries and icons at least 3:1; focus indication at least 3:1 against adjacent colours.
- Every status foreground is checked against its own status surface. Disabled content is contrast-exempt but remains intentionally legible.
- Focus is visible on canvas, glass, cyan controls, and destructive controls. Forced-colours mode uses a real system-colour outline.
- Visible labels are required for settings fields; placeholder text never replaces a label. Description/error IDs remain stable and are connected with `aria-describedby`.
- State is never colour-only. Status uses text and a consistent icon; invalid fields have described error copy; loading has text/`aria-busy` in addition to motion.
- Use native buttons, inputs, textarea, select, and checkbox semantics. Switch is a styled native checkbox, not a recreated ARIA switch.
- Validate keyboard operation, 100/125/150% Windows scaling, text zoom, Windows High Contrast, reduced motion, and transparency-off during renderer proof.

### Phase 1 contrast record

| Pair | Ratio | Target |
| --- | ---: | ---: |
| Primary text `#f3f6fb` / canvas `#090b10` | 18.17:1 | 4.5:1 |
| Secondary text `#cad2de` / canvas | 12.92:1 | 4.5:1 |
| Tertiary text `#98a3b3` / canvas | 7.71:1 | 4.5:1 |
| Primary text / raised surface `#181d26` | 15.60:1 | 4.5:1 |
| Cyan link `#67d9f5` / raised surface | 10.32:1 | 4.5:1 |
| On-accent `#05070a` / cyan `#67d9f5` | 12.31:1 | 4.5:1 |
| On-danger `#05070a` / red `#ff8f9b` | 9.27:1 | 4.5:1 |
| On-danger `#05070a` / destructive hover `#c94d61` | 4.53:1 | 4.5:1 |
| Cyan focus / canvas | 12.02:1 | 3:1 |
| Violet focus / canvas | 8.35:1 | 3:1 |
| Dark inner focus / cyan control | 12.02:1 | 3:1 |
| Dark inner focus / red control | 9.05:1 | 3:1 |
| Info foreground `#77c8ff` / surface `#0b2236` | 8.86:1 | 4.5:1 |
| Success foreground `#7edca3` / surface `#102a1f` | 9.22:1 | 4.5:1 |
| Warning foreground `#f3c677` / surface `#2a1d09` | 10.29:1 | 4.5:1 |
| Error foreground `#ff8f9b` / surface `#35141c` | 7.61:1 | 4.5:1 |
| Status borders / base surface `#0f131a` | 8.56–11.66:1 | 3:1 |

These are solid-colour results. Any component that composites a translucent foreground or surface must be checked after compositing over the actual canvas. Transparency-off mappings remain the guaranteed readable fallback.

## Reduced motion

`prefers-reduced-motion: reduce` collapses motion durations to 1 ms, removes delays, limits animations to one iteration, and forces CSS scrolling to `auto`. Components must remove transform feedback and render Spinner as a static busy indicator in their Phase 3 CSS. The question renderer's explicit smooth `scrollTo` call must independently choose `behavior: 'auto'` during Phase 4 because CSS cannot override that JavaScript option.

No animated gradient, animated noise, parallax, pulsing glow, or decorative continuous animation is permitted in either motion mode. The state-driven window halo is the single exception: its narrow masked spectrum flows around the frame, with faster cycles for thinking and streaming. Stopped and error states remain static, hidden windows pause, and reduced-motion or increased-contrast treatments remove continuous motion.

## Windows 10 and performance budgets

- Settings and question sessions use the shared renderer-owned rounded window shell. The capture overlay remains transparent for functional capture behaviour.
- Do not use `backdrop-filter`, filter blur, native acrylic, Mica, vibrancy, or Windows 11 corner APIs.
- A major surface may have one static background gradient, one local highlight, one fine border, and one elevation recipe. Do not stack full-window radial gradients.
- Use at most two moderate shadow layers in a recipe. Do not put large blurred shadows on every transcript row or Markdown element.
- No noise ships in the initial system. Any later static texture needs paint profiling and a demonstrated banding benefit.
- Spinner is the only planned continuous animation: small, transform-only, and replaced by a static indicator under reduced motion.
- Capture drag and long-transcript scrolling should sustain responsive 60 Hz interaction on representative Windows 10 hardware. Profile paint flashing and layer growth before changing the existing capture mask.
- Transparent resize requests are capped by renderer animation frames and a 16 ms main-process coalescing interval; bounds state remains outside React rendering.
- Avoid promoting every surface to its own compositor layer. Transform and `will-change` are temporary interaction tools, not default surface properties.
- Never trade readable solid fallback surfaces for visual transparency.

## Visual-literal policy and enforcement

`npm run lint:design` runs the zero-dependency renderer validator directly. The normal `npm run lint` command runs ESLint and then this validator, so design enforcement is mandatory rather than an optional review step.

The validator enforces these rules:

- Renderer literal colours, semantic shadows/glows, radii, and motion timings live only in `tokens.css` or `theme-*.css` as appropriate. The separately documented main-process startup canvas constant is the sole cross-language pairing.
- Component and renderer CSS use Tier 2 semantic tokens. They may not use `--fovea-ref-*`.
- TS/TSX must not carry visual colour, radius, shadow, animation, or transition literals. Dynamic layout geometry such as capture coordinates is allowed.
- CSS-wide/system values such as `transparent`, `currentColor`, `inherit`, `Canvas`, `CanvasText`, `Highlight`, and `HighlightText` are allowed where semantically correct.
- An unavoidable exception requires an immediately preceding `fovea-design-allow: <specific reason>` comment. CSS uses `/* fovea-design-allow: specific reason */`; TS/TSX may use that form or `// fovea-design-allow: specific reason`. Every accepted exception is printed by `lint:design`; broad directory/file exemptions are not allowed.
- A new token requires documentation, a semantic use case, and applicable contrast evidence. Do not add aliases merely to make a local literal pass review.

The validator is intentionally declaration-oriented rather than a full CSS or TypeScript parser. It checks direct CSS declarations, renderer TS/TSX colour strings, and literal values in inline `style={{ ... }}` blocks. It does not evaluate visual values assembled dynamically in arbitrary runtime objects; those remain a code-review boundary. The reduced-motion foundation's existing 0–1 ms near-zero declarations are the only contextual timing allowance outside `tokens.css`.

No Windows 10 paint profiling was available during Issue #13. The 60 Hz capture-drag and long-transcript budgets remain explicit manual acceptance targets rather than measured passes.

## File and import contract

`src/renderer/design-system/index.css` imports, in order:

1. `styles/tokens.css`
2. `styles/theme-dark.css`
3. `styles/foundations.css`
4. `styles/components.css`

Each renderer imports `index.css` once before its local layout CSS. The design system never imports a renderer stylesheet.
