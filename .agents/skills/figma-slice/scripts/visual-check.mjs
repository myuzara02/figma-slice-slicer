#!/usr/bin/env node
// Visual check (ADR 0007, Lumos "Look at it"): Figma | Astro side by side per Breakpoint, plus two cheap checks.
//   1. text:     every text of the Figma node (get_design_context) appears in the DOM at that Breakpoint.
//   2. overflow: no horizontal scroll at 360/480/768/992/1200px.
// No pixel or bbox thresholds. Mismatches are reported; Tokens are not tuned to make them pass.
//
// Library:
//   figmaTexts(jsx)                 → [text]  text segments of get_design_context code
//   missingTexts(texts, domText)    → [text]  texts not found in domText (whitespace and case ignored)
//   visualCheck({ url, targets: [{ name, nodes: [d, t, m], selector?, out }], mcp, chromium })
//     → { targets: [{ name, images, text: [{ breakpoint, node, missing }], error }], overflow: [{ width, ok, … }] }
//     One browser session, one page load per Breakpoint for every target. A target whose selector renders
//     nothing gets `error` and no images; the others still run.
//   targetsFromManifest(manifest, { only?, selectors?: ['<name>=<css>'], out }) → targets for visualCheck
// CLI: node visual-check.mjs <url> --nodes <desktop>,<tablet>,<mobile> [--selector <css>] [--out visual-check]
//      node visual-check.mjs <url> --manifest figma-slice.json [--only <name>,…] [--selector <name>=<css>]… [--out visual-check]
//   A selector matching several elements (a Section and the navbar laid over it) shoots their union box.
//   Reference images and texts come from get_design_context (cache first; env as in mcp.mjs).
//   --nodes: without --selector the whole page is shot and its body text matched; writes <out>/<breakpoint>.png.
//   --manifest: every Section of slice.mjs's manifest (Section names as in the manifest), selector `.<slug>_wrap`
//   unless overridden; writes <out>/<slug>/<breakpoint>.png.
//   Exit 1 when a check fails. Playwright is resolved from the Target Project (cwd).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientFromEnv } from './mcp.mjs';
import { BREAKPOINTS, JSX_TAG, decode } from './locate.mjs';

export const OVERFLOW_WIDTHS = [360, 480, 768, 992, 1200];

const STRING_EXPR = /\{\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)\s*\}/g;

// Text inside JSX elements of every function, so helper components (instances such as a Navbar) count too.
// Depth tracking leaves out the code between one function's JSX and the next.
export function figmaTexts(jsx) {
  const texts = [];
  let depth = 0;
  let last = 0;
  for (const m of jsx.matchAll(JSX_TAG)) {
    if (depth > 0) {
      const between = jsx
        .slice(last, m.index)
        .replace(STRING_EXPR, (_, d, s, t) => ` ${(d ?? s ?? t).replace(/\\(.)/g, '$1')} `)
        .replace(/\{[^{}]*\}/g, ' ');
      const text = decode(between.replace(/<\/?>/g, ' ')).replace(/\s+/g, ' ').trim();
      // An unmatched brace or a lone operator is code around conditional JSX ({cond && ( … )}, a ? <p/> : <p/>).
      if (text && !/[{}]/.test(text) && !/^[\s:?()&|!]*$/.test(text)) texts.push(text);
    }
    const [, close, , , selfClose] = m;
    if (close) depth--;
    else if (!selfClose) depth++;
    last = m.index + m[0].length;
  }
  return texts;
}

const norm = (s) => s.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

export function missingTexts(texts, domText) {
  const dom = norm(domText);
  return texts.filter((t) => !dom.includes(norm(t)));
}

// Runs in the page: elements sticking out past the viewport that are not clipped by an ancestor.
function overflowOffenders() {
  const width = document.documentElement.clientWidth;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/hidden|clip/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= width + 0.5) return true;
    }
    return false;
  };
  const describe = (el) => el.tagName.toLowerCase() + [...el.classList].map((c) => `.${c}`).join('');
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > width + 0.5 || r.left < -0.5) && !clipped(el)) out.push(`${describe(el)} (${Math.round(r.left)}–${Math.round(r.right)}px)`);
  }
  return { scrollWidth: document.documentElement.scrollWidth, width, offenders: out.slice(0, 5) };
}

async function sideBySide(browser, figmaPng, astroPng, width, label) {
  const img = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  const page = await browser.newPage({ viewport: { width: width * 2 + 48, height: 600 } });
  await page.setContent(`<body style="margin:0;padding:16px;background:#888;font:14px sans-serif;display:flex;gap:16px;align-items:flex-start">
    ${[['Figma', figmaPng], ['Astro', astroPng]]
      .map(([name, buf]) => `<figure style="margin:0;width:${width}px"><figcaption>${name} · ${label}</figcaption><img style="display:block;width:${width}px" src="${img(buf)}"></figure>`)
      .join('')}</body>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const shot = await page.screenshot({ fullPage: true });
  await page.close();
  return shot;
}

// Fonts loaded and every image decoded, lazy ones included (below the fold they would shoot as blanks).
async function settle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const images = [...document.images];
    for (const img of images) img.loading = 'eager';
    await Promise.all(images.map((img) => img.decode().catch(() => {})));
    await document.fonts.ready;
  });
}

// Every rendered element the selector matches (e.g. a Section plus the global navbar laid over it): one shot of
// their union box, their texts joined. Hidden matches (display:none at this Breakpoint) are left out.
async function shootSelector(page, selector) {
  const matches = await page.locator(selector).all();
  const boxes = await Promise.all(matches.map((t) => t.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + scrollX, y: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY } : null;
  })));
  const targets = matches.filter((_, i) => boxes[i]);
  const shown = boxes.filter(Boolean);
  if (!shown.length) throw new Error(`--selector ${selector}: no rendered element`);
  const x = Math.min(...shown.map((b) => b.x));
  const y = Math.min(...shown.map((b) => b.y));
  const clip = { x, y, width: Math.max(...shown.map((b) => b.right)) - x, height: Math.max(...shown.map((b) => b.bottom)) - y };
  const shot = await page.screenshot({ clip, fullPage: true, animations: 'disabled' });
  return { shot, domText: (await Promise.all(targets.map((t) => t.innerText()))).join('\n') };
}

async function references(mcp, nodes) {
  const refs = [];
  for (const [i, { breakpoint, width }] of BREAKPOINTS.entries()) {
    const r = await mcp.call('get_design_context', nodes[i]);
    if (!r.images[0] || !fs.existsSync(r.images[0]))
      throw new Error(`get_design_context ${nodes[i]}: no screenshot cached (fetched with excludeScreenshot?); refetch with FORCE=1`);
    // Only the generated code block; the instruction blocks after it hold example tags of their own.
    const code = r.result.content.find((b) => b.type === 'text' && /^export default function/m.test(b.text))?.text;
    if (!code) throw new Error(`get_design_context ${nodes[i]}: no code block`);
    refs.push({ breakpoint, width, node: nodes[i], texts: figmaTexts(code), png: fs.readFileSync(r.images[0]) });
  }
  return refs;
}

export async function visualCheck({ url, targets, mcp, chromium }) {
  const checks = [];
  for (const t of targets) checks.push({ ...t, refs: await references(mcp, t.nodes), shots: [], text: [], error: null });

  const browser = await chromium.launch();
  try {
    for (const [i, { breakpoint, width }] of BREAKPOINTS.entries()) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await settle(page, url);
      for (const c of checks.filter((c) => !c.error)) {
        const ref = c.refs[i];
        try {
          const { shot, domText } = c.selector ? await shootSelector(page, c.selector) : { shot: await page.screenshot({ fullPage: true, animations: 'disabled' }), domText: await page.locator('body').innerText() };
          c.text.push({ breakpoint, node: ref.node, missing: missingTexts(ref.texts, domText) });
          c.shots.push({ breakpoint, figma: ref.png, astro: shot, width });
        } catch (e) {
          c.error = `${breakpoint}: ${e.message}`;
        }
      }
      await page.close();
    }

    for (const c of checks.filter((c) => !c.error)) {
      fs.mkdirSync(c.out, { recursive: true });
      c.images = [];
      for (const s of c.shots) {
        const file = path.join(c.out, `${s.breakpoint}.png`);
        fs.writeFileSync(file, await sideBySide(browser, s.figma, s.astro, s.width, `${s.breakpoint} ${s.width}px`));
        c.images.push(file);
      }
    }

    const overflow = [];
    for (const width of OVERFLOW_WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await settle(page, url);
      const r = await page.evaluate(overflowOffenders);
      overflow.push({ width, ok: r.scrollWidth <= r.width, scrollWidth: r.scrollWidth, offenders: r.offenders });
      await page.close();
    }
    return { targets: checks.map(({ name, images = [], text, error }) => ({ name, images, text, error })), overflow };
  } finally {
    await browser.close();
  }
}

export function targetsFromManifest({ sections }, { only, selectors = [], out }) {
  const overrides = new Map(selectors.map((s) => {
    const at = s.indexOf('=');
    if (at < 1) throw new Error(`--selector "${s}": expected <Section name>=<css> with --manifest`);
    return [s.slice(0, at).trim(), s.slice(at + 1).trim()];
  }));
  for (const name of [...(only ?? []), ...overrides.keys()]) {
    if (!sections.some((s) => s.name === name)) throw new Error(`no Section named "${name}" in the manifest`);
  }
  return sections
    .filter((s) => !only || only.includes(s.name))
    .map((s) => ({
      name: s.name,
      nodes: BREAKPOINTS.map(({ breakpoint }) => s.nodes[breakpoint]),
      selector: overrides.get(s.name) ?? `.${s.slug}_wrap`,
      out: path.join(out, s.slug),
    }));
}

const USAGE = `usage: visual-check.mjs <url> --nodes <desktop>,<tablet>,<mobile> [--selector <css>] [--out visual-check]
       visual-check.mjs <url> --manifest figma-slice.json [--only <name>,…] [--selector <name>=<css>]… [--out visual-check]`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      nodes: { type: 'string' },
      manifest: { type: 'string' },
      only: { type: 'string' },
      selector: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: 'visual-check' },
    },
  });
  const out = path.resolve(values.out);
  let targets;
  try {
    if (positionals.length === 1 && values.manifest && !values.nodes) {
      const manifest = JSON.parse(fs.readFileSync(values.manifest, 'utf8'));
      targets = targetsFromManifest(manifest, { only: values.only?.split(',').map((s) => s.trim()), selectors: values.selector, out });
    } else if (positionals.length === 1 && !values.manifest && !values.only && values.selector.length <= 1) {
      const nodes = values.nodes?.split(',').map((n) => n.trim().replace('-', ':'));
      if (nodes?.length === 3) targets = [{ name: nodes.join(' | '), nodes, selector: values.selector[0], out }];
    }
  } catch (e) {
    console.error(e.message);
  }
  if (!targets) {
    console.error(USAGE);
    process.exit(2);
  }
  const { chromium } = createRequire(path.join(process.cwd(), 'package.json'))('playwright');
  const r = await visualCheck({ url: positionals[0], targets, mcp: clientFromEnv(), chromium });

  console.log('Look at them (Figma | Astro):');
  for (const t of r.targets) for (const f of t.images) console.log(`  ${f}`);
  const unchecked = r.targets.filter((t) => t.error);
  if (unchecked.length) {
    console.log('\nNOT CHECKED (no images, no text match):');
    for (const t of unchecked) console.log(`  ${t.name}: ${t.error}`);
  }
  const missing = r.targets.flatMap((t) => t.text.flatMap((x) => x.missing.map((m) => `  ${t.name} ${x.breakpoint} (${x.node}) missing in DOM: "${m}"`)));
  console.log(`\ntext: ${missing.length ? 'FAIL' : 'PASS'}`);
  for (const line of missing) console.log(line);
  const overflowOk = r.overflow.every((o) => o.ok);
  console.log(`overflow: ${overflowOk ? 'PASS' : 'FAIL'}`);
  for (const o of r.overflow.filter((o) => !o.ok)) console.log(`  ${o.width}px: scrollWidth ${o.scrollWidth}${o.offenders.length ? `; ${o.offenders.join(', ')}` : ''}`);
  if (unchecked.length || missing.length || !overflowOk) process.exit(1);
}
