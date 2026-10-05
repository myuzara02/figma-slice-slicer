#!/usr/bin/env node
// Figma desktop MCP client with a per tool+node cache.
//
// Library: createMcpClient({ cacheDir, endpoint?, force? }).call(tool, nodeId, args?)
//   → { source: 'cache'|'live', result, assets: [{ name, hash, file, missing }], images: [file] }
// CLI:     node mcp.mjs <tool> <nodeId> [jsonArgs]   (FORCE=1 to refresh, FIGMA_CACHE_DIR to relocate)
//
// Cache layout (commit it):
//   <tool>__<node>.json     raw MCP tool result
//   <tool>__<node>[_N].png  image content blocks (screenshots)
//   assets/<hash>.<ext>     assets (hash field includes the extension) of get_design_context, downloaded right after the live call (ADR 0006)
//   calls.log               one line per live call
// Key is tool+node only: args (e.g. excludeScreenshot) do not split the cache; FORCE=1 to refetch with other args.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:3845/mcp';
const DEFAULT_ARGS = { clientLanguages: 'html,css,typescript', clientFrameworks: 'astro' };

// Only real asset constants at line start; the instruction text's inline example
// ("e.g. const image = '…'") is not at line start and is ignored.
const ASSET_CONST = /^const (\w+) = ["'](https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/assets\/([\w.-]+))["'];?$/gm;

export function parseAssets(result) {
  const seen = new Map();
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    for (const [, name, url, hash] of block.text.matchAll(ASSET_CONST)) if (!seen.has(name)) seen.set(name, { name, url, hash });
  }
  return [...seen.values()];
}

export function createMcpClient({ cacheDir, endpoint = DEFAULT_ENDPOINT, force = false }) {
  const assetDir = path.join(cacheDir, 'assets');
  let session;
  let ready;
  let nextId = 1;

  async function post(body) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP ${body.method}: HTTP ${res.status}`);
    session = res.headers.get('mcp-session-id') ?? session;
    return res.text();
  }

  // JSON-RPC request; the reply may be plain JSON or an SSE stream that also carries notifications.
  async function request(method, params) {
    const id = nextId++;
    const text = await post({ jsonrpc: '2.0', id, method, params });
    const messages = text.trimStart().startsWith('{')
      ? [JSON.parse(text)]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
    const msg = messages.find((m) => m.id === id);
    if (!msg) throw new Error(`MCP ${method}: no response for request ${id}`);
    if (msg.error) throw new Error(`MCP ${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }

  function connect() {
    ready ??= (async () => {
      await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'figma-astro-skill', version: '1' },
      });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    return ready;
  }

  async function download(asset) {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`asset ${asset.name} (${asset.hash}): HTTP ${res.status}`);
    return { ...asset, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  // Image content blocks paired with their sidecar file: <key>.png, <key>_2.png, …
  const imageFiles = (key, result) =>
    (result.content ?? [])
      .filter((block) => block.type === 'image')
      .map((block, i) => ({ block, file: path.join(cacheDir, `${key}${i ? `_${i + 1}` : ''}.png`) }));

  function describe(key, result) {
    const assets = parseAssets(result).map(({ name, hash }) => {
      const file = path.join(assetDir, hash);
      return { name, hash, file, missing: !fs.existsSync(file) };
    });
    return { assets, images: imageFiles(key, result).map((i) => i.file) };
  }

  return {
    async call(tool, nodeId, args = {}) {
      const key = `${tool}__${nodeId.replaceAll(':', '-')}`;
      const cacheFile = path.join(cacheDir, `${key}.json`);
      if (!force && fs.existsSync(cacheFile)) {
        const result = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return { source: 'cache', result, ...describe(key, result) };
      }

      await connect();
      const result = await request('tools/call', { name: tool, arguments: { nodeId, ...DEFAULT_ARGS, ...args } });
      if (result.isError) throw new Error(`${tool} ${nodeId}: ${result.content?.map((c) => c.text).join(' ')}`);

      // Asset URLs expire once another node is requested: fetch all before writing anything.
      const downloaded = tool === 'get_design_context' ? await Promise.all(parseAssets(result).map(download)) : [];

      fs.mkdirSync(assetDir, { recursive: true });
      for (const a of downloaded) fs.writeFileSync(path.join(assetDir, a.hash), a.bytes);
      for (const { block, file } of imageFiles(key, result)) fs.writeFileSync(file, Buffer.from(block.data, 'base64'));
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 1));
      const extra = Object.keys(args).length ? ` ${JSON.stringify(args)}` : '';
      fs.appendFileSync(path.join(cacheDir, 'calls.log'), `${new Date().toISOString()} ${tool} ${nodeId}${extra}\n`);
      return { source: 'live', result, ...describe(key, result) };
    },
  };
}

// Client configured from FIGMA_CACHE_DIR, FIGMA_MCP_URL and FORCE=1 (shared by the CLIs).
export function clientFromEnv(env = process.env) {
  return createMcpClient({
    cacheDir: path.resolve(env.FIGMA_CACHE_DIR ?? '.figma-cache'),
    endpoint: env.FIGMA_MCP_URL ?? DEFAULT_ENDPOINT,
    force: env.FORCE === '1',
  });
}

// Text content blocks of an MCP tool result, joined.
export const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tool, nodeId, extra] = process.argv.slice(2);
  if (!tool || !nodeId) {
    console.error('usage: mcp.mjs <tool> <nodeId> [jsonArgs]   (FORCE=1 refreshes, FIGMA_CACHE_DIR sets cache dir)');
    process.exit(2);
  }
  const mcp = clientFromEnv();
  const r = await mcp.call(tool, nodeId, extra ? JSON.parse(extra) : {});
  console.error(`[${r.source}] ${tool} ${nodeId}`);
  for (const block of r.result.content ?? []) if (block.type === 'text') console.log(block.text);
  for (const f of r.images) console.log(`[image] ${f}`);
  for (const a of r.assets) console.log(`[asset] ${a.name} ${a.missing ? 'MISSING' : a.file}`);
}
