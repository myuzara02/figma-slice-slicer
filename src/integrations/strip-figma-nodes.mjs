// Astro integration: removes dev-only data-figma-node attributes from built HTML.
// Register it in the Target Project's astro.config.mjs: `integrations: [stripFigmaNodes()]`.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default function stripFigmaNodes() {
  return {
    name: 'strip-figma-nodes',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        for (const f of await fs.readdir(root, { recursive: true })) {
          if (!f.endsWith('.html')) continue;
          const file = `${root}/${f}`;
          const html = await fs.readFile(file, 'utf8');
          const stripped = html.replace(/\sdata-figma-node=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
          if (stripped !== html) await fs.writeFile(file, stripped);
        }
      },
    },
  };
}
