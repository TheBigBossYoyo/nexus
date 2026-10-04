# NEXUS UI design system (0.3)

Light, calm, dense where it matters. One restrained accent, hairline borders, one elevation. Tokens live in
`src/renderer/src/styles.css`; primitives in `src/renderer/src/components/ui/*`.

## Principles

- Text first. State is text plus a shape or icon; colour is never the only signal.
- No neon, no gradients, no glass, no heavy shadows, no large radii, no constant animation.
- Sentence-case labels. Small quiet group labels only where they help scanning (navigation groups, table headers).
- Provenance is visible: a number from Claude says whether it is Exact, Observed, Estimated or Unknown.

## Tokens

Light is the default (`:root`); dark overrides the same variables under `[data-theme='dark']`.
Every text token passes WCAG AA (4.5:1) on `background`, `surface`, `surface-muted` and `surface-hover`, and every
status colour passes on its own `-subtle` tint (measured: lowest light pair 4.79, lowest dark pair 5.36).

| Token (Tailwind colour) | Light | Dark |
|---|---|---|
| `background` | `#f6f7f9` | `#0d0f12` |
| `surface` | `#ffffff` | `#14171b` |
| `surface-elevated` | `#ffffff` | `#1b1f25` |
| `surface-muted` | `#f2f3f5` | `#191c21` |
| `surface-hover` | `#eaecef` | `#232830` |
| `border` | `#e4e6ea` | `#262b32` |
| `border-strong` | `#cdd1d8` | `#373e48` |
| `text-primary` | `#15181d` | `#e8eaed` |
| `text-secondary` | `#444b57` | `#b4bac4` |
| `text-muted` | `#5b6370` | `#959ca8` |
| `accent` / `accent-hover` | `#4f46e5` / `#4338ca` | `#8e94ff` / `#a4a9ff` |
| `accent-subtle` | `#eeeffd` | `#1f2142` |
| `accent-fg` (text on accent) | `#ffffff` | `#0d0f12` |
| `focus-ring` | `#4f46e5` | `#a4a9ff` |
| `success` / `-subtle` | `#17743f` / `#e6f4ec` | `#4fc08a` / `#12261c` |
| `warning` / `-subtle` | `#8f5200` / `#fcf1dc` | `#e9a94a` / `#2a2110` |
| `danger` / `-subtle` | `#be2230` / `#fcebed` | `#ff7a82` / `#2c1417` |
| `info` / `-subtle` | `#1b5eb8` / `#e7f0fb` | `#6aa8f5` / `#12202f` |
| `scrim` | `rgb(16 18 24 / .30)` | `rgb(0 0 0 / .55)` |

Usage: `bg-surface`, `text-text-secondary`, `border-border-strong`, `bg-accent-subtle`, `text-danger`.

State families for `lib/status.ts` (`tone-*` and `tone-*-subtle`): neutral, active (info), waiting (warning),
review (purple `#6b3fbf`), success, danger, warning (orange `#b4410b`).

### Legacy aliases

Kept so older views stay on the palette. New code uses the semantic names.

`surface-0` = background, `surface-1` = surface, `surface-2` = surface-muted, `surface-3` = surface-hover,
`fg` = text-primary, `fg-muted` = text-secondary, `fg-faint` = text-muted, `tone-*` as above.

## Type

System stack: Segoe UI Variable, Segoe UI, system-ui. Mono: Cascadia Mono / Code, Consolas. Nothing is downloaded.
Sizes are rem on a 13 px root, so the Settings font-size slider scales everything.

| Class | Size | Use |
|---|---|---|
| `text-title` | 18 px, 600 | page title (PageHeader only) |
| `text-heading` | 13 px, 600 | section and card headings |
| `text-body` | 13 px | body |
| `text-small` | 12 px | secondary text, hints |
| `text-caption` | 11 px | table headers, labels, badges |
| `text-code` + `font-mono` | 12 px | paths, ids, branches |
| `tnum` | | tabular figures for numbers and tables |

## Spacing, radii, elevation

- `--spacing: 4px`: `p-1` = 4, `p-2` = 8, `p-3` = 12, `p-4` = 16, `p-6` = 24.
- Radii: 4 (`rounded-sm`), 6 (`rounded-md`: controls), 8 (`rounded-lg`: cards, dialogs). Pills only for switches and dots.
- One elevation, `shadow-elevated`, for popovers, menus, dialogs, drawers and toasts. Cards and panels are flat with a hairline border.

## Density

`data-density` on the root. Tokens: `--row-h`, `--control-h`, `--pad-x`, `--pad-y`.
Compact (default): 28 px rows and controls. Comfortable: 34 px. `applyAppearance` sets theme, density and font size.

## Motion

120 to 180 ms, decelerating (`--ease-out`): navigation width, popover and dialog fade (`anim-pop`, `anim-fade`),
drawer slide (`anim-slide`), tab and hover colour, progress width. Spinners and skeletons use `motion-safe:`.
`prefers-reduced-motion: reduce` disables every transition and animation globally. Nothing pulses; the quota banner is static.

## Accessibility

- `:focus-visible` shows a 2 px `focus-ring` outline on everything.
- Real `button`, `label`, `select`, `input type=checkbox`. Toggle is `role="switch"`. Tabs are `role="tablist"` with arrow keys;
  SegmentedControl is a `radiogroup`.
- Dialog and Drawer: `role="dialog" aria-modal`, labelled by their title, focus trapped, Esc closes, focus returns to the opener.
- `role="status"` on live status text (usage indicator, quota banner, overnight state). `aria-current="page"` on navigation.
- Icon-only buttons require `label`.

## Components

| Component | Notes |
|---|---|
| `Button` | `variant`: primary, secondary (= default), ghost, danger. `size`: sm (24 px), md (density height). `loading`, `icon`. |
| `IconButton` | `label` required. Same variants, `size` sm/md. |
| `Badge`, `StatusBadge`, `StatusText`, `StatusDot` | Quiet tinted background plus text. Dot is decoration; text is the signal. |
| `Tabs` | Underline tabs. |
| `SegmentedControl` | 2 to 5 exclusive choices: `options`, `value`, `onChange`, `label`. |
| `Panel` | Bordered container with a 36 px titled header. |
| `Card` | Flat, hairline border. `title`, `description`, `actions`. |
| `Section` | Unframed heading plus content. |
| `PageHeader` | `title`, `context`, `actions`, `status`. Renders the global status cluster and global banners from the shell. |
| `DataTable` | Dense, no zebra, sticky header, `numeric` columns, keyboard-activatable rows. |
| `Dialog`, `ConfirmDialog`, `Drawer` | Scrim, elevation, focus trap. |
| `Popover` | Portal, fixed position, closes on Esc and outside press. |
| `Tooltip` | CSS only, hover and focus. Never for essential information. |
| `Input`, `Textarea`, `Select` (native), `Toggle`, `NumberField`, `Field` | Native semantics are preserved (`selectOption`, `.check()`). |
| `EmptyState`, `Loading`, `Skeleton`, `ErrorNote`, `Notice` | Calm states; Notice has a tint, a thin bar and primary-coloured text. |
| `KeyValue`, `CodeBlock`, `InlineCode`, `Kbd` | |
| `Stat` | Label, value, optional provenance and hint. |
| `ProgressBar` | Determinate only. |
| `SourceLabel` | Exact / Observed / Estimated / Unknown with tooltip. |
| `MeasuredValue` | Renders a `Measured<T>`. |

## Status and colour rules

- Run, task and agent states come from `lib/status.ts`. Use `StatusBadge` in tables, `StatusText` in dense lists.
- Green = completed or available. Amber = waiting on a person or on time. Orange = degraded. Red = failed or blocked by an error.
  Indigo is only for selection and primary actions. Blue = active work.
- A coloured fill is always tinted (`-subtle`); the saturated colour is used for text, a 1.5 px dot or a 4 px bar.

## Usage provenance rules

`Measured<T>` carries `confidence` (EXACT, OBSERVED, ESTIMATED, UNKNOWN) and `source`.

- A percentage or a progress bar may be shown only when `confidence === 'EXACT'` and the value is a finite number.
  `MeasuredValue` enforces this (`percent` and `progress` props degrade to the unknown state otherwise); `canShowPercent` and
  `describeMeasured` in `lib/measured.ts` are the tested rules.
- Observed token counts never get a denominator. NEXUS never shows a "remaining" figure it did not receive.
- UNKNOWN renders as an em dash plus a short reason ("Not reported by Claude"), muted and deliberate, never as an error.
- A reset countdown is shown only for an EXACT reset time. Without one the text says the reset is not reported and shows the next planned check.
- Every number from Claude sits next to a `SourceLabel`.

## Shell

Left navigation 220 px, or a 52 px icon rail (Ctrl+B, persisted). Groups: Workspace, Intelligence, System. Ctrl+1 to Ctrl+9 open
the first nine items. Bottom: Claude status (opens the usage popover), app version, collapse toggle. Each page renders a
`PageHeader`; views without one get a default from `ViewRouter`. Global status (Claude, Agents, Run, Overnight, Git, Approvals,
palette) lives at the right of the header; lower-priority items hide below 960 px of header width. Banners (quota, approvals,
authentication) render directly under the header.

## Adding a page

```tsx
<div className="flex h-full min-h-0 flex-col" data-testid="foo-view">
  <PageHeader title="Foo" context="Intelligence" actions={<Button size="sm">Do it</Button>} />
  <div className="min-h-0 flex-1 overflow-auto p-6">…</div>
</div>
```

Then add the id to `store/views.ts`, `app/nav.ts` (items, meta, own-header list) and `ViewRouter`.
