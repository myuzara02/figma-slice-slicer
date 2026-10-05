---
name: figma-slice
description: Slice a Figma page (desktop, tablet and mobile Breakpoint Frames) into Astro Content Components built on the Relume Styleguide, through the Figma desktop MCP. Use when the user gives a Figma page or node to build in Astro, asks to slice or implement a Figma design, to generate tokens.css from Figma Variables, or to set up the Relume template in an Astro project.
---

# Slicing Figma into Astro on the Relume Styleguide

Figma is the reference. Every Section of the page becomes one Astro **Content
Component** that looks like its Figma frame at 1440, 834 and 393px. The
component is built from **Base Components** and Relume classes whose values come
from Figma Variables through `tokens.css`. Scripts do the deterministic work:
the MCP cache, the Section Locator, `tokens.css`, assets and the visual check.
You do the judgement: structure, naming, reuse, and saying what you guessed.

**The rule that outranks the rest: never tune a Token, and never work around a
shared class, to make a Section match.** When a mismatch comes from the design
(copy, spacing or shadows that differ between frames with no variable behind
them), it goes into the report as a question.

Vocabulary: Section, Token, Token Mode (`desktop`/`tablet`/`mobile` set of
values), Breakpoint (desktop ≥992, tablet ≤991, mobile ≤767), Breakpoint Frame
(the Figma frame of one Breakpoint), Token Map (Figma Variable path → Relume
Token), Mode Pin (a part of a frame that uses another Token Mode), Base
Component, Content Component, Target Project (the Astro project this skill is
installed in).

## This project

**Read this before anything else, and write each decision here the moment it
is made.** Nothing below is recoverable from the code: a pair of Section names
was confirmed in conversation, a stale export was accepted, a width was chosen
for the container. The next session has this section and the repository.

Leave a field `—` until it is decided. The installer leaves this section blank
in a new Target Project and keeps it on re-install: it belongs to the project.

- **Figma file** — —
- **Pages** — —
- **Figma inputs** — —
- **Stale export** — —
- **Confirmed Section pairs** — —
- **Section order** — —
- **Container** — —
- **Layout** — —
- **Mode Pins** — —
- **Fonts** — —
- **Theme roles** — —
- **Dev server** — —
- **Verification** — —
- **Still open** — —

## Install

From a checkout of the skill repo, into an Astro project (`npm create astro@latest -- --template minimal` for a new one):

```bash
node skill/scripts/install.mjs <target>           # stops on conflicts, writes nothing
node skill/scripts/install.mjs <target> --force   # a fresh project: its stock astro.config.mjs and tsconfig.json are conflicts
cd <target>
npm install -D playwright @astrojs/check typescript && npx playwright install chromium
```

The installer copies the template (Relume base CSS, the default `tokens.css`
with Relume's values, Base Components, the Style Guide page), this skill and its
scripts, and adds the npm scripts below. `tokens.css` and `astro.config.mjs` are
seeds: written once, then the project's own. Re-installing updates the skill
(this file, keeping **This project**; the scripts) and adds template files the
project lacks. A template file the project changed (a Base Component fixed in
place) is a conflict: merge it by hand; `--force` takes the skill's version and
drops the project's change.

Put the Figma inputs in `figma/`: `token-map.json`, `modes/` (one
`*.tokens.json` export per Token Mode) and `static.json` (the single-mode
export: colors, font families, weights). The npm scripts read them from there.

The agreed structure of a Target Project:

```text
.agents/skills/figma-slice/   this file (This project = the project's record), scripts/, relume-tokens.css
.claude/skills/figma-slice    → ../../.agents/skills/figma-slice
.figma-cache/                 MCP responses per tool+node, assets, screenshots, calls.log (commit it: re-runs are free)
figma/                        token-map.json, modes/*.tokens.json, static.json
figma-slice.json              manifest of the last slice run
visual-check/<slug>/          Figma | Astro per Breakpoint (gitignored)
astro.config.mjs              stripFigmaNodes() and the project's fonts
src/assets/<slug>/            assets of one Section, named after their Figma layers
src/components/{wrapper,typography,item,media,interactive,form,global,utility}/   Base Components
src/components/content/       Content Components: one per Section, Navbar and Footer included
src/content/                  CMS collections (phase 2)
src/layouts/                  BaseLayout.astro (template), Page.astro (the project's: navbar, footer, project.css)
src/pages/                    pages, style-guide.astro
src/styles/                   global.css (layers), reset.css, tokens.css, relume-patterns.css, relume-utilities.css, project.css
```

## Run

Figma desktop must be open on the file with the Dev Mode MCP server on. Every
script reads the MCP through `.figma-cache/` first: a cached node costs nothing,
a live call is logged in `.figma-cache/calls.log`. A homepage of 13 Sections
costs about 70–90 live calls once. `FORCE=1` refetches.

1. **Read This project.**

2. **Generate `tokens.css`.** `npm run tokens -- <node ids…>` (the page's
   Breakpoint Frames, later every Section too: their text styles carry the
   letter-spacing). Values per Token Mode come from the exports, never from MCP
   numbers; live `get_variable_defs` only checks that the exports are current.
   - `STOP` → ask (see below). Do not write `tokens.css` by hand.
   - `UNMAPPED` → add a rule or alias to `figma/token-map.json` and re-run.
     Rules map a Figma path prefix to a Token name prefix; the longest prefix
     wins; aliases (exact path) win over rules.
   - `DIFFERS` / `ONLY HERE` compare against Relume's default values: read
     them, they are not errors.

3. **Get the page.** The user gives the Figma node (URL or id) holding the
   three Breakpoint Frames. `npm run slice -- <node>` locates every Section by
   name in the three frames, then per Section and Breakpoint fetches
   `get_design_context` (code, reference screenshot, assets), child metadata
   where the root is empty, and `get_variable_defs` on tablet and mobile for
   Mode Pin detection. It copies assets to `src/assets/<slug>/` and writes
   `figma-slice.json`.
   - Exit 1 with a name mismatch → ask (see below), then re-run with
     `--pair '<desktop>=<tablet>[=<mobile>]'` and record the pair here.
   - Order warning → build in desktop order and report it.
   - Re-running after assets were curated: `--no-assets` (otherwise deleted
     assets come back). `--only <name>,…` limits the run.

4. **Build every Section in one run.** For each Section in the manifest, read
   its `get_design_context` code and screenshot per Breakpoint
   (`.figma-cache/get_design_context__<node>.json` / `.png`), its assets, Mode
   Pin candidates and unaddressable instances, then write
   `src/components/content/<Name>.astro` by the rules below. Compose the page in
   `src/pages/` from `src/layouts/Page.astro`, Sections in desktop order.
   - The project's first page creates `src/layouts/Page.astro`: `BaseLayout`
     with `import "@/styles/project.css"`, Navbar in the `nav` slot and Footer
     in the `footer` slot. `src/styles/project.css` holds the project's
     overrides of Relume values in the same layers (`@layer utilities {
     .container-large { max-width: …; } }`); record each in This project.
   - Sections may be built in parallel by subagents. Give each the rules
     below and **This project**. A subagent does not patch shared code: it
     reports `Base Component gap: <what>` and you fix it once, in the Base
     Component or `src/styles/project.css`.

5. **Visual check.** Start the dev server, then
   `npm run visual-check -- <url> --manifest figma-slice.json` checks every
   Section in one browser session: Figma | Astro side by side per Breakpoint in
   `visual-check/<slug>/`, every Figma text present in the DOM, no horizontal
   scroll at 360/480/768/992/1200px. A Section's selector is `.<slug>_wrap`;
   override with `--selector '<name>=<css>'` (several elements shoot as one, e.g.
   a hero with the navbar laid over it).
   - **Look at every image.** The checks prove text and overflow, not looks.
   - Look at the page wider than the desktop frame too (1920px): every Section
     stays inside its container.
   - Fix what is yours and re-run. What the design causes goes to the report.

6. **Verify.** `npx astro check` and `npx astro build` (the build strips
   `data-figma-node`); `npm run audit-props` after changing a Base Component.
   Use **Verification** in This project when it says otherwise.

7. **Report** (below).

## Stop and ask: only these

1. **Section names do not match** across the three frames (`slice` exits 1).
   Show the names per frame; the user says which belong together.
2. **Export colors are stale** (`tokens` prints `STOP`): the export differs
   from Figma live, or two Variables give one Token different values. The user
   re-exports, or accepts the live colors (`--live-colors`); record which.

Everything else is decided, labelled as a guess where it is one, and reported.
Questions for the design (inconsistent copy between frames, a Section wider
than the project container, shadows with no variable) go to **Still open**.

## Rules

### Values

- From MCP output take only Variable names. Values come from `tokens.css`
  (`var(--…)`); MCP fallback numbers are wrong on tablet and mobile.
- A value bound to no Variable is written as-is in the component CSS with
  `/* unbound */` and listed in the report. No rounding to a nearby Token.
- Lengths in `rem` (px ÷ 16), letter-spacing and text-relative sizes in `em`,
  text measures in `ch` when they follow the text. `px` only in `@media`.
- Breakpoints: `@media screen and (max-width: 991px)` and `(max-width: 767px)`.
  No 479px rule, no `clamp()` Tokens.
- **Mode Pin:** `slice` lists candidates (`mobile→tablet` with the Variables
  whose live value is the other mode's). Find the subtree whose values those
  are and put `u-mode-<mode>` on its root.
- Every guess carries a comment at the site and an entry under **Guesses**: a
  theme role picked for a color with none, a value the frames do not show.

### Structure

- One Content Component per Section in `src/components/content/`, rendering the
  `Section` Base Component with `class="<family>_wrap"`. Children are
  `<family>_<role>`, named by role, not mechanism. Variants (Breakpoint or
  state) are `is-*` classes on the family class (`difference_heading is-mobile`),
  never role names with a Breakpoint in them.
- **Base Components first** (`Section`, `Heading`, `Paragraph`, `Eyebrow`,
  `Button`, `Card`, `Img`, `Icon`, `AccordionItem`, `Grid`, …). Raw markup where
  a Base Component covers the role needs a reason in the report.
- Styles live in the component file: `<style is:global>` with `@layer
  components { … }`. No scoped styles; pages carry no CSS.
- One DOM for all Breakpoints: media queries, `order`, hide classes. Copy that
  differs between frames gets two DOM copies toggled by media query only once
  This project records the user's confirmation; until then build them, label
  them as a guess and ask under **Still open**.
- Auto-layout becomes flex or grid. `position: absolute` only where the design
  overlays (backgrounds, a navbar over the hero).
- Composite graphics (collages, composite logos): `container-type:
  inline-size`, `aspect-ratio`, every length in `cqw`.
- Text that is the same in every use is written in the component; text that
  differs per use is a prop.
- Main elements carry `data-figma-node="<desktop>|<tablet>|<mobile>"` (`-` for
  a node missing or unaddressable in that frame).
- **Containers:** content sits in the `Section` container. The project's width
  lives in `src/styles/project.css` (see **Container** in This project), never
  per Section, and no Section lifts the cap (`max-width: none`). A Section that
  only matches Figma by working around a shared class is a finding.
- **One fix, one place.** A declaration several Content Components repeat (an
  `object-fit`, a gutter, a padding pattern) is a missing default of a Base
  Component, the Relume base CSS or `project.css`. Fix it there.

### Assets

- SVGs are imported as components (`Icon` or inline `<Svg />`); photos go
  through `Img` (Astro `<Image>`, `object-fit: cover` by default).
- Delete assets the Section does not use; re-run `slice` with `--no-assets`.
- A masked or placeholder asset (one image for several icons, a mask over a
  logo) is not redrawn: fetch the node itself with
  `npm run mcp -- get_screenshot <node>` (the PNG lands in `.figma-cache/`) or
  ask the user for the export. Anything made up is labelled at the site and
  reported as a guess.

## Report

Close the run with this, in Markdown, every heading present. An empty list says
"none".

```markdown
## Report: <page> (<Figma node>)

### New variables
Token Map rules or aliases added, Tokens new in tokens.css: name, value, what asked for it.

### New components
Base Components added or extended, and why nothing existing covered it. Content Components built.

### Guesses
Theme roles picked for unmapped colors, redrawn or substituted assets, structure the frames did not show. Where each sits.

### Unbound values
Per kind (colors, gradients, shadows, sizes), with the Section. The CSS marks each `/* unbound */`.

### Mode Pin
Per Section: Breakpoint → mode, the subtree, the Variables that showed it. Or none.

### Visual check
text PASS/FAIL, overflow PASS/FAIL, images in visual-check/. What still differs when looked at, per Section and Breakpoint.

### MCP calls
Live calls this run (lines added to `.figma-cache/calls.log`) and per Section (`calls` in figma-slice.json: the cost without cache).

### Still open
Questions for the design or the user, Base Component gaps not yet fixed, follow-ups.
```

## Scripts

All in `scripts/`, plain Node, run in the Target Project through npm.

| npm script | Does |
| --- | --- |
| `mcp -- <tool> <node> [json]` | One MCP call through the cache (`get_screenshot` for a masked asset) |
| `locate -- <node> [--pair …]` | Section Locator only: Sections per frame, mismatches, order |
| `slice -- <node> [--pair …] [--only …] [--no-assets]` | Everything the build needs, manifest `figma-slice.json` |
| `tokens -- [--live-colors] <node…>` | `tokens.css` from the Token Map and exports; stale check |
| `visual-check -- <url> --manifest figma-slice.json` | Figma \| Astro per Section and Breakpoint, text and overflow checks |
| `audit-props` | Base Component props read as one API |
