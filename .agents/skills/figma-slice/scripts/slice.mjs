#!/usr/bin/env node
// Slice fetch: everything the agent needs to build every Section of one Figma page, in one run.
//   Locate Sections (stop on unconfirmed name mismatch) → per Section and Breakpoint: get_design_context
//   (code, reference screenshot, assets), child metadata for empty roots, get_variable_defs on tablet/mobile
//   for Mode Pin detection → assets copied into the Target Project → manifest.
//
// Library:
//   modeValues(readTokenModes(dir), tokenMapModes)       → { desktop: Map(path → number), tablet, mobile }
//   detectModePins(liveVariables, modes, breakpoint)      → [{ mode, variables: [{ figma, live, expected }] }]
//     get_variable_defs returns one value per Variable; a number that is not this Breakpoint's Token Mode
//     value but another mode's is evidence of a Mode Pin somewhere in the node. The agent finds the subtree.
//   slicePage({ pageId, mcp, pairs?, only?, projectDir, modes, copyAssets? })
//     → { ok, mismatches, frames, orderWarnings, sections: [section], live }
//     section = { name, slug, nodes: { bp: id }, references: { bp: png|null }, assets: [{ file, from: { bp: [const] } }],
//                 modePins: [{ breakpoint, mode, variables }], unaddressable: { bp: [component] }, calls: { tool: n } }
//     calls counts distinct tool+node requests: the MCP cost of the Section without cache. live: calls that hit MCP.
//     Assets go to <projectDir>/src/assets/<slug>/<layer>.<ext>: one file per distinct asset across Breakpoints
//     (same bytes, or SVGs that differ only by scale), named after the first Breakpoint's layer, made unique.
//     copyAssets: false (--no-assets) names the files without writing them: a re-run keeps deleted assets deleted.
// CLI: node slice.mjs <pageNodeId|figmaUrl> --map token-map.json --modes <dir> [--pair "<d>=<t>[=<m>]"]… [--only a,b]
//        [--manifest figma-slice.json] [--no-assets]   (env as in mcp.mjs; run in the Target Project; exit 1 on mismatch)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, textOf } from './mcp.mjs';
import { BREAKPOINTS, locateSections, expandSection, parsePair, pageIdOf, printLocate } from './locate.mjs';
import { readTokenModes, parseVariableDefs } from './tokens.mjs';

export function modeValues(tokenModes, tokenMapModes) {
  return Object.fromEntries(
    BREAKPOINTS.map(({ breakpoint }) => {
      const vars = tokenModes[tokenMapModes[breakpoint]];
      if (!vars) throw new Error(`no Token Mode export named "${tokenMapModes[breakpoint]}" for ${breakpoint}`);
      return [breakpoint, new Map(vars.filter((v) => v.type === 'number').map((v) => [v.path, v.value]))];
    }),
  );
}

export function detectModePins(liveVariables, modes, breakpoint) {
  const pins = new Map();
  for (const [figma, raw] of liveVariables) {
    const expected = modes[breakpoint].get(figma);
    const live = Number(raw);
    if (expected === undefined || Number.isNaN(live) || live === expected) continue;
    for (const { breakpoint: mode } of BREAKPOINTS) {
      if (mode === breakpoint || modes[mode].get(figma) !== live) continue;
      if (!pins.has(mode)) pins.set(mode, []);
      pins.get(mode).push({ figma, live, expected });
    }
  }
  return [...pins].map(([mode, variables]) => ({ mode, variables }));
}

export const slugOf = (name) =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-section$/, '');

// Codegen const → layer name: imgLogo1 → logo when imgLogo also exists (Figma's duplicate counter), imgAlt01 → alt-01.
function layerName(constName, consts) {
  const bare = constName.replace(/^img/, '');
  const base = bare.replace(/\d+$/, '');
  const name = base !== bare && consts.has(`img${base}`) ? base : bare;
  return slugOf(name.replace(/([a-zA-Z])(\d)/g, '$1-$2')) || 'asset';
}

// SVGs that differ only by scale: same markup with numbers replaced, every number at one ratio (± rounding).
const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;
function sameSvg(a, b) {
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false;
  const na = a.match(NUMBER)?.map(Number) ?? [];
  const nb = b.match(NUMBER)?.map(Number) ?? [];
  const width = (svg) => Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]);
  const ratio = width(b) / width(a) || 1;
  return na.every((x, i) => Math.abs(nb[i] - x * ratio) <= 0.01 + 0.002 * Math.abs(nb[i]));
}

function sameAsset(a, b) {
  if (a.hash === b.hash) return true;
  if (!a.hash.endsWith('.svg') || !b.hash.endsWith('.svg')) return false;
  return sameSvg(fs.readFileSync(a.file, 'utf8'), fs.readFileSync(b.file, 'utf8'));
}

function collectAssets(perBreakpoint, slug, projectDir, copy) {
  const distinct = [];
  for (const [bp, assets] of Object.entries(perBreakpoint)) {
    const consts = new Set(assets.map((a) => a.name));
    for (const asset of assets) {
      if (asset.missing) throw new Error(`asset ${asset.name} (${asset.hash}) of ${slug}/${bp} missing from the cache: refetch with FORCE=1`);
      const hit = distinct.find((d) => sameAsset(d.asset, asset));
      if (hit) (hit.from[bp] ??= []).push(asset.name);
      else distinct.push({ asset, layer: layerName(asset.name, consts), from: { [bp]: [asset.name] } });
    }
  }
  const dir = path.join(projectDir, 'src/assets', slug);
  const taken = new Set();
  return distinct.map(({ asset, layer, from }) => {
    const ext = path.extname(asset.hash);
    let file = `${layer}${ext}`;
    for (let n = 2; taken.has(file); n++) file = `${layer}-${n}${ext}`;
    taken.add(file);
    if (copy) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(asset.file, path.join(dir, file));
    }
    return { file: path.posix.join('src/assets', slug, file), from };
  });
}

export async function slicePage({ pageId, mcp, pairs = [], only, projectDir, modes, copyAssets = true }) {
  let live = 0;
  const call = async (tool, id) => {
    const r = await mcp.call(tool, id);
    if (r.source === 'live') live++;
    return r;
  };
  const located = locateSections(textOf((await call('get_metadata', pageId)).result), { pairs });
  const { ok, mismatches, orderWarnings } = located;
  const frames = located.frames.map(({ breakpoint, id, name }) => ({ breakpoint, id, name }));
  if (!ok) return { ok, mismatches, frames, orderWarnings, sections: [], live };
  if (only) {
    const unknown = only.filter((n) => !located.sections.some((s) => s.name === n));
    if (unknown.length) throw new Error(`--only: no Section named ${unknown.join(', ')}`);
  }

  const sections = [];
  for (const section of located.sections.filter((s) => !only || only.includes(s.name))) {
    const requested = new Set();
    const counted = { call: (tool, id) => (requested.add(`${tool} ${id}`), call(tool, id)) };
    const expanded = await expandSection(section, counted);

    const slug = slugOf(section.name);
    const references = {};
    const assets = {};
    const modePins = [];
    const unaddressable = {};
    for (const { breakpoint: bp } of BREAKPOINTS) {
      const node = expanded.nodes[bp];
      const context = await counted.call('get_design_context', node.id);
      references[bp] = context.images[0] ? path.relative(projectDir, context.images[0]) : null;
      assets[bp] = context.assets;
      if (node.unaddressable?.length) unaddressable[bp] = node.unaddressable;
      if (bp === 'desktop') continue;
      const { variables } = parseVariableDefs(textOf((await counted.call('get_variable_defs', node.id)).result));
      for (const pin of detectModePins(variables, modes, bp)) modePins.push({ breakpoint: bp, ...pin });
    }

    const calls = {};
    for (const key of requested) calls[key.split(' ')[0]] = (calls[key.split(' ')[0]] ?? 0) + 1;
    sections.push({
      name: section.name,
      slug,
      nodes: Object.fromEntries(BREAKPOINTS.map(({ breakpoint: bp }) => [bp, section.nodes[bp].id])),
      references,
      assets: collectAssets(assets, slug, projectDir, copyAssets),
      modePins,
      unaddressable,
      calls,
    });
  }
  return { ok, mismatches, frames, orderWarnings, sections, live };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pair: { type: 'string', multiple: true, default: [] },
      only: { type: 'string' },
      map: { type: 'string' },
      modes: { type: 'string' },
      manifest: { type: 'string', default: 'figma-slice.json' },
      'no-assets': { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1 || !values.map || !values.modes) {
    console.error('usage: slice.mjs <pageNodeId|figmaUrl> --map token-map.json --modes <dir> [--pair "<d>=<t>[=<m>]"]… [--only a,b] [--manifest file] [--no-assets]');
    process.exit(2);
  }
  const tokenMap = JSON.parse(fs.readFileSync(values.map, 'utf8'));
  const r = await slicePage({
    pageId: pageIdOf(positionals[0]),
    mcp: clientFromEnv(),
    pairs: values.pair.map(parsePair),
    only: values.only?.split(',').map((s) => s.trim()),
    projectDir: process.cwd(),
    modes: modeValues(readTokenModes(values.modes), tokenMap.modes),
    copyAssets: !values['no-assets'],
  });
  printLocate({ ...r, sections: r.ok ? r.sections.map((s) => ({ ...s, nodes: Object.fromEntries(Object.entries(s.nodes).map(([bp, id]) => [bp, { id }])) })) : [] });
  if (!r.ok) process.exit(1);
  for (const s of r.sections) {
    const pins = s.modePins.map((p) => `${p.breakpoint}→${p.mode} (${p.variables.map((v) => v.figma).join(', ')})`);
    const noRef = Object.entries(s.references).filter(([, f]) => !f).map(([bp]) => bp);
    console.log(`\n${s.slug}: ${s.assets.length} assets · calls ${JSON.stringify(s.calls)}`);
    if (pins.length) console.log(`  Mode Pin candidates: ${pins.join('; ')}`);
    if (Object.keys(s.unaddressable).length) console.log(`  unaddressable: ${JSON.stringify(s.unaddressable)}`);
    if (noRef.length) console.log(`  WARNING no reference screenshot for ${noRef.join(', ')}: refetch get_design_context with FORCE=1`);
  }
  fs.writeFileSync(values.manifest, `${JSON.stringify(r, null, 1)}\n`);
  console.log(`\n${r.live} live MCP calls · manifest ${values.manifest}`);
}
