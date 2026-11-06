# Security model

- **Only the public API.** The server calls `https://api.aiveed.io/v1/*` and nothing else: paths
  outside `/v1/`, including encoded dot segments, are refused in code, and redirects are never
  followed. (`AIVEED_API_URL` can point it at another HTTPS origin; whoever sets the environment
  chooses where the key goes.) URL inputs must be `https://`. It contains no AIVeed internal endpoints, service tokens or
  provider keys; everything it can do, the caller's API key can already do directly.
- **Keys.** stdio: read from `AIVEED_API_KEY`, sent only as the `X-API-Key` header, never in a URL,
  log line or tool result (responses are redacted before and after JSON parsing, and every tool
  result once more); redirects are not followed with the key attached. HTTP: each request
  brings its own key; the server keeps none and ignores `AIVEED_API_KEY`.
- **Spending and consent.** Generate tools and `upload_media` are annotated as non-read-only, and
  their descriptions say they spend credits or publish a file. Clients that honour annotations ask
  before running them; the server cannot enforce that, so do not auto-approve these tools. Every
  generate call sends an Idempotency-Key; pass your own and keep it, so a retry after a lost
  response never charges twice.
- **Local files** (`upload_media`, stdio only). Uploaded media gets a public URL, so the tool is off
  until the user lists folders in `AIVEED_MCP_UPLOAD_DIRS` (the agent cannot set it). A file must be
  given by absolute local path (network and device paths are refused before the filesystem is
  touched) and, after symlinks are resolved, be inside a listed folder and not hidden, inside a
  hidden folder (`~/.ssh`, `~/.config`, ...) or a system directory. It is opened once, without
  following a final symlink, and every later check (regular file, single hard link, unchanged path,
  size cap, bounded read) uses that descriptor. Its content must have a valid structure for its
  extension (chained MPEG/ADTS frames, PNG IHDR...IEND, ISO BMFF boxes to the end of the file, RIFF
  sizes), so renamed secrets and text files are refused. Refused and missing paths get the same
  answer, and an unsupported extension is refused by name before the file is looked up. After the
  file is opened it must still sit at the checked path, reached through real directories, with the
  same device and inode as the descriptor; on Windows a path through any symlink or junction is
  refused before it is resolved (it could lead to a network share).
- **URL inputs**, including URLs inside free-form records, must be `https://` to a host that is not
  loopback, private or link-local as written. The API enforces its own fetch rules as well. **Limit:** a file deliberately crafted to look like media, by something able to write
  into a listed folder, can pass content checks; list only folders that hold shareable media.
- **HTTP mode.** Binds to 127.0.0.1 by default (only `--host` or `AIVEED_MCP_HOST` change that),
  checks the Host header against an allow-list (DNS rebinding; not access control) and the Origin
  header when present, caps bodies at 1 MB and requests in flight at 64, times out slow clients, and
  keeps no sessions. Each request builds its own client from its own key. Put it behind a proxy
  with a rate limit.
- **Inputs.** Tool arguments are schema-validated; job ids are restricted to `[A-Za-z0-9_-]` and
  URL-encoded.
- **Tool results are data.** Results can carry text written by users (prompts, titles, file names)
  and by the API (error messages). The server tells the model to treat them as data, never as
  instructions; hosts should do the same.
- **Releases.** Made by the release workflow from the tip of `main`, with npm provenance and after
  a reviewer approves. The tarball is built and tested in a job with no credentials; the publishing
  job runs no package code. npm is set to accept trusted publishing from that workflow and to
  disallow tokens; an npm owner with two-factor authentication could still publish by hand, so
  owners are kept to a minimum and every genuine release carries provenance from this repository's
  workflow. Check it with `npm audit signatures`. `prepublishOnly` stops accidental local publishes.
- **HTTP mode limits.** One JSON-RPC message per request (batches are refused), at most 64 requests
  in flight, a slot held until the request's work has finished, and a closed connection aborts the
  work's upstream requests.

## Supported versions

The latest release receives security fixes.

## Reporting a vulnerability

Email support@aiveed.io with the details and steps to reproduce. Please do not open a public issue
for a security problem. We aim to reply within three working days.
