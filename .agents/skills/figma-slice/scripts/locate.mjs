#!/usr/bin/env node
// Section Locator: finds the three Breakpoint Frames in a page's get_metadata XML and matches Sections by name.
//
// Library:
//   parseMetadata(xml)              → [node]  node = { type, id, name, x, y, width, height, hidden, children }
//                                      (x/y relative to parent, as Figma reports them)
//   locateSections(pageXml, { pairs }) → { ok, frames, sections, mismatches, orderWarnings }
//     ok is false when any Section name is not present exactly once in all three frames: stop and ask the user.
//     pairs: user-confirmed names per frame ([{ desktop, tablet, mobile }]) matched as one Section, named as most
//     frames name it (ties: desktop).
//     sections follow desktop order; orderWarnings lists frames whose order differs.
//   expandSection(section, mcp)     → { ...section, nodes, calls }
//     Section roots with no children in metadata (e.g. hero) get their children per node:
//     direct children from get_design_context, then get_metadata for each named child. Instances (rendered as their
//     main component, root id absent) take the children of their own get_metadata instead.
// CLI: node locate.mjs <pageNodeId|figmaUrl> [--pair "<desktop>=<tablet>[=<mobile>]"]…   (env as in mcp.mjs; exit 1 on mismatch)
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientFromEnv, textOf } from './mcp.mjs';

export const BREAKPOINTS = [
  { breakpoint: 'desktop', width: 1440 },
  { breakpoint: 'tablet', width: 834 },
  { breakpoint: 'mobile', width: 393 },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  s.replace(/&(#x?[\da-f]+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(Number(e[1] === 'x' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e] ?? m),
  );

// A get_design_context JSX tag: [, close, name, attrs, selfClose]. Attributes may hold {…} with one nesting level.
export const JSX_TAG = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\}))?)*)\s*(\/?)>/g;
const GEOMETRY = ['x', 'y', 'width', 'height'];
const ADDRESSABLE = /^\d+[:-]\d+$/;

export function parseMetadata(xml) {
  const roots = [];
  const stack = [];
  for (const [, close, type, attrs, selfClose] of xml.matchAll(/<(\/?)([a-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (close) {
      stack.pop();
      continue;
    }
    const a = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));
    const node = { type, id: a.id, name: a.name };
    for (const k of GEOMETRY) node[k] = Number(a[k]);
    node.hidden = a.hidden === 'true';
    node.children = [];
    (stack.at(-1)?.children ?? roots).push(node);
    if (!selfClose) stack.push(node);
  }
  return roots;
}

function findFrames(roots) {
  const candidates = [...roots, ...roots.flatMap((r) => r.children)];
  const missing = [];
  const frames = BREAKPOINTS.map(({ breakpoint, width }) => {
    const hits = candidates.filter((n) => n.width === width);
    if (hits.length !== 1) missing.push(`${breakpoint} (${width})${hits.length ? `: ${hits.length} frames` : ''}`);
    return { breakpoint, id: hits[0]?.id, name: hits[0]?.name, node: hits[0] };
  });
  if (missing.length) throw new Error(`Breakpoint Frame not found exactly once: ${missing.join(', ')}`);
  return frames;
}

export function locateSections(pageXml, { pairs = [] } = {}) {
  const frames = findFrames(parseMetadata(pageXml));
  // Paired names become one canonical name, so matching and ordering treat them as one Section.
  const pairName = (p) => {
    const all = BREAKPOINTS.map((b) => p[b.breakpoint]);
    const count = (n) => all.filter((m) => m === n).length;
    return all.reduce((best, n) => (count(n) > count(best) ? n : best));
  };
  const canonical = (bp, name) => {
    const p = pairs.find((q) => q[bp] === name);
    return p ? pairName(p) : name;
  };
  const names = frames.map((f) => f.node.children.map((s) => canonical(f.breakpoint, s.name)));
  // A name must occur exactly once per frame; repeated names cannot be paired safely.
  const shared = (name) => names.every((list) => list.filter((n) => n === name).length === 1);

  const sections = names[0].filter(shared).map((name) => ({
    name,
    nodes: Object.fromEntries(frames.map((f, j) => [f.breakpoint, f.node.children[names[j].indexOf(name)]])),
  }));

  // Unmatched names (as named in Figma), paired by their order among the unmatched in each frame.
  const unmatched = frames.map((f, j) => f.node.children.filter((_, i) => !shared(names[j][i])).map((s) => s.name));
  const mismatches = Array.from({ length: Math.max(...unmatched.map((u) => u.length)) }, (_, i) =>
    Object.fromEntries(frames.map((f, j) => [f.breakpoint, unmatched[j][i] ?? null])),
  );

  const expected = sections.map((s) => s.name);
  const orderWarnings = [];
  frames.slice(1).forEach((f, k) => {
    const actual = names[k + 1].filter(shared);
    const diff = actual.map((n, i) => n !== expected[i]);
    const first = diff.indexOf(true);
    if (first < 0) return;
    const last = diff.lastIndexOf(true);
    orderWarnings.push({ breakpoint: f.breakpoint, moved: actual.slice(first, last + 1), expected: expected.slice(first, last + 1) });
  });

  return { ok: mismatches.length === 0, frames, sections, mismatches, orderWarnings };
}

// Direct children of the root element in get_design_context JSX. Named elements with a node id are
// Figma layers worth fetching (ids); unnamed ones (gradient rectangles, …) are listed but not fetched.
// Components rendered without data-node-id (e.g. <Navbar />) cannot be addressed; returned by name.
// null when the root is absent: an instance is rendered as its main component, with component ids.
export function designContextChildren(jsx, rootId) {
  const code = jsx.replace(/\{`(?:[^`\\]|\\.)*`\}/g, '{``}');
  const ids = [];
  const unnamed = [];
  const unaddressable = [];
  let depth = -1;
  for (const [, close, name, attrs, selfClose] of code.matchAll(JSX_TAG)) {
    if (depth < 0) {
      if (!close && attrs.includes(`data-node-id="${rootId}"`)) depth = selfClose ? -1 : 0;
      continue;
    }
    if (close) {
      if (depth-- === 0) return { ids, unnamed, unaddressable };
      continue;
    }
    if (depth === 0) {
      const id = attrs.match(/data-node-id="([^"]+)"/)?.[1];
      if (id) (attrs.includes('data-name=') ? ids : unnamed).push(id);
      else if (/^[A-Z]/.test(name)) unaddressable.push(name);
    }
    if (!selfClose) depth++;
  }
  return null;
}

export async function expandSection(section, mcp) {
  const calls = {};
  const call = async (tool, id) => {
    calls[tool] = (calls[tool] ?? 0) + 1;
    return textOf((await mcp.call(tool, id)).result);
  };
  const nodes = {};
  for (const [bp, node] of Object.entries(section.nodes)) {
    if (!node || node.children.length) {
      nodes[bp] = node;
      continue;
    }
    const direct = designContextChildren(await call('get_design_context', node.id), node.id);
    if (!direct) {
      // Instance: its own metadata lists the children with instance ids (I<instance>;<component>).
      const [instance] = parseMetadata(await call('get_metadata', node.id));
      nodes[bp] = { ...node, children: instance.children, unnamed: [], unaddressable: [] };
      continue;
    }
    const { ids, unnamed, unaddressable } = direct;
    const children = [];
    // MCP only takes plain ids; instance-prefixed ones (I<instance>;<component>) are listed, not fetched.
    for (const id of ids) {
      if (ADDRESSABLE.test(id)) children.push(...parseMetadata(await call('get_metadata', id)));
      else unaddressable.push(id);
    }
    nodes[bp] = { ...node, children, unnamed, unaddressable };
  }
  return { ...section, nodes, calls };
}

// "--pair <desktop>=<tablet>[=<mobile>]": mobile defaults to the tablet name.
export function parsePair(arg) {
  const [desktop, tablet, mobile = tablet] = arg.split('=').map((s) => s.trim());
  if (!desktop || !tablet || !mobile) throw new Error(`--pair "${arg}": expected "<desktop>=<tablet>[=<mobile>]"`);
  return { desktop, tablet, mobile };
}

// Page node from an id or a Figma URL (?node-id=4874-14273).
export const pageIdOf = (arg) => (URL.canParse(arg) ? new URL(arg).searchParams.get('node-id') ?? '' : arg).replace('-', ':');

export function printLocate(r) {
  for (const f of r.frames) console.log(`${f.breakpoint.padEnd(7)} ${f.id}  ${f.name}`);
  console.log(`\n${r.sections.length} Sections matched (desktop order):`);
  for (const s of r.sections) console.log(`  ${s.name.padEnd(22)} ${BREAKPOINTS.map((b) => s.nodes[b.breakpoint].id).join(' | ')}`);
  for (const w of r.orderWarnings)
    console.log(`\nWARNING order differs in ${w.breakpoint}: ${w.moved.join(' → ')} (desktop: ${w.expected.join(' → ')}); using desktop order.`);
  if (!r.ok) {
    console.log('\nSTOP: Section names do not match across Breakpoint Frames (confirm with the user, then --pair):');
    for (const m of r.mismatches) console.log(`  ${BREAKPOINTS.map((b) => `${b.breakpoint}=${m[b.breakpoint] ?? '-'}`).join('  ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { pair: { type: 'string', multiple: true, default: [] } } });
  if (positionals.length !== 1) {
    console.error('usage: locate.mjs <pageNodeId|figmaUrl> [--pair "<desktop>=<tablet>[=<mobile>]"]…');
    process.exit(2);
  }
  const mcp = clientFromEnv();
  const r = locateSections(textOf((await mcp.call('get_metadata', pageIdOf(positionals[0]))).result), { pairs: values.pair.map(parsePair) });
  printLocate(r);
  if (!r.ok) process.exit(1);
}
