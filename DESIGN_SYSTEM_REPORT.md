# Design System Implementation Report

**Project:** Auth App (React + Vite client, Express/Postgres server)
**Date:** 2026-09-05
**Scope:** Apply the provided design-token CSS system across the application without breaking auth/session functionality.

---

## 1. Audit of current styling

The client was styled with a single `client/src/styles.css` that hardcoded colours, fonts, and spacing: a `.card`, `.field`, `.label`, `.input`, `.btn` set plus one CSS variable file for the dark palette. Layouts were background-gradient doors that could not express the semantic role system. No design tokens existed on disk.

## 2. Architecture

A layered, single-source-of-truth design system was added inside `client/src/styles`, imported in order in `client/src/main.jsx`:

```
tokens.css      -> provided tokens, verbatim (source of truth). Primitives + roles + dark roles.
themes.css      -> theme wiring (color-scheme), font-stack aliases, supplementary success role,
                   component-level status tokens, theme transitions.
typography.css  -> all 15 type utilities (display/headline/title/body/label) + number utilities.
globals.css     -> reset, base elements, focus-visible, layout primitives, reduced-motion.
components.css  -> all reusable component classes (ui-*), showcase styles, responsive rules.
```

Rule enforced: **UI never references primitives or hardcoded values** — it consumes semantic roles (`--colour-roles-*`), spacing tokens (`--spacing-collection-*`), typography tokens (`--typography-*-*`), and effect tokens (`--effect-*-shadow`).

## 3. Token source of truth (tokens.css)

Created `client/src/styles/tokens.css` from the provided CSS, unchanged:
- Primitive colour palettes (all key colours + 5-colour scales).
- 30+ light colour roles under `:root`.
- Dark colour roles under `:root.dark` including `color-mix()` surface containers.
- Dark-specific shadow overrides.
- Typography tokens for display/headline/title/body/label.
- Number typography tokens (`--typography-number-*`).
- Spacing collection (`no-spacing` … `very-large`).

Nothing in the UI renames or re-derives these tokens.

## 4. Supplementary tokens added (documented deviation)

The supplied design tokens ship **no success palette** (only warning/error flags). To keep success states semantic, `themes.css` adds, following the existing tonal pattern:
- `--colour-roles-success`, `--colour-roles-on-success`, `--colour-roles-success-container`, `--colour-roles-on-success-container` (light + dark).
- Component-level status tokens `--ds-status-info/success/warning/error` for saturated indicator dots (light + dark).

These are the only additions beyond the source file and are clearly documented as extensions.

## 5. Typography system

- DM Sans is the full design-system family: all `--typography-*` tokens already reference it; `--font-dm-sans` is loaded via Google Fonts in `index.html`.
- The number stack `--typography-number-fontfamily` references the commercial **Neue Haas Grotesk Display Pro** (not licensed in this repo), so it falls back to `var(--font-dm-sans, var(--font-geist-sans))`/sans-serif as intended by the token definition.
- Type utilities `.type-display-* / headline-* / title-* / body-* / label-*` map 1:1 to tokens with `tabular-nums` for the number utilities.
- Used on: auth titles/subtitles, dashboard headings/body, stat values (number font), table numeric cells, code input.

## 6. Light / dark mode

- Dark mode is `:root.dark` on `<html>`, driving all role swaps and shadow overrides from the tokens.
- `useTheme` hook (`client/src/hooks/useTheme.js`) persists choice to `localStorage["theme"]`, defaults to `prefers-color-scheme`, toggles the class, and sets `color-scheme`.
- A tiny inline script in `client/index.html` applies the dark class **before paint** to prevent a flash of the wrong theme.
- `ThemeToggle` (global floating control) is mounted once in `App.jsx`; the showcase embeds an inline instance in its nav.

## 7. Component architecture

Reusable, presentational components in `client/src/components/ui/`:

| Component | File | Variants |
|---|---|---|
| Button | `Button.jsx` | primary, secondary, tertiary, error, outline, ghost; sm; block; disabled; loading spinner |
| Input | `Input.jsx` | default, filled, code; label, hint, error (aria wiring) |
| Card | `Card.jsx` | default, outlined, elevated, interactive |
| Badge | `Badge.jsx` | neutral, info, success, warning, error |
| Alert | `Alert.jsx` | info, success, warning, error; optional title |
| Dialog | `Dialog.jsx` | Escape-to-close, overlay-click close, focus management, `aria-modal` |
| Table | `Table.jsx` | `Table/Thead/Tbody/Tr/Th/Td` primitives; numeric cells use number font |
| Progress | `Progress.jsx` | determinate, indeterminate (`aria-valuenow` etc.) |
| Skeleton | `Skeleton.jsx` | shimmer block |
| EmptyState | `EmptyState.jsx` | icon/title/description/actions |
| Stat | `Stat.jsx` | label + number-font value + caption |
| StatusIndicator | `StatusIndicator.jsx` | neutral, info, success, warning, error dots |
| ThemeToggle | `ThemeToggle.jsx` | floating or inline; icon + label |

Plus `client/src/hooks/useTheme.js`. No component contains raw colours, fonts, or spacing values — every style comes from tokens.

## 8. Application refactor (components in use)

All six pages now use the design system while preserving business logic **exactly**:

- **Signin/Signup/Forgot/Reset/Verify**: `Card + Input + Button + Alert`, `aria-invalid`/`aria-describedby` error wiring, remaining Zod v3 `result.error.flatten().fieldErrors` behaviour, original flow (signup → `/verify`, signin `needsVerification` → `/verify`, 60-second resend cooldown, token-gated reset).
- **Dashboard**: header + Badge (verified) + Stat cards + Account `Card` (email, status indicator) + sign-out button; date value uses number typography semantics.
- `client/src/components/Field.jsx` (old input wrapper) and `client/src/styles.css` are **deleted**.

## 9. Showcase page

`client/src/pages/DesignSystemPage.jsx`, route `/design-system` (unauthenticated, linked from the top nav), previews:
- Colour role swatches (rendered from role variables, incl. success extension and dark mode).
- Full typography samples + number utilities.
- Spacing scale, radius chips, elevation (all three shadow tokens).
- Every component and variant (buttons, inputs, cards, badges, alerts, status indicators, dialog, table, progress, skeleton, empty state, stats).

## 10. Hardcoded styling removed

- All author-facing colour/font/spacing literals are gone from `client/src`. Raw hex values exist **only** inside `tokens.css` (as provided) and the documented extensions in `themes.css`.
- Old `client/src/styles.css` and `Field.jsx` deleted; no residual references (verified by grep).

## 11. Accessibility

- Keyboard-visible `:focus-visible` rings using role tokens (button, input, global).
- Inputs: `label htmlFor`, `aria-invalid`, `aria-describedby` on error/hint.
- Dialog: `role=dialog`, `aria-modal`, labelled by id, focus move to panel, Escape close.
- Buttons/inputs communicate disabled/loading via `aria-disabled`/`disabled`.
- Progress: `role=progressbar` with `aria-valuemin/max/now` (or indeterminate).
- Status indicator dots paired with text labels (not colour-only).
- `prefers-reduced-motion` respected globally.
- Semantic HTML throughout (section/header/main/nav/table).

## 12. Responsiveness

- Fluid layout primitives (`min(100%, Nrem)` inside `auth-screen`, `dashboard-wrap`); `auto-fit`/`auto-fill` grids for stats, swatches, shadows; table in an `overflow-x:auto` wrapper; single-column collapse at `40rem`.

## 13. Functionality preserved

All auth endpoints, session handling, validation, navigation, verify/resend cooldown, and the protected/redirect guards are unchanged. `npm run build` passes; `npm run dev` stack serves the app; `/`, `/design-system`, `/src/*` module transforms, and `/api/health` all return correctly. (Full E2E auth flow was previously verified against this same backend in this repository's setup phase.)

## 14. Files created

```
client/src/styles/tokens.css
client/src/styles/themes.css
client/src/styles/typography.css
client/src/styles/globals.css
client/src/styles/components.css
client/src/hooks/useTheme.js
client/src/components/ui/Button.jsx
client/src/components/ui/Input.jsx
client/src/components/ui/Card.jsx
client/src/components/ui/Badge.jsx
client/src/components/ui/Alert.jsx
client/src/components/ui/Dialog.jsx
client/src/components/ui/Table.jsx
client/src/components/ui/Progress.jsx
client/src/components/ui/Skeleton.jsx
client/src/components/ui/EmptyState.jsx
client/src/components/ui/Stat.jsx
client/src/components/ui/StatusIndicator.jsx
client/src/components/ui/ThemeToggle.jsx
client/src/pages/DesignSystemPage.jsx
```

## 15. Files modified

```
client/index.html                        (DM Sans fonts, pre-paint theme script)
client/src/main.jsx                      (imports the 5-layer CSS stack)
client/src/App.jsx                       (global ThemeToggle + /design-system route)
client/src/pages/SigninPage.jsx
client/src/pages/SignupPage.jsx
client/src/pages/ForgotPage.jsx
client/src/pages/ResetPage.jsx
client/src/pages/VerifyPage.jsx
client/src/pages/DashboardPage.jsx
```

## 16. Files deleted

```
client/src/styles.css
client/src/components/Field.jsx
```

## 17. Known / unresolved issues

- **Neue Haas Grotesk Display Pro** is referenced by the tokens but is a self-hosted commercial font not present in this repo; numbers fall back to DM Sans. Installing/licensing the webfont and adding `@font-face` will activate it with no code changes.
- The source token file uses the typo `--colour-roles-seconadry-container` verbatim; it is currently unused by UI (secondary buttons use `--colour-roles-secondary`). Note for upstream generation.
- Google Fonts requires network access; offline the local fallback stack is used. No app breakage.
- The success palette is an extension (see item 4); if the team later supplies official success tokens, swap them in `themes.css`.

## 18. Recommendations

- License and self-host Neue Haas Grotesk Display Pro, then map it via the existing `--typography-number-*` tokens (no source changes needed).
- Consider breaking `components.css` into per-component files for very large teams; the layer is currently one file for cohesion.
- Add the success/status tokens to the upstream design-tokens export so the extension in `themes.css` can be removed.
- Ensure DM Sans weights (400/500/600/700 for the 9–40 optical size) are what the tokens require; the current Google Fonts request covers them.
- Future components must consume the same tokens/classes — treat `tokens.css` and `components.css` as the only styling surface.