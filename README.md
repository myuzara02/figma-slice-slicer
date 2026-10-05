# Figma → Astro (Relume Styleguide)

Astro project with the `figma-slice` skill: give an agent a Figma page, get Astro Content Components
built on the Relume Styleguide, identical at 1440/834/393.

## Start a site

```bash
gh repo create my-site --private --template myuzara02/figma-slice-slicer --clone
cd my-site
npm install
```

Step by step (Bahasa Indonesia): [TUTORIAL.md](TUTORIAL.md).

## Slice a page

1. Open the Figma file in Figma desktop with the Dev Mode MCP server on.
2. Put the Figma Variables exports in `figma/`: `token-map.json`, `modes/*.tokens.json`, `static.json`.
3. Ask the agent: `/figma-slice <Figma link of the page>`.

The skill (`.agents/skills/figma-slice/SKILL.md`) does the rest and closes with a report.
Its **This project** section is this site's record of decisions.
