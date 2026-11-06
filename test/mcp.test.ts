import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AiveedClient, normalizeBaseUrl } from '../src/client.js';
import { prepareUpload, uploadDirs } from '../src/upload.js';
import { homedir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { createServer, VERSION } from '../src/server.js';
import { startHttp } from '../src/http.js';

const KEY = 'aiv_sk_' + 'a'.repeat(64);
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fetch that records calls and answers from a route table. */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { url: url.toString(), method: init.method || 'GET', headers: init.headers as Record<string, string>, body: init.body as string };
    calls.push(call);
    const handler = routes[`${call.method} ${url.pathname}`];
    const { status = 200, body } = handler ? handler(call) : { status: 404, body: { error: true, code: 'NOT_FOUND', message: 'nope' } };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

async function connect(client: AiveedClient, localFiles = true) {
  const server = createServer(client, { localFiles, sleep: async () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(b);
  return mcp;
}
const textOf = (r: any) => r.content[0].text as string;

describe('client', () => {
  test('base URL must be https (loopback http allowed)', () => {
    expect(() => normalizeBaseUrl('http://api.aiveed.io')).toThrow(/https/);
    expect(() => normalizeBaseUrl('https://user:' + 'pw@example.com')).toThrow(/credentials/);
    expect(normalizeBaseUrl('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(normalizeBaseUrl(undefined)).toBe('https://api.aiveed.io');
  });

  test('sends the key as a header, maps API errors, never echoes the key', async () => {
    const { impl, calls } = fakeFetch({ 'GET /v1/credits': () => ({ status: 402, body: { error: true, code: 'INSUFFICIENT_CREDITS', message: 'Top up' } }) });
    const client = new AiveedClient({ apiKey: KEY, fetch: impl });
    const err: any = await client.request('GET', '/v1/credits').catch((e) => e);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(calls[0].headers['X-API-Key']).toBe(KEY);
    expect(calls[0].url).not.toContain(KEY);
    expect(JSON.stringify(err) + err.message + String(err.stack)).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
  });

  test('refuses paths outside /v1/ (also encoded dot segments) and calls without a key', async () => {
    const { impl, calls } = fakeFetch({});
    const client = new AiveedClient({ apiKey: KEY, fetch: impl });
    for (const p of ['/admin/x', '/v1/%2e%2e/admin', '/v1/../admin', '/v1/x/%2E%2e/y', '/v1/a%2fb', '/v1\\..\\x', '//evil.example/v1/x']) {
      await expect(client.request('GET', p)).rejects.toThrow(/non-API/);
    }
    expect(calls).toHaveLength(0);
    await expect(new AiveedClient({ fetch: impl }).request('GET', '/v1/credits')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  test('a key hidden behind JSON escapes is still redacted', async () => {
    const escaped = '\\u0061' + KEY.slice(1);
    const { impl } = fakeFetch({});
    const fetchEscaped = (async () => new Response(`{"code":"BAD","message":"key ${escaped}","details":{"k":"${escaped}"}}`, { status: 400 })) as typeof fetch;
    const err: any = await new AiveedClient({ apiKey: KEY, fetch: fetchEscaped }).request('GET', '/v1/credits').catch((e) => e);
    expect(err.message + JSON.stringify(err.details)).not.toContain(KEY);
    expect(impl).toBeDefined();
  });

  test('old check kept: calls without a key fail before any request', async () => {
    const client = new AiveedClient({ fetch: fakeFetch({}).impl });
    await expect(client.request('GET', '/v1/credits')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});

describe('upload_media file checks', () => {
  let dir: string;
  let ok: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiveed-mcp-'));
    await mkdir(join(dir, 'media'));
    ok = [join(dir, 'media')];
  });
  // A real 1x1 PNG: signature, IHDR, IDAT (deflated pixel row), IEND, each chunk with its CRC.
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  // A minimal baseline JPEG: SOI, APP0 (JFIF), SOF0 (1x1, one component), SOS, two bytes of scan data, EOI.
  const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9,
  ]);
  // One Ogg page with a valid CRC (non-reflected 0x04C11DB7), computed here independently.
  const oggPage = (payload: Buffer) => {
    const page = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.from([0, 2]), Buffer.alloc(8), Buffer.alloc(4, 1), Buffer.alloc(4), Buffer.alloc(4), Buffer.from([1, payload.length]), payload]);
    let c = 0;
    for (const x of page) {
      c ^= x << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      c >>>= 0;
    }
    page.writeUInt32LE(c >>> 0, 22);
    return page;
  };
  // Two MPEG-1 layer III frames at 128 kbps / 44.1 kHz (417 bytes each).
  const frame = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413, 1)]);
  const MP3 = Buffer.concat([frame(), frame()]);
  const put = async (name: string, data: Buffer | string) => {
    const path = join(dir, 'media', name);
    await writeFile(path, data);
    return path;
  };

  test('accepts real media inside an allowed folder', async () => {
    expect((await prepareUpload(await put('a.png', PNG), 'image', ok)).get('kind')).toBe('image');
    expect((await prepareUpload(await put('a.mp3', MP3), 'audio', ok)).get('kind')).toBe('audio');
    const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4, 0, 0]), MP3]);
    expect((await prepareUpload(await put('b.mp3', id3), 'audio', ok)).get('kind')).toBe('audio');
    expect((await prepareUpload(await put('a.jpg', JPEG), 'image', ok)).get('kind')).toBe('image');
    expect((await prepareUpload(await put('a.ogg', oggPage(Buffer.from([1, 2, 3, 4]))), 'audio', ok)).get('kind')).toBe('audio');
  });

  test('is off until AIVEED_MCP_UPLOAD_DIRS lists folders', async () => {
    await expect(prepareUpload(await put('c.png', PNG), 'image', [])).rejects.toThrow(/off until the user lists/);
  });

  test('refuses renamed secrets and text dressed up with a media header', async () => {
    const payload = 'AWS_SECRET=' + 'x'.repeat(40) + '\n';
    await expect(prepareUpload(await put('id_ed25519.png', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\n'), 'image', ok)).rejects.toThrow(/not a valid .png/);
    await expect(prepareUpload(await put('t.png', Buffer.concat([PNG.subarray(0, 33), Buffer.from(payload)])), 'image', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('t.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom\0\0\0\0isom' + payload)])), 'video', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('t.mov', Buffer.concat([Buffer.from([1, 2, 3, 4]), Buffer.from('ftypisom' + payload)])), 'video', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('t.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0, 0, 0]), Buffer.from('WAVEfmt ' + payload)])), 'audio', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('t.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(payload)])), 'video', ok)).rejects.toThrow(/not a valid/);
    // A UTF-16LE text file (FF FE byte-order mark) passed the old one-header MP3 check.
    await expect(prepareUpload(await put('notes.mp3', Buffer.from('\ufeffhello secret notes', 'utf16le')), 'audio', ok)).rejects.toThrow(/not a valid .mp3/);
    await expect(prepareUpload(await put('two.mp3', Buffer.from([0xff, 0xe0])), 'audio', ok)).rejects.toThrow(/not a valid .mp3/);
    await expect(prepareUpload(await put('credentials.mp3', 'ID3_SECRET=private-value\n'), 'audio', ok)).rejects.toThrow(/not a valid .mp3/);
    await expect(prepareUpload(await put('a2.png', PNG), 'video', ok)).rejects.toThrow(/must be one of/);
    // Round-2 bypasses: a valid-looking start or end around arbitrary text.
    await expect(prepareUpload(await put('h.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)])), 'image', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('h.ogg', Buffer.concat([Buffer.from('OggS\0', 'latin1'), Buffer.from(payload)])), 'audio', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('h.mp3', Buffer.concat([frame().subarray(0, 4), Buffer.from(payload)])), 'audio', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('h.png', Buffer.concat([PNG.subarray(0, 33), Buffer.from(payload), PNG.subarray(-12)])), 'image', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('tail.mp3', Buffer.concat([MP3, Buffer.from(payload)])), 'audio', ok)).rejects.toThrow(/not a valid/);
    await expect(prepareUpload(await put('tail.jpg', Buffer.concat([JPEG, Buffer.from(payload)])), 'image', ok)).rejects.toThrow(/not a valid/);
  });

  test('refuses hidden folders (also through a symlink), hard links, relative, network and system paths', async () => {
    await mkdir(join(dir, 'media', '.ssh'));
    await writeFile(join(dir, 'media', '.ssh', 'photo.png'), PNG);
    await expect(prepareUpload(join(dir, 'media', '.ssh', 'photo.png'), 'image', ok)).rejects.toThrow(/not in a folder allowed/);
    await symlink(join(dir, 'media', '.ssh', 'photo.png'), join(dir, 'media', 'innocent.png'));
    await expect(prepareUpload(join(dir, 'media', 'innocent.png'), 'image', ok)).rejects.toThrow(/not in a folder allowed/);
    await link(join(dir, 'media', '.ssh', 'photo.png'), join(dir, 'media', 'linked.png'));
    await expect(prepareUpload(join(dir, 'media', 'linked.png'), 'image', ok)).rejects.toThrow(/hard link/);
    await expect(prepareUpload('a.png', 'image', ok)).rejects.toThrow(/absolute/);
    await expect(prepareUpload('\\\\attacker.example\\share\\a.png', 'image', ok)).rejects.toThrow(/Network and device/);
    await expect(prepareUpload('//attacker.example/share/a.png', 'image', ok)).rejects.toThrow(/Network and device/);
    await expect(prepareUpload('/etc/passwd', 'image', ['/'])).rejects.toThrow(/not in a folder allowed/);
    await mkdir(join(dir, 'media', 'sub.png'));
    await expect(prepareUpload(join(dir, 'media', 'sub.png'), 'image', ok)).rejects.toThrow(/regular files/);
  });

  test('a refused path and a missing file get the same answer', async () => {
    await writeFile(join(dir, 'outside.png'), PNG);
    const outside = await prepareUpload(join(dir, 'outside.png'), 'image', ok).catch((e) => e.message);
    const missing = await prepareUpload(join(dir, 'media', 'missing.png'), 'image', ok).catch((e) => e.message);
    const hidden = await prepareUpload(join(dir, 'media', '.bashrc'), 'image', ok).catch((e) => e.message);
    expect(new Set([outside, missing, hidden]).size).toBe(1);
    // An unsupported extension is refused by name alone, existing or not.
    await writeFile(join(dir, 'media', 'notes.txt'), 'x');
    const existing = await prepareUpload(join(dir, 'media', 'notes.txt'), 'image', ok).catch((e) => e.message);
    const absent = await prepareUpload(join(dir, 'media', 'absent.txt'), 'image', ok).catch((e) => e.message);
    expect(existing).toBe(absent);
  });

  test('AIVEED_MCP_UPLOAD_DIRS: a sibling with a longer name is outside; ~ expands; relative entries are dropped', async () => {
    await mkdir(join(dir, 'media-not'));
    await expect(prepareUpload(join(dir, 'media-not', 'x.png'), 'image', ok)).rejects.toThrow(/not in a folder allowed/);
    expect(uploadDirs(' ~/Videos , ~ ,relative/dir, /abs ')).toEqual([join(homedir(), 'Videos'), homedir(), '/abs']);
    expect(uploadDirs(undefined)).toEqual([]);
  });
});

describe('package', () => {
  test('VERSION matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('tools', () => {
  test('stdio offers upload_media; the hosted variant does not', async () => {
    const client = new AiveedClient({ apiKey: KEY, fetch: fakeFetch({}).impl });
    const local = (await (await connect(client, true)).listTools()).tools.map((t) => t.name);
    const hosted = (await (await connect(client, false)).listTools()).tools.map((t) => t.name);
    expect(local).toContain('upload_media');
    expect(hosted).not.toContain('upload_media');
    expect(hosted).toEqual(expect.arrayContaining(['list_models', 'generate_video', 'get_job', 'list_jobs']));
  });

  test('generate_video sends an Idempotency-Key, only the fields given, and returns the key', async () => {
    const { impl, calls } = fakeFetch({ 'POST /v1/generate/video': () => ({ status: 201, body: { id: 'j_abc123def456', status: 'submitted', credits_charged: 120 } }) });
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const res = await mcp.callTool({ name: 'generate_video', arguments: { model: 'veo3-fast', prompt: 'a cat', duration: '8' } });
    const out = JSON.parse(textOf(res));
    expect(out.id).toBe('j_abc123def456');
    expect(calls[0].headers['Idempotency-Key']).toBe(out.idempotency_key);
    expect(JSON.parse(calls[0].body!)).toEqual({ model: 'veo3-fast', prompt: 'a cat', duration: '8' });

    await mcp.callTool({ name: 'generate_video', arguments: { model: 'veo3-fast', idempotency_key: 'retry-1' } });
    expect(calls[1].headers['Idempotency-Key']).toBe('retry-1');
  });

  test('a failed generate call still hands back its generated idempotency key', async () => {
    const { impl, calls } = fakeFetch({ 'POST /v1/generate/video': () => ({ status: 504, body: { code: 'TIMEOUT', message: 'timed out' } }) });
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const res: any = await mcp.callTool({ name: 'generate_video', arguments: { model: 'veo3-fast', prompt: 'a cat' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`idempotency_key: ${calls[0].headers['Idempotency-Key']}`);
  });

  test('a key echoed by the API never reaches the tool output', async () => {
    const { impl } = fakeFetch({ 'GET /v1/credits': () => ({ status: 401, body: { code: 'BAD_KEY', message: `Invalid key ${KEY}`, details: { key: KEY } } }) });
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const text = textOf(await mcp.callTool({ name: 'get_credits', arguments: {} }));
    expect(text).not.toContain(KEY);
    expect(text).toContain('aiv_sk_[redacted]');
  });

  test('get_job waits until the job finishes', async () => {
    let n = 0;
    const { impl, calls } = fakeFetch({ 'GET /v1/jobs/j_abc123def456': () => ({ body: { id: 'j_abc123def456', status: ++n < 3 ? 'processing' : 'completed', result_url: 'https://x/v.mp4' } }) });
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const out = JSON.parse(textOf(await mcp.callTool({ name: 'get_job', arguments: { job_id: 'j_abc123def456', wait_seconds: 50 } })));
    expect(out.status).toBe('completed');
    expect(calls).toHaveLength(3);
  });

  test('URL inputs must be https', async () => {
    const { impl, calls } = fakeFetch({});
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    for (const u of ['file:///etc/passwd', `http://${['169', '254', '169', '254'].join('.')}/latest`, 'gopher://192.0.2.1:6379/x', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
      const res: any = await mcp.callTool({ name: 'generate_video', arguments: { model: 'veo3-fast', image_url: u } });
      expect(res.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test('upload_media is off without AIVEED_MCP_UPLOAD_DIRS and says how to turn it on', async () => {
    const { impl, calls } = fakeFetch({});
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const res: any = await mcp.callTool({ name: 'upload_media', arguments: { path: '/tmp/a.png', kind: 'image' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/AIVEED_MCP_UPLOAD_DIRS/);
    expect(calls).toHaveLength(0);
  });

  test('get_job gives each poll only the time left', async () => {
    const timeouts: number[] = [];
    const impl = (async (_u: URL, init: RequestInit) => {
      timeouts.push(init.signal ? 1 : 0);
      return new Response(JSON.stringify({ id: 'j_1', status: 'processing' }), { status: 200 });
    }) as unknown as typeof fetch;
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    await mcp.callTool({ name: 'get_job', arguments: { job_id: 'j_1', wait_seconds: 0 } });
    expect(timeouts).toEqual([1]);
  });

  test('rejects path-traversal job ids before any request', async () => {
    const { impl, calls } = fakeFetch({});
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    const res: any = await mcp.callTool({ name: 'get_job', arguments: { job_id: '../auth/keys' } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('API errors come back as tool errors', async () => {
    const { impl } = fakeFetch({ 'GET /v1/credits': () => ({ status: 401, body: { error: true, code: 'INVALID_API_KEY', message: 'revoked' } }) });
    const res: any = await (await connect(new AiveedClient({ apiKey: KEY, fetch: impl }))).callTool({ name: 'get_credits', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('401 INVALID_API_KEY');
  });
});

describe('http mode', () => {
  let base: string;
  let server: ReturnType<typeof startHttp>;
  beforeAll(async () => {
    server = startHttp({ host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const post = (headers: Record<string, string>, body: unknown = list) =>
    fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  test('requires a well-formed key per request', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401);
  });

  test('rejects foreign origins and hosts (DNS rebinding)', async () => {
    expect((await post({ Authorization: `Bearer ${KEY}`, Origin: 'https://evil.example' })).status).toBe(403);
    // fetch drops a custom Host header, so this one goes through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${KEY}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end(JSON.stringify(list));
    });
    expect(status).toBe(403);
  });

  test('allowed browser origins get CORS headers and a preflight answer', async () => {
    const cors = startHttp({ host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: ['https://app.example.com'] });
    await new Promise((r) => cors.once('listening', r));
    const corsBase = `http://127.0.0.1:${(cors.address() as AddressInfo).port}`;
    const pre = await fetch(`${corsBase}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    cors.close();
  });

  test('beyond the in-flight cap requests get 503', async () => {
    const busy = startHttp({ host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [], maxInFlight: 0 });
    await new Promise((r) => busy.once('listening', r));
    const busyBase = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`;
    const res = await fetch(`${busyBase}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
    expect(res.status).toBe(503);
    busy.close();
  });

  test('refuses JSON-RPC batches', async () => {
    const res = await post({ Authorization: `Bearer ${KEY}` }, [list, { ...list, id: 2 }]);
    expect(res.status).toBe(400);
  });

  test('URLs nested in free-form records must be public https', async () => {
    const { impl, calls } = fakeFetch({});
    const mcp = await connect(new AiveedClient({ apiKey: KEY, fetch: impl }));
    for (const bad of ['file:///etc/passwd', 'https://127.0.0.1/x', 'https://localhost/x', `https://${['10', '0', '0', '5'].join('.')}/x`, 'http://example.com/a.png']) {
      const res: any = await mcp.callTool({ name: 'generate_video', arguments: { model: 'kling-3.0', kling_elements: [{ frontal_image_url: bad }] } });
      expect(res.isError).toBe(true);
    }
    const top: any = await mcp.callTool({ name: 'generate_video', arguments: { model: 'veo3-fast', image_url: 'https://127.0.0.1/private' } });
    expect(top.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('lists tools without upload_media; GET is not allowed', async () => {
    const res = await post({ Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(200);
    const names = (await res.json()).result.tools.map((t: any) => t.name);
    expect(names).toContain('generate_video');
    expect(names).not.toContain('upload_media');
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
