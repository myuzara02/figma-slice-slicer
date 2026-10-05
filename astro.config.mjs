import { defineConfig } from 'astro/config';
import stripFigmaNodes from './src/integrations/strip-figma-nodes.mjs';
import { SITE_URL } from './src/consts.ts';

// Installed once by the figma-slice skill, then the project's own (fonts, other integrations go here).
// Keep stripFigmaNodes(): built HTML must not carry the dev-only data-figma-node attributes.
export default defineConfig({
  site: SITE_URL,
  devToolbar: { enabled: false },
  integrations: [stripFigmaNodes()],
});
