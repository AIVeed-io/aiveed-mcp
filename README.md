# aiveed-mcp

MCP server for the [AIVeed API](https://api.aiveed.io/docs): generate AI videos, images and audio
(Veo 3.1, Seedance, Kling, Wan, Grok Imagine, GPT Image, Nano Banana and more) from Claude, Cursor,
VS Code or any MCP client. Generations are paid in AIVeed credits from your own account.

It talks only to the public REST API at `https://api.aiveed.io/v1`, with your API key. It holds no
other credentials and can do nothing your key could not already do with curl.

## Tools

| Tool | What it does | Credits |
|---|---|---|
| `list_models` | Live model catalog: options, accepted inputs, prices (no key needed) | free |
| `get_credits` | Your balance | free |
| `generate_video` / `generate_image` / `generate_audio` | Start a job, returns a job id | spends |
| `extend_video` | Add ~7 s to a completed Veo 3.1 video | spends |
| `get_job` | Job status; `wait_seconds` polls until it finishes | free |
| `list_jobs`, `list_videos`, `list_images` | Your jobs and media (permanent URLs) | free |
| `cancel_job` | Cancel a queued job (refunded) | free |
| `upload_media` | Upload a local image/audio/video as an input (stdio only) | free |

Every generate call sends an `Idempotency-Key` (returned in the result), so a retry with the same
key never charges twice. Failed jobs are refunded automatically.

## Setup

Create an API key at <https://developer.aiveed.io/keys>. Node.js 20 or newer is required. Step-by-step
setup for each client: <https://api.aiveed.io/docs/mcp>.

**Claude Code**

```bash
claude mcp add aiveed -e AIVEED_API_KEY=aiv_sk_... -- npx -y aiveed-mcp
```

**Claude Desktop and Cursor** (`claude_desktop_config.json`, `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "aiveed": {
      "command": "npx",
      "args": ["-y", "aiveed-mcp"],
      "env": { "AIVEED_API_KEY": "aiv_sk_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`, or **MCP: Add Server** in the command palette):

```json
{
  "servers": {
    "aiveed": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "aiveed-mcp"],
      "env": { "AIVEED_API_KEY": "aiv_sk_..." }
    }
  }
}
```

Pin a version (`aiveed-mcp@0.1.1`) if you prefer upgrades to be deliberate.

### Local files

`upload_media` turns a local file into a URL a model can use. That URL is public, so the tool is
**off until you list the folders it may read** in `AIVEED_MCP_UPLOAD_DIRS`, for example
`"AIVEED_MCP_UPLOAD_DIRS": "~/Videos/aiveed-inputs"`. List folders that hold only media you are
happy to share; a folder for generation inputs is ideal. Even inside them the tool never reads
hidden files or folders, system directories or hard-linked files, and only uploads real image,
audio and video files (checked by their content, not just the name).

Generate tools spend credits and `upload_media` publishes a file, so keep your client's approval
prompt on for them rather than auto-approving.

## HTTP mode (hosting)

```bash
node dist/index.js --http --port 8787 --host 127.0.0.1
```

Streamable HTTP at `POST /mcp`, stateless. `--host`/`--port` (or `AIVEED_MCP_HOST`/`AIVEED_MCP_PORT`)
set the address. Every request must carry its caller's own key
(`Authorization: Bearer aiv_sk_...`); `AIVEED_API_KEY` is ignored, so a hosted instance never spends
anyone else's credits. `upload_media` is not offered (it would read the host's disk).

| Variable | Default | |
|---|---|---|
| `AIVEED_MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host header names accepted (a DNS-rebinding guard, not access control); add your public hostname behind a proxy |
| `AIVEED_MCP_ALLOWED_ORIGINS` | none | Browser origins allowed; requests without an Origin header are allowed |
| `AIVEED_API_URL` | `https://api.aiveed.io` | API origin (https only; http allowed for localhost) |

Run it behind a TLS-terminating proxy with a rate limit; it binds to 127.0.0.1 by default and
answers 503 beyond 64 requests in flight.

## Development

```bash
npm ci
npm test            # vitest; no network, the API is faked
npm run typecheck
npm run build       # dist/
npm run leak-scan   # credentials, private addresses, personal paths
```

Work happens on `development`; `main` holds released code. See [SECURITY.md](SECURITY.md) for the
security model and [RELEASING.md](RELEASING.md) for how releases are published.

## License

MIT
