# css-to-design-md

Convert a CSS custom properties file into a [DESIGN.md](https://github.com/google-labs-code/design.md) file — compatible with Google's open-source design system linter and spec.

---

## The problem

[Design MD](https://github.com/google-labs-code/design.md) by Google Labs is a format spec and CLI that validates design tokens, checks schema integrity, and runs WCAG AA contrast checks against component color pairs. It's genuinely useful.

But it has no CSS importer. It only exports.

If you have an existing token system — a `theme.css`, a Tailwind config, a shadcn setup — there's no first-party path to adopting Design MD's linting without starting from scratch in their YAML format.

This script fills that gap.

---

## What it does

- Reads any CSS custom properties file (`:root` + optional dark selector)
- Auto-discovers hex color tokens
- Infers component color pairs from the `--token` / `--token-foreground` naming convention
- Extracts spacing, border-radius, and typography scales from standard token patterns
- Reports skipped tokens (oklch, rgba, hsl) clearly — does not silently drop them
- Outputs a valid `DESIGN.md` file ready for `npx @google/design.md lint`

---

## Install

No install needed — it's a single Node.js script with zero dependencies.

```bash
curl -O https://raw.githubusercontent.com/chrisgallegos/css-to-design-md/main/css-to-design-md.cjs
# or just download the file
```

---

## Usage

```bash
node css-to-design-md.cjs [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--input` | `src/styles/theme.css` | Path to your CSS file |
| `--output` | `DESIGN.md` | Path to write the DESIGN.md file |
| `--name` | `My Design System` | Design system name |
| `--desc` | *(none)* | One-line description |
| `--dark` | `.dark` | CSS selector for dark mode tokens |
| `--font-body` | *(auto)* | Body font family |
| `--font-heading` | *(auto)* | Heading font family |
| `--help` | | Show usage |

### Basic example

```bash
node css-to-design-md.cjs \
  --input src/styles/theme.css \
  --name "Acme Design System" \
  --desc "Brand token system — light/dark, semantic color model."
```

### Then lint

```bash
npx @google/design.md lint DESIGN.md
```

---

## Token discovery

### Colors

All CSS custom properties with hex values (`#rrggbb`, `#rgb`, `#rrggbbaa`) are extracted from `:root` and the dark selector. Tokens using `oklch()`, `rgba()`, `hsl()`, or other color spaces are skipped and reported in the console output.

```css
/* Extracted */
--primary: #00875a;
--primary-foreground: #ffffff;

/* Skipped — reported clearly */
--ring: oklch(0.708 0 0);
--border: rgba(0, 0, 0, 0.15);
```

### Component pairs (contrast validation)

Pairs are inferred by the `--x` / `--x-foreground` naming convention. Each valid pair becomes a component entry that Design MD uses for WCAG AA contrast checking.

```css
--primary: #00875a;           /* → component: primary */
--primary-foreground: #ffffff; /*   backgroundColor + textColor */
```

If both tokens resolve to hex, the pair is included. If either is skipped (oklch, rgba), the pair is excluded from contrast validation — and that's noted in the output.

### Spacing

Tokens matching `--space-*` or `--spacing-*` with `px`, `em`, or `rem` values are extracted into the `spacing` block.

### Border radius

Tokens matching `--radius*` with dimension values are extracted into the `rounded` block.

### Typography

Scales are derived from `--font-size-*`, `--font-weight-*`, and `--line-height-*` token patterns. Font families are pulled from `@theme` blocks (Tailwind v4 syntax) or set via `--font-body` / `--font-heading` flags.

---

## Example output

```yaml
---
version: alpha
name: Acme Design System
description: Brand token system — light/dark, semantic color model.
colors:
  primary: "#00875a"
  primary-foreground: "#ffffff"
  background: "#ffffff"
  foreground: "#0a1514"
  dark.primary: "#00ffa3"
  dark.primary-foreground: "#000000"
typography:
  heading:
    fontFamily: "Pathway Extreme, sans-serif"
    fontSize: 1.5rem
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "Onest, sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
spacing:
  xs: 0.25rem
  sm: 0.5rem
  md: 1rem
  lg: 1.5rem
  xl: 2rem
rounded:
  default: 0.5rem
  full: 9999px
components:
  primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
  dark.primary:
    backgroundColor: "{colors.dark.primary}"
    textColor: "{colors.dark.primary-foreground}"
---
```

---

## Wiring into your pipeline

Add to your `package.json`:

```json
"scripts": {
  "tokens:extract": "node scripts/extract-tokens.cjs",
  "tokens:lint": "node scripts/css-to-design-md.cjs --name \"My System\" && npx @google/design.md lint DESIGN.md",
  "tokens": "npm run tokens:extract && npm run tokens:lint"
}
```

Run with:

```bash
npm run tokens
```

---

## Known limitations

**oklch, rgba, hsl** — Design MD only accepts hex colors (sRGB). Any token using a different color space is skipped and logged. This is a limitation of Design MD's current alpha spec, not this script. Affected tokens are clearly reported so you know exactly what's not being validated.

**Contrast validation scope** — WCAG contrast checks only run on component pairs you have defined (inferred via naming convention). Tokens that don't follow the `--x` / `--x-foreground` pattern won't generate pairs, and won't be contrast-checked.

**Dark mode detection** — dark tokens are extracted from a single selector (default `.dark`). If your project uses `[data-theme="dark"]`, `@media (prefers-color-scheme: dark)`, or another approach, pass the correct selector via `--dark`.

---

## Background

This script was built while integrating Design MD into a live design system at [gallegosdesigns.com](https://gallegosdesigns.com). The implementation process — including this gap, the decision to hold on oklch adoption, and the first-run lint results — is documented on the [design system page](https://gallegosdesigns.com/design-system).

---

## License

MIT — use it, fork it, improve it.
