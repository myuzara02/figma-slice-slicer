# Figma → Astro (Relume Styleguide)

Astro project with the `figma-slice` skill: give an agent a Figma page, get Astro Content Components
built on the Relume Styleguide, identical at desktop 1440, tablet 834 and mobile 393.

## What you need

- Node.js 22.12 or newer
- Figma **desktop** (not the browser) with Dev Mode
- An agent that reads skills: omp or Claude Code

## 1. Create a site

```bash
npx degit myuzara02/figma-slice-slicer my-site
# or, as your own GitHub repo:
# gh repo create my-site --private --template myuzara02/figma-slice-slicer --clone
cd my-site
npm install        # also downloads Chromium for the visual check
npm run dev        # http://localhost:4321/style-guide/ shows the Relume base
```

## 2. Prepare the Figma file

1. One page = one node holding three frames: desktop 1440, tablet 834, mobile 393.
2. The direct children of each frame are Sections (hero, features, footer, …) with **the same name** in all three frames.
3. Values use Figma Variables: a responsive collection with one mode per Breakpoint, and a single-mode collection for colors and fonts.

## 3. Export the Variables into `figma/`

Export each collection with your Variables-export plugin (one JSON per collection, with `modes` and `valuesByMode`):

```text
figma/
  Responsive.json   ← responsive collection (desktop, tablet, mobile modes)
  Static.json       ← single-mode collection: colors, font families, weights
  token-map.json    ← already here: Figma variable names → Relume Token names
```

`token-map.json` fits Figma files named like `font-size/heading/h1`, `padding/1_5rem`, `color/primary/60`, with modes
`dekstop`, `tablet`, `mobile`. If your names differ, the agent reports them as `UNMAPPED`: ask it to complete the Token Map.

## 4. Turn on the Figma MCP server

Open the design in Figma desktop, switch to Dev Mode and enable the **MCP server** (`http://127.0.0.1:3845/mcp`).
Keep Figma open while the agent works.

## 5. Slice a page

In Figma, right-click the page node (the one holding the three frames) → **Copy link to selection**. Open the agent in
`my-site` and type:

```text
/figma-slice slice this page: <Figma link>
```

The agent generates `src/styles/tokens.css` from `figma/`, finds every Section, downloads the assets, builds one component
per Section (navbar and footer in `src/layouts/Page.astro`), composes the page, compares it with Figma, and closes with a report.

It stops for two things only:

| Question | Your answer |
|---|---|
| Section names differ across the frames (e.g. `Alt - 01` vs `header`) | Say which belong together, or rename them in Figma |
| Export colors differ from Figma live | Re-export, or say which is right: the export or Figma live |

Decisions are recorded in the **This project** section of `.agents/skills/figma-slice/SKILL.md`, so they are not asked again.

## 6. Check the result

```bash
npm run dev
```

- Open the page at 1440, 834, 393 and wider (1920).
- `visual-check/<section>/{desktop,tablet,mobile}.png`: Figma left, Astro right.
- Read the report: new variables, new components, guesses, unbound values, Mode Pin, visual check, MCP calls, still open.
- Ask the agent to fix what does not match. For the next page, repeat step 5 with its link.

## Tips

- Commit `.figma-cache/`: re-runs cost no MCP calls. A 13-Section homepage takes about 70–90 calls the first time
  (the desktop MCP allows about 200 a day).
- `npm run build` writes `dist/` without the dev-only `data-figma-node` attributes.

## Common problems

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:3845` | Figma desktop is closed or its MCP server is off |
| `UNMAPPED Figma Variables` | Names the Token Map does not cover: ask the agent to complete `figma/token-map.json` |
| `no Token Mode export named …` | The mode names in `figma/token-map.json` (`modes`) differ from the ones in Figma |
| `STOP: tokens.css not written` | Stale export colors: re-export, or tell the agent whether the export or Figma live is right |
| Visual check `NOT CHECKED` | A Section's wrapper class is not `<section>_wrap`; the agent passes `--selector` |
