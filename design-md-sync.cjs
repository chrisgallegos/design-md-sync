#!/usr/bin/env node
/**
 * design-md-sync
 *
 * Converts a CSS custom properties file into a DESIGN.md file compatible
 * with the @google/design.md linter and specification.
 *
 * Design MD has no CSS importer — it only exports. This script fills that gap,
 * letting you validate an existing token system without migrating to a new format.
 *
 * Features:
 *   - Auto-discovers hex color tokens from :root and an optional dark selector
 *   - Infers component color pairs from naming convention (--foo + --foo-foreground)
 *   - Extracts spacing, radius, and typography scales from standard token patterns
 *   - Skips unsupported color formats (oklch, rgba, hsl) and reports them clearly
 *   - --check mode: detects drift between CSS and committed DESIGN.md (CI/pre-commit)
 *   - --watch mode: auto-regenerates DESIGN.md whenever the CSS file changes
 *   - --install-hook: wires --check into your git pre-commit hook in one command
 *
 * Usage:
 *   node design-md-sync.cjs [options]
 *
 * Options:
 *   --input   <path>    CSS file to read         (default: src/styles/theme.css)
 *   --output  <path>    DESIGN.md file to write  (default: DESIGN.md)
 *   --name    <string>  Design system name       (default: My Design System)
 *   --desc    <string>  One-line description     (optional)
 *   --dark    <string>  Dark mode selector       (default: .dark)
 *   --font-body    <string>  Body font family    (optional)
 *   --font-heading <string>  Heading font family (optional)
 *   --check             Drift detection mode — exits 1 if DESIGN.md is stale
 *   --watch             Watch mode — auto-regenerates on CSS file change
 *   --install-hook      Installs --check as a git pre-commit hook
 *   --help              Show this help message
 *
 * MIT License — https://github.com/chrisgallegos/design-md-sync
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
design-md-sync — convert, validate, and keep your DESIGN.md in sync

Usage:
  node design-md-sync.cjs [options]

Options:
  --input   <path>    CSS file to read         (default: src/styles/theme.css)
  --output  <path>    DESIGN.md file to write  (default: DESIGN.md)
  --name    <string>  Design system name       (default: My Design System)
  --desc    <string>  One-line description
  --dark    <string>  Dark mode CSS selector   (default: .dark)
  --font-body    <string>  Body font family
  --font-heading <string>  Heading font family
  --check             Drift detection — exits 1 if DESIGN.md is stale
  --watch             Auto-regenerate on CSS file change
  --install-hook      Install --check as a git pre-commit hook
  --help              Show this message
`);
  process.exit(0);
}

const getArg = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const INPUT        = getArg('--input',        'src/styles/theme.css');
const OUTPUT       = getArg('--output',       'DESIGN.md');
const NAME         = getArg('--name',         'My Design System');
const DESC         = getArg('--desc',         '');
const DARK_SEL     = getArg('--dark',         '.dark');
const FONT_BODY    = getArg('--font-body',    null);
const FONT_HEADING = getArg('--font-heading', null);
const MODE_CHECK   = args.includes('--check');
const MODE_WATCH   = args.includes('--watch');
const MODE_HOOK    = args.includes('--install-hook');
const ROOT         = process.cwd();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isHex = (v) => /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim());
const isDim = (v) => /^[\d.]+\s*(px|em|rem)$/.test(v.trim());
const isNum = (v) => /^[\d.]+$/.test(v.trim());

const COLOR_LIKE = /^(#|oklch|rgba?|hsla?|color-mix|transparent)/i;

function skipReason(value) {
  if (value.startsWith('oklch'))     return 'oklch() — not yet supported by Design MD';
  if (value.startsWith('rgba'))      return 'rgba() — not yet supported by Design MD';
  if (value.startsWith('rgb'))       return 'rgb() — not yet supported by Design MD';
  if (value.startsWith('hsl'))       return 'hsl() — not yet supported by Design MD';
  if (value.startsWith('color-mix')) return 'color-mix() — not yet supported by Design MD';
  if (value === 'transparent')       return 'transparent — no hex equivalent';
  return null;
}

function parseBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's');
  const match = css.match(re);
  if (!match) return {};
  const tokens = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*;/);
    if (m) tokens[m[1]] = m[2];
  }
  return tokens;
}

function parseThemeBlock(css) {
  const re = /@theme(?:\s+\w+)?\s*\{([^}]+)\}/gs;
  const tokens = {};
  let match;
  while ((match = re.exec(css)) !== null) {
    for (const line of match[1].split('\n')) {
      const m = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*;/);
      if (m) tokens[m[1]] = m[2];
    }
  }
  return tokens;
}

function inferFontFamilies(theme) {
  const families = {};
  for (const [k, v] of Object.entries(theme)) {
    if (k.startsWith('--font-family-')) {
      const name = k.replace('--font-family-', '');
      families[name] = v.replace(/['"]/g, '').trim();
    }
  }
  return families;
}

function yamlStr(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'object' && v !== null) {
      return `${pad}${k}:\n${yamlStr(v, indent + 1)}`;
    }
    const needsQuotes = typeof v === 'string' && !isNum(v) && !isDim(v);
    return `${pad}${k}: ${needsQuotes ? `"${v}"` : v}`;
  }).join('\n');
}

// ─── Core generator — returns { content, stats } without touching disk ────────

function generate() {
  const cssSource = fs.readFileSync(path.join(ROOT, INPUT), 'utf8');

  const light = parseBlock(cssSource, ':root');
  const dark  = parseBlock(cssSource, DARK_SEL);
  const theme = parseThemeBlock(cssSource);
  const fontFamilyList = Object.values(inferFontFamilies(theme));

  const skippedLight = [];
  const skippedDark  = [];
  const colors       = {};
  const colorsDark   = {};

  for (const [cssVar, value] of Object.entries(light)) {
    const tokenName = cssVar.slice(2);
    if (isHex(value)) {
      colors[tokenName] = value.trim();
    } else if (COLOR_LIKE.test(value)) {
      const reason = skipReason(value);
      if (reason) skippedLight.push({ name: cssVar, value, reason });
    }
  }

  for (const [cssVar, value] of Object.entries(dark)) {
    const tokenName = `dark.${cssVar.slice(2)}`;
    if (isHex(value)) {
      colorsDark[tokenName] = value.trim();
    } else if (COLOR_LIKE.test(value)) {
      const reason = skipReason(value);
      if (reason) skippedDark.push({ name: cssVar, value, reason });
    }
  }

  const allColors  = { ...colors, ...colorsDark };
  const components = {};

  const addPair = (name, bgKey, textKey) => {
    if (allColors[bgKey] && allColors[textKey]) {
      components[name] = {
        backgroundColor: `{colors.${bgKey}}`,
        textColor:       `{colors.${textKey}}`,
      };
    }
  };

  for (const t of Object.keys(colors)) {
    if (!t.endsWith('-foreground') && colors[`${t}-foreground`]) addPair(t, t, `${t}-foreground`);
  }
  for (const t of Object.keys(colorsDark)) {
    if (!t.endsWith('-foreground') && colorsDark[`${t}-foreground`]) addPair(t, t, `${t}-foreground`);
  }

  const resolveBodyFont    = FONT_BODY    || fontFamilyList[1] || fontFamilyList[0] || 'sans-serif';
  const resolveHeadingFont = FONT_HEADING || fontFamilyList[0] || 'sans-serif';

  const typography = {};
  const typoScales = [
    { key: 'heading', sizeVar: '--font-size-xl',  weightVar: '--font-weight-bold',    lhVar: '--line-height-base', family: resolveHeadingFont },
    { key: 'body',    sizeVar: '--font-size-base', weightVar: '--font-weight-regular', lhVar: '--line-height-base', family: resolveBodyFont    },
    { key: 'small',   sizeVar: '--font-size-sm',   weightVar: '--font-weight-regular', lhVar: '--line-height-sm',   family: resolveBodyFont    },
  ];
  for (const { key, sizeVar, weightVar, lhVar, family } of typoScales) {
    const fontSize   = light[sizeVar];
    const fontWeight = light[weightVar];
    const lineHeight = light[lhVar];
    if (fontSize && isDim(fontSize)) {
      typography[key] = {
        fontFamily: family,
        fontSize,
        ...(fontWeight && isNum(fontWeight) ? { fontWeight: Number(fontWeight) } : {}),
        ...(lineHeight && isNum(lineHeight) ? { lineHeight: Number(lineHeight) } : {}),
      };
    }
  }

  const spacing = {};
  for (const [cssVar, value] of Object.entries(light)) {
    if ((cssVar.startsWith('--space-') || cssVar.startsWith('--spacing-')) && isDim(value)) {
      spacing[cssVar.replace(/^--spacing?-/, '')] = value;
    }
  }

  const rounded = {};
  for (const [cssVar, value] of Object.entries(light)) {
    if (cssVar.startsWith('--radius') && isDim(value)) {
      const key = cssVar === '--radius' ? 'default' : cssVar.replace('--radius-', '');
      rounded[key] = value;
    }
  }
  if (rounded.default && !rounded.full) rounded.full = '9999px';

  const frontmatterParts = [
    '---',
    'version: alpha',
    `name: ${NAME}`,
    ...(DESC ? [`description: ${DESC}`] : []),
  ];
  if (Object.keys(allColors).length)  frontmatterParts.push('colors:',     yamlStr(allColors, 1));
  if (Object.keys(typography).length) frontmatterParts.push('typography:', yamlStr(typography, 1));
  if (Object.keys(spacing).length)    frontmatterParts.push('spacing:',    yamlStr(spacing, 1));
  if (Object.keys(rounded).length)    frontmatterParts.push('rounded:',    yamlStr(rounded, 1));
  if (Object.keys(components).length) frontmatterParts.push('components:', yamlStr(components, 1));
  frontmatterParts.push('---');

  const markdown = `
# ${NAME}

## Overview

Generated by design-md-sync from \`${INPUT}\`.

## Colors

Hex color tokens extracted from \`${':root'}\`${DARK_SEL !== '.dark' ? '' : ` and \`${DARK_SEL}\``}. Tokens using \`oklch()\`, \`rgba()\`, or other color spaces unsupported by Design MD are excluded and reported at conversion time.

## Typography

Scales derived from \`--font-size-*\`, \`--font-weight-*\`, and \`--line-height-*\` custom properties.

## Layout

Spacing derived from \`--space-*\` custom properties. Radius derived from \`--radius*\` custom properties.

## Components

Color pair mappings inferred from the \`--token\` / \`--token-foreground\` naming convention. Used by the Design MD linter for WCAG AA contrast validation.
`;

  const content = frontmatterParts.join('\n') + '\n' + markdown;

  const stats = {
    colors:     Object.keys(allColors).length,
    pairs:      Object.keys(components).length,
    typography: Object.keys(typography).length,
    spacing:    Object.keys(spacing).length,
    radius:     Object.keys(rounded).length,
    skipped:    [
      ...skippedLight.map(s => ({ ...s, mode: 'light' })),
      ...skippedDark.map(s  => ({ ...s, mode: 'dark'  })),
    ],
  };

  return { content, stats };
}

// ─── Drift summary — which YAML sections changed ──────────────────────────────

function driftSummary(fresh, current) {
  const freshLines   = fresh.split('\n');
  const currentLines = current.split('\n');
  const added   = freshLines.filter(l => !currentLines.includes(l));
  const removed = currentLines.filter(l => !freshLines.includes(l));

  const sections = ['colors', 'typography', 'spacing', 'rounded', 'components'];
  const changed = sections.filter(s => {
    const inAdded   = added.some(l   => l.trim().startsWith(s + ':') || l.includes(`  ${s}.`) || l.includes(`  ${s}-`));
    const inRemoved = removed.some(l => l.trim().startsWith(s + ':') || l.includes(`  ${s}.`) || l.includes(`  ${s}-`));
    return inAdded || inRemoved;
  });

  return { added: added.length, removed: removed.length, sections: changed };
}

// ─── Mode: --install-hook ─────────────────────────────────────────────────────

if (MODE_HOOK) {
  const hookDir  = path.join(ROOT, '.git', 'hooks');
  const hookPath = path.join(hookDir, 'pre-commit');

  if (!fs.existsSync(hookDir)) {
    console.error('✗ No .git/hooks directory found. Is this a git repository?');
    process.exit(1);
  }

  const scriptPath = path.relative(ROOT, __filename).replace(/\\/g, '/');
  const nameFlag   = NAME !== 'My Design System' ? ` --name "${NAME}"` : '';
  const inputFlag  = INPUT !== 'src/styles/theme.css' ? ` --input ${INPUT}` : '';
  const outputFlag = OUTPUT !== 'DESIGN.md' ? ` --output ${OUTPUT}` : '';

  const hook = `#!/bin/sh
# DESIGN.md drift check — installed by design-md-sync
# Blocks commits when DESIGN.md is out of sync with your CSS tokens.
# Re-run without --check to regenerate: node ${scriptPath}${nameFlag}${inputFlag}${outputFlag}

node ${scriptPath} --check${nameFlag}${inputFlag}${outputFlag}

if [ $? -ne 0 ]; then
  echo ""
  echo "  To fix: node ${scriptPath}${nameFlag}${inputFlag}${outputFlag}"
  echo ""
  exit 1
fi
`;

  fs.writeFileSync(hookPath, hook, { mode: 0o755 });
  console.log(`\n✓ Pre-commit hook installed at ${path.relative(ROOT, hookPath)}`);
  console.log(`  Commits will be blocked if DESIGN.md is out of sync with ${INPUT}\n`);
  process.exit(0);
}

// ─── Mode: --check ────────────────────────────────────────────────────────────

if (MODE_CHECK) {
  const outputPath = path.join(ROOT, OUTPUT);
  const { content: fresh, stats } = generate();

  if (!fs.existsSync(outputPath)) {
    console.error(`\n✗ ${OUTPUT} does not exist. Run without --check to generate it.\n`);
    process.exit(1);
  }

  const current = fs.readFileSync(outputPath, 'utf8');

  if (fresh === current) {
    console.log(`\n✓ DESIGN.md is current — no drift detected`);
    console.log(`  ${stats.colors} colors · ${stats.pairs} pairs · ${stats.typography} type styles · ${stats.spacing} spacing stops\n`);
    process.exit(0);
  }

  const { added, removed, sections } = driftSummary(fresh, current);
  console.error(`\n✗ DESIGN.md is out of sync with ${INPUT}`);
  if (sections.length) console.error(`  Changed sections: ${sections.join(', ')}`);
  console.error(`  ${added} line(s) added · ${removed} line(s) removed`);
  console.error(`\n  Run: node ${path.relative(ROOT, __filename)} to regenerate\n`);
  process.exit(1);
}

// ─── Mode: --watch ────────────────────────────────────────────────────────────

if (MODE_WATCH) {
  const inputPath  = path.join(ROOT, INPUT);
  const outputPath = path.join(ROOT, OUTPUT);

  if (!fs.existsSync(inputPath)) {
    console.error(`✗ Input file not found: ${INPUT}`);
    process.exit(1);
  }

  const regenerate = () => {
    try {
      const { content, stats } = generate();
      fs.writeFileSync(outputPath, content, 'utf8');
      const t = new Date().toLocaleTimeString();
      console.log(`[${t}] ✓ DESIGN.md updated — ${stats.colors} colors · ${stats.pairs} pairs`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] ✗ Error: ${e.message}`);
    }
  };

  console.log(`\nWatching ${INPUT} for changes — press Ctrl+C to stop\n`);
  regenerate();

  let debounce = null;
  fs.watch(inputPath, { persistent: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(regenerate, 100);
  });

  process.on('SIGINT', () => {
    console.log('\nStopped.\n');
    process.exit(0);
  });
}

// ─── Mode: default — generate and write ───────────────────────────────────────

if (!MODE_CHECK && !MODE_WATCH && !MODE_HOOK) {
  const { content, stats } = generate();
  fs.writeFileSync(path.join(ROOT, OUTPUT), content, 'utf8');

  console.log(`\n✓ DESIGN.md written to ${OUTPUT}\n`);
  console.log(`  Colors mapped:       ${stats.colors}`);
  console.log(`  Component pairs:     ${stats.pairs} (contrast validation targets)`);
  console.log(`  Typography styles:   ${stats.typography}`);
  console.log(`  Spacing stops:       ${stats.spacing}`);
  console.log(`  Radius stops:        ${stats.radius}`);

  if (stats.skipped.length) {
    console.log(`\n⚠  ${stats.skipped.length} token(s) skipped — unsupported color format:`);
    for (const s of stats.skipped) {
      console.log(`     [${s.mode}] ${s.name}: ${s.value}`);
      console.log(`             → ${s.reason}`);
    }
  }

  console.log(`\nRun: npx @google/design.md lint ${OUTPUT}\n`);
}
