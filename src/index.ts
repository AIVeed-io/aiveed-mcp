#!/usr/bin/env node
// aiveed-mcp: MCP server for the AIVeed API.
//   aiveed-mcp                     stdio, for Claude Desktop / Claude Code / Cursor (AIVEED_API_KEY)
//   aiveed-mcp --http [--port N] [--host H]   Streamable HTTP at /mcp; each caller sends their own key
// Logs go to stderr only: stdout is the MCP channel in stdio mode.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AiveedClient, isApiKey, normalizeBaseUrl } from './client.js';
import { startHttp } from './http.js';
import { createServer, VERSION } from './server.js';

const log = (msg: string) => process.stderr.write(`[aiveed-mcp] ${msg}\n`);
const list = (v: string | undefined, fallback: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes('--version')) return void process.stdout.write(`${VERSION}\n`);
  const baseUrl = normalizeBaseUrl(process.env.AIVEED_API_URL);

  if (process.argv.includes('--http')) {
    // Not the generic HOST/PORT variables: containers often set HOST=0.0.0.0, which would expose
    // the server without anyone choosing to.
    const host = arg('--host') || process.env.AIVEED_MCP_HOST || '127.0.0.1';
    const port = Number(arg('--port') || process.env.AIVEED_MCP_PORT || 8787);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) log(`binding to ${host}: put it behind a TLS proxy with a rate limit.`);
    if (process.env.AIVEED_API_KEY) log('AIVEED_API_KEY is ignored in --http mode: every request must bring its own key.');
    startHttp({
      host,
      port,
      baseUrl,
      allowedHosts: list(process.env.AIVEED_MCP_ALLOWED_HOSTS, ['localhost', '127.0.0.1', '[::1]']),
      allowedOrigins: list(process.env.AIVEED_MCP_ALLOWED_ORIGINS, []),
    });
    log(`listening on http://${host}:${port}/mcp`);
    return;
  }

  const apiKey = process.env.AIVEED_API_KEY?.trim();
  if (!apiKey) log('AIVEED_API_KEY is not set: only list_models will work. Create a key at https://developer.aiveed.io/keys');
  else if (!isApiKey(apiKey)) log('AIVEED_API_KEY does not look like an AIVeed key (aiv_sk_ followed by 64 hex characters).');

  const client = new AiveedClient({ apiKey: isApiKey(apiKey) ? apiKey : undefined, baseUrl, userAgent: `aiveed-mcp/${VERSION} (stdio)` });
  const server = createServer(client, { localFiles: true });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
