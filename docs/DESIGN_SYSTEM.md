# Delta Design System

A calm, precise, premium fintech aesthetic. Light theme, **blue as the single accent**,
generous whitespace, restrained color, and motion that clarifies rather than decorates.
We build on shadcn/Radix **primitives** but every token and component is ours — it should
not read as "default shadcn."

## Design principles

1. **Numbers are the hero.** Financial data uses **tabular figures** and right-aligned
   columns so digits line up. Money never wraps or jitters.
2. **One accent.** Blue carries primary actions and active state. Everything else is a
   refined neutral. Color is information, not decoration.
3. **Quiet surfaces, sharp focus.** Low-contrast borders and soft shadows; contrast is
   spent on what the user must act on.
4. **Density with air.** Tables are compact; pages around them breathe. 8px spacing grid.
5. **Motion with intent.** 150–250ms, ease-out, transform/opacity only. Respects
   `prefers-reduced-motion`. No bounce on functional UI.

## Color tokens (OKLCH)

We use OKLCH for perceptually even ramps and a more deliberate palette than the stock
HSL shadcn set. **Signature primary is a confident, slightly cool azure — not the default
`blue-500`.**

```css
/* packages/ui/src/tokens/colors.css  —  :root (light) */
:root {
  /* Brand — Delta Azure */
  --primary-50:  oklch(0.971 0.014 254.6);
  --primary-100: oklch(0.940 0.030 254.6);
  --primary-200: oklch(0.892 0.058 254.6);
  --primary-300: oklch(0.820 0.094 254.6);
  --primary-400: oklch(0.715 0.140 254.6);
  --primary-500: oklch(0.620 0.182 254.6);   /* ← signature Delta Blue */
  --primary-600: oklch(0.552 0.196 254.6);   /* primary action / hover base */
  --primary-700: oklch(0.488 0.180 254.6);
  --primary-800: oklch(0.420 0.150 254.6);
  --primary-900: oklch(0.360 0.112 254.6);

  /* Neutrals — cool slate (paired to the blue, never pure gray) */
  --neutral-0:   oklch(1     0      0);       /* page can stay near-white */
  --neutral-50:  oklch(0.985 0.003 247);
  --neutral-100: oklch(0.968 0.005 247);
  --neutral-200: oklch(0.928 0.007 247);      /* hairline borders */
  --neutral-300: oklch(0.878 0.009 247);
  --neutral-400: oklch(0.715 0.012 247);      /* muted text */
  --neutral-500: oklch(0.585 0.014 247);
  --neutral-600: oklch(0.475 0.014 247);      /* secondary text */
  --neutral-700: oklch(0.372 0.013 247);
  --neutral-800: oklch(0.279 0.011 247);      /* body text */
  --neutral-900: oklch(0.205 0.010 247);      /* headings */

  /* Semantic (financial) */
  --success-600: oklch(0.585 0.150 152);      /* paid / positive */
  --warning-600: oklch(0.720 0.150 79);       /* due soon / pending */
  --danger-600:  oklch(0.580 0.196 25);       /* overdue / negative */
  --info-600:    var(--primary-600);

  /* Surfaces & semantic aliases */
  --background:    var(--neutral-50);
  --surface:       var(--neutral-0);          /* cards, sheets */
  --surface-muted: var(--neutral-100);
  --border:        var(--neutral-200);
  --border-strong: var(--neutral-300);
  --foreground:        var(--neutral-800);
  --foreground-muted:  var(--neutral-600);
  --foreground-subtle: var(--neutral-400);
  --primary:           var(--primary-600);
  --primary-foreground: var(--neutral-0);
  --ring:              var(--primary-500);

  /* Money semantics */
  --money-positive: var(--success-600);
  --money-negative: var(--danger-600);
  --money-neutral:  var(--foreground);
}
```

> Light theme is the default and the product spec. A dark theme can be added later by
> overriding the same variables under `[data-theme="dark"]` — components reference only
> the semantic aliases, never raw ramp values.

## Typography

```css
:root {
  --font-sans: "Inter", "Inter var", system-ui, sans-serif;       /* UI */
  --font-display: "Inter Display", "Inter", sans-serif;            /* headings */
  --font-mono: "JetBrains Mono", "SF Mono", monospace;            /* codes, IDs */

  /* Numbers: tabular + lining everywhere money appears */
  --num-features: "tnum" 1, "lnum" 1, "cv01" 1;
}
.font-numeric { font-variant-numeric: tabular-nums lining-nums; }
```

- **Type scale** (1.20 ratio, rem): 12 · 14 (base UI) · 16 · 19 · 23 · 28 · 33 · 40.
- Headings use `--font-display` with `letter-spacing: -0.011em` for a tighter, premium set.
- Body line-height 1.5; table rows 1.35. Money cells always `.font-numeric`.
- We **self-host** Inter + JetBrains Mono (no FOUT, no Google CDN dependency).

## Spacing, radius, elevation

```css
:root {
  /* 8px grid (with 2/4 micro-steps) */
  --space-0:0; --space-1:.25rem; --space-2:.5rem; --space-3:.75rem; --space-4:1rem;
  --space-5:1.5rem; --space-6:2rem; --space-8:3rem; --space-10:4rem;

  /* Radius — soft but not pill-y; premium = restrained */
  --radius-sm:.375rem; --radius-md:.5rem; --radius-lg:.75rem; --radius-xl:1rem;

  /* Elevation — soft, low-spread, cool-tinted (not harsh black) */
  --shadow-xs: 0 1px 2px oklch(0.5 0.03 254.6 / .06);
  --shadow-sm: 0 1px 3px oklch(0.5 0.03 254.6 / .08), 0 1px 2px oklch(0.5 0.03 254.6 / .04);
  --shadow-md: 0 4px 12px oklch(0.5 0.03 254.6 / .08), 0 2px 4px oklch(0.5 0.03 254.6 / .04);
  --shadow-lg: 0 12px 32px oklch(0.5 0.03 254.6 / .12);
}
```

Default control radius: `--radius-md`. Cards: `--radius-lg`. Avoid full pills except on
tags/status chips.

## Motion (Framer Motion)

Centralized variants in `packages/ui/src/motion`. Tokens:

```ts
export const motion = {
  duration: { fast: 0.15, base: 0.2, slow: 0.28 },
  ease: { out: [0.16, 1, 0.3, 1], inOut: [0.65, 0, 0.35, 1] }, // custom, not the default
};
```

Usage guide:
- **Page/route transitions:** 12px upward fade-in, 200ms ease-out.
- **Lists/tables:** stagger children 20–30ms on first render only (not on every re-render).
- **Modals/sheets:** scale 0.98→1 + fade; sheets slide from edge, 240ms.
- **Dashboard numbers:** count-up on stat cards (once, on view).
- **Never** animate layout-thrashing properties; transform/opacity only. Always honor
  `prefers-reduced-motion` (variants collapse to instant). See `packages/ui/motion`.

## Tailwind preset

`packages/config/tailwind-preset.ts` maps the CSS variables into Tailwind theme keys so
classes like `bg-surface text-foreground-muted border-border ring-ring` work and stay
token-driven. **No hardcoded hex in components — ever.**

## Core components (`packages/ui`)

Restyled primitives (shadcn/Radix base, Delta skin): `Button` (variants: primary /
secondary / ghost / outline / destructive), `Input`, `Select`, `Combobox`, `Checkbox`,
`Switch`, `Dialog`, `Sheet`, `Popover`, `Tooltip`, `Tabs`, `Badge`, `DropdownMenu`,
`Toast`.

Composed (Delta-specific):
- **`MoneyDisplay`** — formats minor units → currency, tabular, colored by sign.
- **`StatusPill`** — maps invoice/PO/bill statuses to semantic colors consistently.
- **`StatCard`** — KPI with count-up + trend delta.
- **`DataTable`** — TanStack Table wrapper: sticky header, right-aligned money columns,
  column visibility, server pagination, row selection, empty state.
- **`PageHeader`** — title, breadcrumb, primary action slot.
- **`EmptyState`**, **`FilterBar`**, **`DateRangePicker`**, **`CurrencyInput`** (minor-unit
  aware), **`FormField`** (RHF + Zod error wiring).

## App shell

- **Left sidebar:** grouped nav (Sales · Purchases · Banking · Inventory · Reports ·
  People · Settings), collapsible, active item uses primary accent rail.
- **Topbar:** org switcher, global search (⌘K command palette), notifications
  (socket-driven), user menu.
- **Command palette:** quick nav + quick-create (new invoice/expense/customer).

## Accessibility

- WCAG AA contrast on text (verify the OKLCH neutrals against surfaces in CI).
- Radix primitives give us focus management + ARIA; never strip focus rings (`--ring`).
- Full keyboard support on tables and the command palette.
- All motion gated by `prefers-reduced-motion`.

## What makes it *not* look AI-generated

- A bespoke OKLCH palette (cool-slate neutrals, one disciplined azure) — not the stock
  shadcn zinc+blue.
- Tabular numerals and right-aligned money columns throughout — the fintech tell.
- Soft, cool-tinted shadows and hairline borders instead of heavy cards.
- A custom easing curve and sparse, purposeful motion.
- Display vs. UI font split with tightened heading tracking.
