# Tutorial: from Figma to an Astro page

This tutorial takes you from nothing to one Figma page built as an Astro page that matches the design on desktop (1440), tablet (834) and mobile (393).

## What you need

- Node.js 22.12 or newer
- Figma **desktop** (not the browser), with Dev Mode access
- An agent that reads skills: omp or Claude Code
- Optional: GitHub CLI (`gh`)

## 1. Create a site

Pick one:

```bash
# A. As your own GitHub repo
gh repo create my-site --private --template myuzara02/figma-slice-slicer --clone

# B. Without GitHub
npx degit myuzara02/figma-slice-slicer my-site
```

Then:

```bash
cd my-site
npm install        # also downloads Chromium for the visual check
npm run dev        # open http://localhost:4321/style-guide/ to see the Relume base
```

## 2. Prepare the design in Figma

The skill relies on a tidy Figma file. Make sure that:

1. **One page = one node holding three frames**: desktop 1440, tablet 834, mobile 393.
2. **The direct children of each frame are Sections** (hero, features, footer, …) with **the same name** in all three frames. If they differ, the skill asks.
3. **Values use Figma Variables** (font size, spacing, radius, colors), with one mode per Breakpoint for the responsive variables.

## 3. Export the Variables into `figma/`

Export the Variables from Figma (the `.tokens.json` format, carrying `com.figma.*` `$extensions`) and lay them out like this:

```text
figma/
  modes/
    desktop.tokens.json     ← one file per mode of the responsive collection
    tablet.tokens.json
    mobile.tokens.json
  static.json               ← the single-mode collection: colors, font families, weights
  token-map.json            ← Figma variable names → Relume Token names
```

The mode name is read from the file's content, not its file name.

**`token-map.json`** maps Figma variable paths to Relume Token names with prefix rules. A minimal example:

```json
{
  "modes": { "desktop": "desktop", "tablet": "tablet", "mobile": "mobile" },
  "variables": {
    "rules": [
      { "prefix": "font-size/heading/", "token": "--_typography---font-size--" },
      { "prefix": "spacing/", "token": "--_sizing---space--" },
      { "prefix": "color/", "token": "--_primitives---colors--" }
    ],
    "aliases": {}
  }
}
```

`modes` holds the mode names **exactly as in Figma** (e.g. `"dekstop"` if Figma spells it that way). The skill reports every variable the map does not cover yet, so the map can grow as you go.

## 4. Turn on the Figma MCP server

1. Open the design file in Figma desktop.
2. Switch to Dev Mode and enable the **MCP server** (it runs at `http://127.0.0.1:3845/mcp`).
3. Keep Figma open while the skill works.

## 5. Slice a page

1. In Figma, right-click the page node (the one holding the three frames) → **Copy link to selection**.
2. Open the agent in `my-site` and type:

```text
/figma-slice slice this page: <Figma link>
```

The agent then works on its own:

1. Generates `src/styles/tokens.css` from the exports in `figma/`.
2. Finds every Section in the three frames and downloads the assets to `src/assets/<section>/`.
3. Builds one component per Section in `src/components/content/`, the navbar and footer in `src/layouts/Page.astro`, and the page in `src/pages/`.
4. Compares the result with Figma (images in `visual-check/`) and checks text and horizontal scroll.
5. Closes with a report.

### The agent stops for two things only

| Question | Your answer |
|---|---|
| Section names differ across the three frames (e.g. `Alt - 01` vs `header`) | Say which ones belong together, or rename them in Figma |
| Export colors differ from Figma live (stale export) | Re-export, or accept the live colors |

Every decision is recorded in the **This project** section of `.agents/skills/figma-slice/SKILL.md`, so the next session does not ask again.

## 6. Check the result

```bash
npm run dev
```

- Open the page at 1440, 834, 393 and wider (e.g. 1920).
- Look at `visual-check/<section>/{desktop,tablet,mobile}.png`: Figma on the left, Astro on the right.
- Read the agent's report:

| Section | Contents |
|---|---|
| New variables | New Tokens in the Token Map / tokens.css |
| New components | Components built or extended |
| Guesses | What the agent guessed (colors without a role, substitute assets) |
| Unbound values | Figma values that use no variable |
| Mode Pin | Parts that use another Breakpoint's mode |
| Visual check | Check results and differences still visible |
| MCP calls | MCP quota used |
| Still open | Questions for the design or for you |

Ask the agent to fix what does not match yet. Differences that come from the design (e.g. copy that differs between frames) are answered as decisions, and the agent records them.

## 7. The next page

Repeat step 5 with another page's link. Existing components are reused, and MCP responses already stored in `.figma-cache/` are not fetched again.

## Tips

- **Commit `.figma-cache/`**: re-runs become free. The desktop MCP quota is limited (about 200 calls a day; a 13-Section homepage takes ≈ 70–90 calls the first time).
- **Build**: `npm run build` produces `dist/` without the `data-figma-node` debug attributes.
- **When something breaks**: send the error to the agent; it reads the skill and fixes it.

## Common problems

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:3845` | Figma desktop is closed or the MCP server is off |
| `UNMAPPED Figma Variables` | Add a rule or alias to `figma/token-map.json` |
| `no Token Mode export named …` | A name in the Token Map's `modes` differs from the mode name in Figma |
| `STOP: tokens.css not written` | Stale export colors: re-export or accept the live colors |
| Visual check `NOT CHECKED` | The Section's wrapper class is not `<section>_wrap`; the agent passes `--selector` |
