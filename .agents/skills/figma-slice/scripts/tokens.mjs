#!/usr/bin/env node
// Token Map + tokens.css generator.
//
// Library:
//   createTokenMap({ rules, aliases }).resolve(figmaPath)  → Token name | null
//   buildTokens({ tokenMap, modes, statics, live, relumeCss, liveColors?, exportColors? })
//     → { ok, stops, css, tokens, report: { same, differs, onlyHere, unmapped, stale, conflicts } }
//     ok is false (css null) when export colors differ from live get_variable_defs or two Figma Variables
//     give one Token different values: stop and ask the user (`stops` says why). Once the user decided:
//     liveColors (--live-colors) takes stale colors from live (colors are single-mode, so the live value is
//     reliable); exportColors (--export-colors) keeps the export's. Both still list them in `stale`.
//     Non-color live Variables missing from the exports are reported in `stale` without stopping.
//   readTokenModes(collection.json | dir), flattenExport(json)  Variables exports, both formats (see Inputs).
//   cssBlocks(css), effectiveVars(blocks, breakpoint, pins?), canon(value)  CSS custom-property reader.
// CLI: node tokens.mjs --map <token-map.json> --modes <collection.json|dir of *.tokens.json> --static <file.json>
//        --relume <webflow.css> --out <tokens.css> [--report <report.json>] [--live-colors|--export-colors] <nodeId...>
//      nodeIds are queried with get_variable_defs (cached, env as in mcp.mjs) for the stale check and the
//      letter-spacing of text styles. Exit 1 on stop, 2 on usage.
//
// tokens.css: every Token in `body`; Tokens whose value differs between Token Modes again in each
// Breakpoint's max-width block. Mode Pin: `.u-mode-<mode>` sits next to `body` in that mode's block,
// so it keeps the mode at narrower Breakpoints (only `.u-mode-tablet` today: desktop is the base,
// mobile the narrowest).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, textOf } from './mcp.mjs';

export const BREAKPOINTS = [
  { breakpoint: 'desktop', maxWidth: null },
  { breakpoint: 'tablet', maxWidth: 991 },
  { breakpoint: 'mobile', maxWidth: 767 },
];

// Figma path → Relume Token name. Aliases (exact path) win over rules; among rules the longest
// matching prefix wins. The rest of the path after the prefix becomes the name suffix:
// `words` maps the whole rest to a word, otherwise each segment is lowercased, `1_5rem` → `1-5`,
// and segments are joined with `-`. `rest: "drop"` maps every path under the prefix to `token`.
// Bracketed Figma labels (`primary/60 [base]`) are not part of the name.
export function createTokenMap({ rules = [], aliases = {} }) {
  const sorted = [...rules].sort((a, b) => b.prefix.length - a.prefix.length);
  const suffix = (rest, words = {}) =>
    words[rest] ??
    rest
      .split('/')
      .map((s) => s.replace(/^(\d+(?:_\d+)?)rem$/, '$1').toLowerCase().replace(/[_\s]+/g, '-'))
      .join('-');
  return {
    resolve(figmaPath) {
      const p = unlabel(figmaPath);
      if (aliases[p]) return aliases[p];
      const rule = sorted.find((r) => p.startsWith(r.prefix));
      if (!rule) return null;
      return rule.rest === 'drop' ? rule.token : rule.token + suffix(p.slice(rule.prefix.length), rule.words);
    },
  };
}

const unlabel = (figmaPath) => figmaPath.replace(/\s*\[[^\]]*\]$/, '');

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────

// Two export formats, one shape out: [{ path, type, value, scopes }] per Token Mode.
//   DTCG (Figma's own export): one *.tokens.json per mode, `$value`, mode in $extensions["com.figma.modeName"].
//   Collection (Variables-export plugin): one JSON per collection, every mode in `valuesByMode`.
const isCollection = (json) => Array.isArray(json.variables) && typeof json.modes === 'object';
const COLLECTION_TYPES = { FLOAT: 'number', COLOR: 'color', STRING: 'string', BOOLEAN: 'boolean' };

function collectionModes(json) {
  // Same order as the DTCG export: panel order (variableIds), grouped by path the way a nested tree walks.
  const order = new Map((json.variableIds ?? []).map((id, i) => [id, i]));
  const tree = new Map();
  for (const v of [...json.variables].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))) {
    let node = tree;
    for (const segment of v.name.split('/').slice(0, -1)) {
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment);
    }
    node.set(Symbol(v.name), v);
  }
  const variables = [];
  const walk = (node) => {
    for (const child of node.values()) child instanceof Map ? walk(child) : variables.push(child);
  };
  walk(tree);
  return Object.fromEntries(
    Object.entries(json.modes).map(([id, mode]) => [
      mode,
      variables.map((v) => {
        const value = v.resolvedValuesByMode?.[id]?.resolvedValue ?? v.valuesByMode[id];
        return {
          path: v.name,
          type: COLLECTION_TYPES[v.type] ?? v.type,
          value: v.type === 'COLOR' ? { hex: `#${hex2(value.r)}${hex2(value.g)}${hex2(value.b)}`, alpha: value.a } : value,
          scopes: v.scopes ?? [],
        };
      }),
    ]),
  );
}

// A single-mode export (the static Variables) → [{ path, type, value, scopes }].
export function flattenExport(json) {
  if (isCollection(json)) {
    const modes = Object.values(collectionModes(json));
    if (modes.length !== 1) throw new Error(`collection "${json.name}" has ${modes.length} modes; the static export has one`);
    return modes[0];
  }
  const out = [];
  const walk = (node, prefix) => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || typeof child !== 'object' || child === null) continue;
      const p = prefix ? `${prefix}/${key}` : key;
      if ('$value' in child) out.push({ path: p, type: child.$type, value: child.$value, scopes: child.$extensions?.['com.figma.scopes'] ?? [] });
      else walk(child, p);
    }
  };
  walk(json, '');
  return out;
}

// Token Modes keyed by Figma mode name: a collection file, or a directory of DTCG files (one per mode).
export function readTokenModes(source) {
  if (fs.statSync(source).isFile()) {
    const json = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!isCollection(json)) throw new Error(`${source}: not a Variables collection export (no "variables" and "modes")`);
    return collectionModes(json);
  }
  const modes = {};
  for (const file of fs.readdirSync(source).filter((f) => f.endsWith('.tokens.json')).sort()) {
    const json = JSON.parse(fs.readFileSync(path.join(source, file), 'utf8'));
    const name = json.$extensions?.['com.figma.modeName'];
    if (!name) throw new Error(`${file}: no $extensions["com.figma.modeName"]`);
    modes[name] = flattenExport(json);
  }
  return modes;
}

// get_variable_defs text: one JSON object of name → value. Text styles come as `Font(…)`.
export function parseVariableDefs(text) {
  const variables = new Map();
  const textStyles = new Map();
  for (const [name, value] of Object.entries(JSON.parse(text))) {
    if (value.startsWith('Font(')) {
      const ls = /letterSpacing: (-?[\d.]+)/.exec(value);
      textStyles.set(name, { letterSpacing: ls ? Number(ls[1]) : 0 });
    } else variables.set(name, value);
  }
  return { variables, textStyles };
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────

const round = (n) => Number(n.toFixed(4));
const WEIGHTS = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
const hex2 = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
// Number Variables scoped to these are px lengths; any other number (opacity, weight, …) is rejected.
const LENGTH_SCOPES = new Set(['FONT_SIZE', 'LINE_HEIGHT', 'GAP', 'WIDTH_HEIGHT', 'CORNER_RADIUS', 'STROKE_FLOAT', 'PARAGRAPH_SPACING']);

function cssValue(variable, fontStacks) {
  const { path: p, type, value, scopes } = variable;
  if (type === 'color') return value.hex.toLowerCase() + (value.alpha < 1 ? hex2(value.alpha) : '');
  if (type === 'number' && scopes.length && scopes.every((s) => LENGTH_SCOPES.has(s))) return `${round(value / 16)}rem`;
  if (scopes.includes('FONT_FAMILY')) {
    if (!fontStacks[value]) throw new Error(`${p}: no fontStacks entry for "${value}" in the Token Map`);
    return fontStacks[value];
  }
  if (scopes.includes('FONT_STYLE')) {
    const weight = WEIGHTS[value.toLowerCase().replace(/[\s-]+/g, '')];
    if (!weight) throw new Error(`${p}: unknown font style "${value}"`);
    return String(weight);
  }
  throw new Error(`${p}: unsupported variable (type ${type}, scopes ${scopes.join(',')})`);
}

// Comparable form of a CSS value: lengths in px, 6-digit lowercase hex, em as a plain number.
export function canon(value) {
  const v = value.trim().replace(/\s+/g, ' ').toLowerCase();
  const len = /^(-?\d*\.?\d+)(rem|px|em)$/.exec(v);
  if (len) return len[2] === 'em' ? `${round(Number(len[1]))}em` : `${round(Number(len[1]) * (len[2] === 'rem' ? 16 : 1))}px`;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return `#${h.endsWith('ff') && h.length === 8 ? h.slice(0, 6) : h}`;
  }
  return v.replace(/\s*,\s*/g, ', ');
}

// ── CSS reader ──────────────────────────────────────────────────────────────────────────────

// Top-level and @media rules → [{ maxWidth, selectors, decls: Map }]; custom properties only.
export function cssBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim();
      const media = stack.findLast((s) => s.media !== undefined);
      if (prelude.startsWith('@media')) stack.push({ media: Number(/max-width:\s*(\d+)px/.exec(prelude)?.[1]) || prelude });
      else if (prelude.startsWith('@') || stack.some((s) => s.block)) stack.push({});
      else stack.push({ block: { maxWidth: media ? media.media : null, selectors: prelude.split(',').map((s) => s.trim()), from: i + 1 } });
      start = i + 1;
    } else if (text[i] === '}') {
      const { block } = stack.pop() ?? {};
      if (block) {
        const decls = new Map();
        for (const d of text.slice(block.from, i).split(';')) {
          const m = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(d);
          if (m) decls.set(m[1], m[2].trim());
        }
        delete block.from;
        blocks.push({ ...block, decls });
      }
      start = i + 1;
    } else if (text[i] === ';' && !stack.some((s) => s.block)) start = i + 1;
  }
  return blocks;
}

// Custom properties an element sees at a Breakpoint: inherited from :root then body, then the
// element's own pin classes. Media blocks apply by max-width; later rules win.
export function effectiveVars(blocks, breakpoint, pins = []) {
  const bp = BREAKPOINTS.find((b) => b.breakpoint === breakpoint);
  const applies = (b) => b.maxWidth === null || (bp.maxWidth !== null && typeof b.maxWidth === 'number' && b.maxWidth >= bp.maxWidth);
  const vars = new Map();
  for (const selector of [':root', 'body', ...pins])
    for (const b of blocks) if (applies(b) && b.selectors.includes(selector)) for (const [k, v] of b.decls) vars.set(k, v);
  return vars;
}

const resolveRefs = (value, vars, depth = 0) =>
  depth > 10 ? value : value.replace(/var\((--[\w-]+)\)/g, (whole, ref) => (vars.has(ref) ? resolveRefs(vars.get(ref), vars, depth + 1) : whole));

// ── Build ───────────────────────────────────────────────────────────────────────────────────

export function buildTokens({ tokenMap, modes, statics, live, relumeCss, liveColors = false, exportColors = false }) {
  if (liveColors && exportColors) throw new Error('liveColors and exportColors exclude each other');
  const variables = createTokenMap(tokenMap.variables);
  const textStyles = createTokenMap(tokenMap.textStyles ?? {});
  const fontStacks = tokenMap.fontStacks ?? {};
  const bps = BREAKPOINTS.map((b) => b.breakpoint);

  // token → { token, figma: [path], values: { desktop, tablet, mobile }, sources: [{ figma, values }] }
  const tokens = new Map();
  const unmapped = [];
  const add = (token, figma, values) => {
    const t = tokens.get(token);
    if (!t) return void tokens.set(token, { token, figma: [figma], values, sources: [{ figma, values }] });
    t.figma.push(figma);
    t.sources.push({ figma, values });
  };
  const signature = (values) => bps.map((bp) => canon(values[bp])).join('|');
  const same = (v) => Object.fromEntries(bps.map((bp) => [bp, v]));

  // Stale check: live colors against the static export; live Variables missing from every export.
  const exported = new Map(statics.map((v) => [unlabel(v.path), v]));
  const stale = [];
  const liveColor = new Map(); // unlabelled path → { name, value }, filled only with --live-colors
  for (const [name, value] of live.variables) {
    const ex = exported.get(unlabel(name));
    if (value.startsWith('#') || ex?.type === 'color') {
      const exportHex = ex ? cssValue(ex, fontStacks) : null;
      if (exportHex === null || canon(exportHex) !== canon(value)) {
        stale.push({ figma: name, token: variables.resolve(name), export: exportHex, live: value.toLowerCase(), color: true });
        if (liveColors) liveColor.set(unlabel(name), { name, value: value.toLowerCase() });
      }
    } else if (!ex && !Object.values(modes).some((m) => m.some((v) => v.path === name))) {
      stale.push({ figma: name, token: variables.resolve(name), export: null, live: value, color: false });
    }
  }

  // Tokens in source order: static export (stale colors replaced in place), live-only colors,
  // Token Modes, text styles.
  for (const v of statics) {
    const token = variables.resolve(v.path);
    const lc = liveColor.get(unlabel(v.path));
    liveColor.delete(unlabel(v.path));
    if (token) add(token, v.path, same(lc ? lc.value : cssValue(v, fontStacks)));
    else unmapped.push({ figma: v.path, source: 'export' });
  }
  for (const { name, value } of liveColor.values()) {
    const token = variables.resolve(name);
    if (token) add(token, name, same(value));
    else unmapped.push({ figma: name, source: 'live' });
  }

  const modeVars = Object.fromEntries(bps.map((bp) => [bp, modes[tokenMap.modes[bp]]]));
  for (const bp of bps) if (!modeVars[bp]) throw new Error(`no Token Mode export named "${tokenMap.modes[bp]}" for ${bp}`);
  const byPath = Object.fromEntries(bps.map((bp) => [bp, new Map(modeVars[bp].map((v) => [v.path, v]))]));
  for (const v of modeVars.desktop) {
    const token = variables.resolve(v.path);
    if (!token) {
      unmapped.push({ figma: v.path, source: 'export' });
      continue;
    }
    const values = {};
    for (const bp of bps) {
      const mv = byPath[bp].get(v.path);
      if (!mv) throw new Error(`${v.path}: missing from the ${tokenMap.modes[bp]} Token Mode export`);
      values[bp] = cssValue(mv, fontStacks);
    }
    add(token, v.path, values);
  }

  for (const [name, style] of live.textStyles) {
    const token = textStyles.resolve(name);
    if (token) add(token, name, same(`${round(style.letterSpacing / 100)}em`));
    else unmapped.push({ figma: name, source: 'text style' });
  }

  const conflicts = [...tokens.values()]
    .filter((t) => new Set(t.sources.map((s) => signature(s.values))).size > 1)
    .map((t) => ({ token: t.token, sources: t.sources }));

  // Comparison with the Relume export.
  const relume = cssBlocks(relumeCss);
  const theirs = Object.fromEntries(bps.map((bp) => [bp, effectiveVars(relume, bp)]));
  const report = { same: [], differs: [], onlyHere: [], unmapped, stale, conflicts, liveColors, exportColors };
  for (const t of tokens.values()) {
    if (!theirs.desktop.has(t.token)) {
      report.onlyHere.push({ token: t.token, figma: t.figma });
      continue;
    }
    const modesDiffer = {};
    for (const bp of bps) {
      const r = resolveRefs(theirs[bp].get(t.token), theirs[bp]);
      if (canon(r) !== canon(t.values[bp])) modesDiffer[bp] = { figma: t.values[bp], relume: r };
    }
    if (Object.keys(modesDiffer).length) report.differs.push({ token: t.token, figma: t.figma, modes: modesDiffer });
    else report.same.push(t.token);
  }

  const stops = [];
  if (conflicts.length) stops.push('conflicts: fix the Token Map or the design.');
  if (stale.some((s) => s.color) && !liveColors && !exportColors) stops.push('stale colors: re-export the Variables, or confirm which is right and rerun with --live-colors or --export-colors.');
  const ok = stops.length === 0;
  return { ok, stops, css: ok ? renderCss([...tokens.values()]) : null, tokens: [...tokens.values()], report };
}

function renderCss(tokens) {
  const responsive = tokens.filter((t) => new Set(Object.values(t.values).map(canon)).size > 1);
  const decls = (list, bp, indent) => list.map((t) => `${indent}${t.token}: ${t.values[bp]};`).join('\n');
  const [base, ...narrower] = BREAKPOINTS;
  const media = narrower.map(({ breakpoint, maxWidth }, i) => {
    const pinnable = i < narrower.length - 1;
    return `@media screen and (max-width: ${maxWidth}px) {
  body${pinnable ? `, .u-mode-${breakpoint}` : ''} {
${decls(responsive, breakpoint, '    ')}
  }
}
`;
  });
  return `/*
 * GENERATED by skill/scripts/tokens.mjs from the Token Map and the Token Mode exports. Do not edit.
 * Mode Pin: .u-mode-<mode> keeps that Token Mode at narrower Breakpoints.
 */
body {
${decls(tokens, base.breakpoint, '  ')}
}

${media.join('\n')}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

function printReport({ ok, stops, tokens, report }, out) {
  const r = report;
  console.log(`${tokens.length} Tokens · vs Relume export: ${r.same.length} same · ${r.differs.length} differs · ${r.onlyHere.length} only here · ${r.unmapped.length} unmapped`);
  if (r.differs.length) {
    console.log('\nDIFFERS from the Relume export (Figma wins):');
    for (const d of r.differs) {
      const entries = Object.entries(d.modes);
      const uniform = entries.length === 3 && new Set(entries.map(([, m]) => `${m.figma}|${m.relume}`)).size === 1;
      const shown = uniform ? [['all', entries[0][1]]] : entries;
      console.log(`  ${d.token}  ${shown.map(([bp, m]) => `${bp}: figma ${m.figma}, relume ${m.relume}`).join(' · ')}`);
    }
  }
  if (r.onlyHere.length) console.log(`\nONLY HERE (not in the Relume export): ${r.onlyHere.map((o) => o.token).join(', ')}`);
  if (r.unmapped.length) {
    console.log('\nUNMAPPED Figma Variables (add a rule or alias to the Token Map):');
    for (const u of r.unmapped) console.log(`  ${u.figma}  (${u.source})`);
  }
  if (r.conflicts.length) {
    console.log('\nCONFLICT: Figma Variables mapped to one Token have different values:');
    for (const c of r.conflicts) {
      console.log(`  ${c.token}`);
      for (const s of c.sources) console.log(`    ${s.figma}: ${Object.values(s.values).join(' / ')}`);
    }
  }
  if (r.stale.length) {
    const kept = r.liveColors ? ' (colors taken from live: --live-colors)' : r.exportColors ? ' (export colors kept: --export-colors)' : '';
    console.log(`\nSTALE EXPORT: live get_variable_defs differs from the export${kept}:`);
    for (const s of r.stale) console.log(`  ${s.figma}  export ${s.export ?? 'missing'}, live ${s.live}`);
    if (r.stale.some((s) => !s.color)) console.log('  Non-color Variables missing from the export are not in tokens.css: re-export the Token Modes.');
  }
  if (ok) console.log(`\nwrote ${out}`);
  else {
    console.log('\nSTOP: tokens.css not written. Ask the user:');
    for (const s of stops) console.log(`  - ${s}`);
  }
}

const USAGE = 'usage: tokens.mjs --map <token-map.json> --modes <collection.json|dir> --static <file.json> --relume <webflow.css> --out <tokens.css> [--report <file.json>] [--live-colors|--export-colors] <nodeId...>';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let opt, nodeIds;
  try {
    ({ values: opt, positionals: nodeIds } = parseArgs({
      allowPositionals: true,
      options: {
        map: { type: 'string' },
        modes: { type: 'string' },
        static: { type: 'string' },
        relume: { type: 'string' },
        out: { type: 'string' },
        report: { type: 'string' },
        'live-colors': { type: 'boolean', default: false },
        'export-colors': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!opt.map || !opt.modes || !opt.static || !opt.relume || !opt.out || !nodeIds.length || (opt['live-colors'] && opt['export-colors'])) {
    console.error(USAGE);
    process.exit(2);
  }
  const mcp = clientFromEnv();
  const live = { variables: new Map(), textStyles: new Map() };
  for (const id of nodeIds) {
    const defs = parseVariableDefs(textOf((await mcp.call('get_variable_defs', id)).result));
    for (const [k, v] of defs.variables) if (!live.variables.has(k)) live.variables.set(k, v);
    for (const [k, v] of defs.textStyles) if (!live.textStyles.has(k)) live.textStyles.set(k, v);
  }
  const result = buildTokens({
    tokenMap: JSON.parse(fs.readFileSync(opt.map, 'utf8')),
    modes: readTokenModes(opt.modes),
    statics: flattenExport(JSON.parse(fs.readFileSync(opt.static, 'utf8'))),
    live,
    relumeCss: fs.readFileSync(opt.relume, 'utf8'),
    liveColors: opt['live-colors'],
    exportColors: opt['export-colors'],
  });
  if (opt.report) fs.writeFileSync(opt.report, `${JSON.stringify(result.report, null, 2)}\n`);
  if (result.ok) fs.writeFileSync(opt.out, result.css);
  printReport(result, opt.out);
  process.exit(result.ok ? 0 : 1);
}
