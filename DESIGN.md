# Fovea design system

This document is the source of truth for Fovea’s visual language and renderer UI contracts.

## Product character

Fovea is calm, spatial, and precise. Its interface uses Apple-inspired restraint without copying macOS: generous continuous corners, layered translucent materials, soft blue depth, clear typography, and controls that feel physical without looking heavy.

The hierarchy should feel obvious before it feels decorative:

- The user’s task and answer are always more prominent than chrome.
- Blue identifies primary action, selection, links, and focus. Violet adds depth but never competes with the primary action.
- Glass is a functional material. It separates navigation, content, menus, and floating controls while keeping the window visually continuous.
- Every surface belongs to the same radius, border, shadow, and material families.
- Motion explains entry, hierarchy, and response in 110–280 ms. Ambient movement is reserved for active work states.
- Light and dark appearances are equal expressions of the same system.

Fovea must not resemble a generic dashboard, a Windows Settings clone, an RGB gaming launcher, or an excessively glowing AI interface. Avoid rainbow edges, persistent neon, square utility panels, nested borders without hierarchy, decorative gradients that compete with content, and animation with no state meaning.

## Material model

Fovea owns its visual canvas. Themes provide a quiet ambient blue/violet backdrop, then surfaces layer translucent fills over that canvas.

The material stack is:

1. `--fovea-color-canvas` and `--fovea-background-ambient`;
2. semantic glass fills (`subtle`, `default`, and `strong`);
3. one fine glass edge;
4. one static internal highlight recipe;
5. semantic elevation where the surface actually floats;
6. backdrop blur and saturation when transparency is enabled.

Shared glass surfaces use:

```css
backdrop-filter:
  blur(var(--fovea-material-blur))
  saturate(var(--fovea-material-saturation));
```

`data-transparency="off"`, increased-contrast preferences, and forced-colours mode remove blur and replace translucent fills with opaque semantic fallbacks. Readability must never depend on seeing content behind a panel.

## Token architecture

### Tier 1 — references and invariant scales

`src/renderer/design-system/styles/tokens.css` owns:

- the private `--fovea-ref-*` palette;
- typography and weights;
- spacing;
- control target sizes;
- the continuous radius scale;
- border dimensions;
- motion timings and easings;
- focus geometry;
- shared z-index values.

Reference tokens are private. Renderer and component styles must not consume `--fovea-ref-*` values directly.

### Tier 2 — semantic themes

`theme-dark.css` and `theme-light.css` map references to public meaning:

- canvas and ambient depth;
- content and interaction colours;
- opaque and translucent surfaces;
- material blur;
- borders;
- shadows and elevation;
- focus rings;
- disabled and loading states;
- informational, success, warning, and error states;
- capture-overlay colours that remain legible over arbitrary desktop content.

Components and renderer styles consume semantic `--fovea-*` names and do not branch on a theme.

### Tier 3 — component recipes

`components.css` may compose semantic tokens into private component variables beginning with `--_`. Renderer styles must not consume those private recipes.

## Core scales

### Typography

The UI stack begins with the host system font and prefers SF Pro when available:

```css
-apple-system, BlinkMacSystemFont, "SF Pro Text",
"Segoe UI Variable", "Segoe UI", system-ui, sans-serif
```

Use:

- caption for metadata and quiet status;
- label for compact control labels;
- body-small for supporting UI copy;
- body for normal content;
- title-small for card headings;
- title for screen headings;
- display for onboarding moments only.

Headings may use slightly tighter tracking. Body copy must retain comfortable line height.

### Spacing

Use the shared 2–48 px progression in `tokens.css`. Screen-specific geometry may use literal measurements where it does not restate a shared design decision.

### Corners

The corner family is deliberately generous and continuous:

| Token | Use |
| --- | --- |
| `--fovea-radius-xs` | Small code and media details |
| `--fovea-radius-sm` | Inputs, buttons, and navigation rows |
| `--fovea-radius-md` | Statuses, previews, and grouped controls |
| `--fovea-radius-lg` | Cards, messages, and menus |
| `--fovea-radius-xl` | Floating application windows |
| `--fovea-radius-2xl` | Reserved hero surfaces |
| `--fovea-radius-round` | Pills, switches, and circular controls |

Nested surfaces should step down by one radius level. Avoid mixing square and rounded geometry in the same hierarchy.

## Shared component contracts

### Buttons

- Primary buttons use the semantic blue fill and white content.
- Secondary buttons use default glass, a fine highlight edge, and restrained elevation.
- Ghost buttons are transparent until hover.
- Destructive buttons use the semantic danger family.
- Hover may lift by one pixel; pressed state scales slightly inward.
- Loading preserves button dimensions and exposes a labelled status.

### Inputs and selects

- Controls use a sunken translucent surface and `radius-sm`.
- Hover raises contrast without changing layout.
- Focus uses the shared two-keyline focus ring.
- Placeholders use tertiary text; disabled content remains legible but visibly inactive.

### Switches

Switches use a compact pill track, a round raised thumb, and semantic blue when selected. Native checkbox semantics remain intact.

### Cards and glass panels

- `Card` is the default grouped material surface and uses `radius-lg`.
- `GlassPanel` is reserved for stronger floating composition and uses `radius-xl`.
- Neither is interactive by default.
- Avoid cards that repeat the same empty-state message as an adjacent status banner.

### Badges and status banners

Colour is paired with visible text and, where appropriate, an icon. Status backgrounds are translucent tints rather than opaque blocks. Error state is the only urgent visual treatment.

### Menus and tooltips

Menus use strong glass, `radius-lg`, overlay elevation, and material blur. Tooltips use the same recipe at a smaller scale. They must remain inside the viewport and avoid covering the control that opened them.

## Window chrome

`WindowFrame` owns every regular application window:

- a 12 CSS-pixel transparent outer inset;
- a 28 CSS-pixel application-surface radius;
- one shared shadow;
- a fine state edge;
- the eight-region transparent resize partition;
- the solid material fallback.

The edge is nearly static at idle. Blue-to-violet movement appears only while Fovea is connecting, authenticating, thinking, recovering, or streaming. Completed, stopped, and error states settle quickly.

Compact response-window controls remain in a rounded glass capsule. Settings and onboarding intentionally omit a redundant title bar and use their own clear top-level hierarchy.

The native startup colours in `window-appearance.ts` must stay paired with the theme canvases to prevent first-paint flashes.

## Renderer composition

### Settings

- The sidebar is one continuous subtle glass material.
- Navigation rows combine a restrained line icon and label.
- The selected row uses strong glass, a highlight edge, and soft elevation.
- Page headings use a title plus one sentence of context.
- Settings groups are glass cards; redundant empty cards are omitted.
- The fixed surface is 720 × 680 CSS pixels so forms retain comfortable spacing.

### Onboarding

- Three steps share one brand header, compact progress path, scrollable content region, and strong-glass footer.
- Workflow cards use large illustrations and deliberate empty space.
- Provider choices are one coherent segmented grid.
- Capture testing remains visibly private.
- Every step fits the standard Settings surface without clipping; scrolling is a fallback for small work areas.

### Response window

- The header is a subtle material strip.
- The answer timeline is the visual focus.
- User messages use primary blue; assistant messages use default glass.
- Menus use strong glass and open from their owning controls.
- Attachments form a rounded material strip.
- Capture, model, regenerate, stop, and copy actions live in one floating rounded dock.
- The automatic opening answer may be more prominent, but it remains part of the same conversation.

### Capture overlay

- Arbitrary desktop content is dimmed consistently.
- The active selection uses the primary blue family, rounded corners, and a restrained glow.
- Dimensions, instructions, errors, and submission state use the same dark glass pill material.
- Overlay controls remain usable regardless of the selected appearance.

### Image preview

- The fullscreen scrim softly blurs the underlying context.
- The screenshot uses a glass edge, large continuous corners, and overlay elevation.
- A visible bottom pill explains how to close the preview.

## Accessibility

- Normal text targets WCAG AA contrast against the complete composited surface.
- Focus is visible on canvas, glass, accent, and destructive surfaces.
- Focus order follows visual order.
- Icon-only actions require accessible labels and tooltips.
- Status changes use appropriate live-region semantics.
- Native input, select, button, checkbox, and details semantics are retained.
- Reduced motion removes animation and transform-driven feedback.
- Increased contrast and transparency opt-out produce opaque surfaces.
- Forced-colours mode uses system colours and real outlines.
- Interactive targets remain at least 28 px in compact contexts and 40 px for standard controls.

## Enforcement

Run:

```powershell
npm run lint:design
```

The validator scans renderer CSS and TS/TSX and fails on:

- literal visual colours outside controlled token/theme files;
- literal shared radii;
- literal shadows;
- literal motion durations;
- renderer use of private reference tokens;
- undefined semantic token references.

An exception requires an immediately preceding `fovea-design-allow` comment with a specific functional reason. Exceptions are reported visibly and should remain rare.

When adding UI:

1. use an existing shared component where possible;
2. consume semantic tokens only;
3. keep screen CSS focused on layout and domain-specific composition;
4. verify light, dark, transparency-off, reduced-motion, and keyboard states;
5. run typecheck, lint, tests, build, and visual QA.
