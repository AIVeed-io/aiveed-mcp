// The MCP tools. Each one maps to a single public API call (plus polling for get_job's wait).
// Webhooks, batch and key management are left out on purpose: an agent does not need them, and
// a smaller surface is a smaller target for prompt injection.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AiveedApiError, redact, type AiveedClient } from './client.js';
import { prepareUpload, UploadRejected } from './upload.js';

export interface ToolOptions {
  /** Register upload_media (reads local files). Only for the stdio server. */
  localFiles: boolean;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const jobId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a job id').describe('Job id returned by a generate call, e.g. "j_abc123def456"');
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,200}$/)
  .optional()
  .describe('Recommended: pass your own unique key (e.g. a UUID) and keep it. Retrying with the same key never charges twice, even if the first response was lost. Generated when omitted and returned in the result.');
// Inputs the API fetches: public https URLs only (no file:, http:, data: or other schemes, and no
// loopback, private or link-local hosts written as such). The API applies its own checks too; this
// keeps an agent from even sending them.
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;
export function isPublicHttpsUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !PRIVATE_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}
const url = z.string().max(2048).refine(isPublicHttpsUrl, 'must be a public https:// URL');

// Free-form records (Kling multi-shot prompts and elements) may carry URLs too: every string in
// them that looks like a URL or a scheme must pass the same rule.
const looksLikeUrl = (v: string) => /^[a-z][a-z0-9+.-]*:/i.test(v.trim()) || v.includes('://');
function urlsInside(value: unknown): boolean {
  if (typeof value === 'string') return !looksLikeUrl(value) || isPublicHttpsUrl(value.trim());
  if (Array.isArray(value)) return value.every(urlsInside);
  if (value && typeof value === 'object') return Object.values(value).every(urlsInside);
  return true;
}
const record = z.record(z.string(), z.unknown()).refine(urlsInside, 'URLs inside must be public https:// URLs');
const page = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// MCP clients time a tool call out after 60 s by default (the SDK's DEFAULT_REQUEST_TIMEOUT_MSEC),
// so one get_job call waits less than that; the agent calls again for longer jobs.
const MAX_WAIT_SECONDS = 50;
// Uploads: under the same client timeout. A larger file on a slow link fails with a clear error
// instead of finishing after the client has given up (and the agent uploading it again).
const UPLOAD_TIMEOUT_MS = 55_000;

// Every result passes through redact() once more on its way out, whatever produced it.
const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: redact(JSON.stringify(data)) }] });

function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof AiveedApiError) {
    text = `AIVeed API error${err.status ? ` ${err.status}` : ''} ${err.code}: ${err.message}`;
    if (err.param) text += ` (param: ${err.param})`;
    if (err.details !== undefined) text += `\ndetails: ${JSON.stringify(err.details)}`;
  } else if (err instanceof UploadRejected) {
    text = `Upload rejected: ${err.message}`;
  } else {
    text = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: 'text', text: redact(text) }], isError: true };
}

const run = (fn: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
};

/** Drops undefined fields so the API sees only what the caller set. */
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function generate(client: AiveedClient, path: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const { idempotency_key, ...body } = args;
  const key = (idempotency_key as string | undefined) || randomUUID();
  let job: Record<string, unknown>;
  try {
    job = await client.request<Record<string, unknown>>('POST', path, { body: defined(body), idempotencyKey: key, signal });
  } catch (err) {
    // The request may have been charged before it failed (a timeout, a dropped connection), and a
    // generated key exists only here: the error must carry it, or a retry would charge again.
    const hint = ` [idempotency_key: ${key} - to retry, pass this same key so the job is not charged twice]`;
    if (err instanceof AiveedApiError) throw new AiveedApiError(err.status, err.code, err.message + hint, err.details, err.param);
    throw new Error((err instanceof Error ? err.message : String(err)) + hint);
  }
  return { ...job, idempotency_key: key, next: `Call get_job with this id (wait_seconds up to ${MAX_WAIT_SECONDS}, repeatedly) until status is completed or failed.` };
}

export function registerTools(server: McpServer, client: AiveedClient, opts: ToolOptions): void {
  const sleep = opts.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const read = { readOnlyHint: true, openWorldHint: true } as const;
  const spend = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'Live AIVeed model catalog: every video, image and audio model with its options (aspect ratios, durations, resolutions, modes), accepted inputs and credit cost. Call this before generating; models and prices change.',
      inputSchema: { type: z.enum(['video', 'image', 'audio', 'extend']).optional().describe('Only this kind of model') },
      annotations: { title: 'List models', ...read },
    },
    async ({ type }, extra) =>
      run(async () => {
        const catalog = await client.request<Record<string, unknown>>('GET', '/v1/models', { auth: false, signal: extra?.signal });
        return type ? { version: catalog.version, [type]: catalog[type] } : catalog;
      })()
  );

  server.registerTool(
    'get_credits',
    {
      title: 'Credit balance',
      description: 'The account\'s current credit balance. Generations are charged up front and refunded automatically if they fail.',
      annotations: { title: 'Credit balance', ...read },
    },
    async (extra) => run(() => client.request('GET', '/v1/credits', { signal: extra?.signal }))()
  );

  server.registerTool(
    'generate_video',
    {
      title: 'Generate video',
      description:
        'Start a video generation job (text-to-video, image-to-video, first/last frame, references). Spends credits: tell the user the cost from list_models first. Returns a job id immediately; the video takes from about 30 s to several minutes, so follow up with get_job.',
      inputSchema: {
        model: z.string().min(1).max(64).describe('Model id from list_models, e.g. "veo3-fast", "seedance-2", "kling-3.0"'),
        prompt: z.string().max(20000).optional(),
        aspect_ratio: z.string().max(16).optional().describe('One of the model\'s aspect_ratios, e.g. "16:9"'),
        duration: z.string().max(8).optional().describe('Seconds as a string, one of the model\'s durations, e.g. "8"'),
        resolution: z.string().max(16).optional().describe('One of the model\'s resolutions, e.g. "720p"'),
        mode: z.string().max(16).optional().describe('Model-specific mode, e.g. Kling "std"/"pro", Grok "normal"'),
        image_url: url.optional().describe('Image-to-video source image (public URL, or the url from upload_media)'),
        first_frame_url: url.optional(),
        last_frame_url: url.optional().describe('Requires first_frame_url; not every model supports it'),
        reference_image_urls: z.array(url).max(10).optional(),
        reference_video_urls: z.array(url).max(5).optional(),
        reference_audio_urls: z.array(url).max(5).optional(),
        generate_audio: z.boolean().optional(),
        sound: z.boolean().optional().describe('Kling: false for a silent video'),
        video_url: url.optional().describe('Lip sync: the source video'),
        audio_url: url.optional().describe('Lip sync: the audio track'),
        audio_duration: z.number().positive().max(600).optional(),
        lip_sync_mode: z.string().max(32).optional(),
        multi_shots: z.boolean().optional().describe('Kling multi-shot'),
        multi_prompt: z.array(record).max(10).optional().describe('Kling multi-shot prompts, as documented at https://api.aiveed.io/llms-full.txt'),
        kling_elements: z.array(record).max(10).optional(),
        character_asset_ids: z.array(z.union([z.string(), z.number()])).max(10).optional().describe('Gemini Omni characters'),
        voice_asset_ids: z.array(z.union([z.string(), z.number()])).max(10).optional().describe('Gemini Omni voices'),
        idempotency_key: idempotencyKey,
      },
      annotations: { title: 'Generate video', ...spend },
    },
    async (args, extra) => run(() => generate(client, '/v1/generate/video', args, extra?.signal))()
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Start an image generation or edit job (pass image_urls to edit or combine images). Spends credits: check the cost with list_models. Returns a job id; follow up with get_job.',
      inputSchema: {
        model: z.string().min(1).max(64).describe('Image model id from list_models, e.g. "nano-banana", "gpt-image-2"'),
        prompt: z.string().max(20000).optional(),
        aspect_ratio: z.string().max(16).optional(),
        resolution: z.string().max(16).optional(),
        output_format: z.string().max(8).optional().describe('e.g. "png" or "jpeg", where the model supports it'),
        image_urls: z.array(url).max(16).optional().describe('Input images for editing'),
        idempotency_key: idempotencyKey,
      },
      annotations: { title: 'Generate image', ...spend },
    },
    async (args, extra) => run(() => generate(client, '/v1/generate/image', args, extra?.signal))()
  );

  server.registerTool(
    'generate_audio',
    {
      title: 'Generate audio',
      description:
        'Start a voiceover (model "voiceover": text + voice_id or voice_name) or music (model "music": style, lyrics or instrumental) job. Spends credits. Returns a job id; follow up with get_job.',
      inputSchema: {
        model: z.enum(['voiceover', 'music']),
        text: z.string().max(5000).optional().describe('Voiceover script'),
        voice_id: z.string().max(128).optional(),
        voice_name: z.string().max(128).optional(),
        style: z.string().max(1000).optional().describe('Music style'),
        lyrics: z.string().max(5000).optional(),
        title: z.string().max(200).optional(),
        instrumental: z.boolean().optional(),
        idempotency_key: idempotencyKey,
      },
      annotations: { title: 'Generate audio', ...spend },
    },
    async (args, extra) => run(() => generate(client, '/v1/generate/audio', args, extra?.signal))()
  );

  server.registerTool(
    'extend_video',
    {
      title: 'Extend video',
      description: 'Add about 7 seconds to a completed Veo 3.1 video job. Spends credits at the tier the video was made with (see list_models "extend").',
      inputSchema: { job_id: jobId, prompt: z.string().min(1).max(10000), idempotency_key: idempotencyKey },
      annotations: { title: 'Extend video', ...spend },
    },
    async (args, extra) => run(() => generate(client, '/v1/extend/video', args, extra?.signal))()
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get job',
      description:
        'Status of a generation job; result_url is set when status is "completed". Set wait_seconds to keep polling until the job finishes or the time is up. Failed jobs are refunded automatically.',
      inputSchema: {
        job_id: jobId,
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Poll for up to this many seconds (default 0: return at once; at most ${MAX_WAIT_SECONDS}, call again for longer jobs)`),
      },
      annotations: { title: 'Get job', ...read },
    },
    async ({ job_id, wait_seconds = 0 }, extra) =>
      run(async () => {
        const path = `/v1/jobs/${encodeURIComponent(job_id)}`;
        const signal = extra?.signal;
        const deadline = Date.now() + wait_seconds * 1000;
        for (;;) {
          // Each poll gets only the time left (at least 5 s), so the whole call stays within
          // wait_seconds plus one short request.
          const timeoutMs = Math.min(30_000, Math.max(5_000, deadline - Date.now()));
          const job = await client.request<{ status?: string }>('GET', path, { signal, timeoutMs });
          // Stop polling once the client has cancelled or given up on the call.
          if (TERMINAL.has(String(job?.status)) || Date.now() + 10_000 > deadline || signal?.aborted) return job;
          await sleep(5000);
          if (signal?.aborted) return job;
        }
      })()
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent jobs, newest first. Use it to find a job after a timeout instead of generating again.',
      inputSchema: {
        status: z.enum(['queued', 'submitted', 'processing', 'completed', 'failed', 'cancelled']).optional(),
        model: z.string().max(64).optional(),
        type: z.enum(['video', 'image', 'extend', 'audio']).optional(),
        ...page,
      },
      annotations: { title: 'List jobs', ...read },
    },
    async (q, extra) => run(() => client.request('GET', '/v1/jobs', { query: q, signal: extra?.signal }))()
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel job',
      description: 'Cancel a job that is still queued (refunded). Jobs that already started cannot be cancelled.',
      inputSchema: { job_id: jobId },
      annotations: { title: 'Cancel job', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id }, extra) => run(() => client.request('DELETE', `/v1/jobs/${encodeURIComponent(job_id)}`, { signal: extra?.signal }))()
  );

  server.registerTool(
    'list_videos',
    {
      title: 'List videos',
      description: 'The account\'s generated videos with permanent video_url links (a job\'s result_url can be temporary).',
      inputSchema: { model: z.string().max(64).optional(), ...page },
      annotations: { title: 'List videos', ...read },
    },
    async (q, extra) => run(() => client.request('GET', '/v1/videos', { query: q, signal: extra?.signal }))()
  );

  server.registerTool(
    'list_images',
    {
      title: 'List images',
      description: 'The account\'s generated images with permanent image_url links.',
      inputSchema: { model: z.string().max(64).optional(), favorite: z.boolean().optional(), ...page },
      annotations: { title: 'List images', ...read },
    },
    async (q, extra) => run(() => client.request('GET', '/v1/images', { query: q, signal: extra?.signal }))()
  );

  if (opts.localFiles) {
    server.registerTool(
      'upload_media',
      {
        title: 'Upload media',
        description:
          'Upload a local image, audio or video file to use as a generation input (image_url, first_frame_url, reference_*_urls, audio_url). Free. The returned url is PUBLIC, so only upload a file the user explicitly asked you to use. Works only inside the folders the user listed in AIVEED_MCP_UPLOAD_DIRS; hidden and system folders are never read, and only files with a valid media structure are accepted.',
        inputSchema: {
          path: z.string().min(1).max(4096).describe('Absolute path of the local file'),
          kind: z.enum(['image', 'audio', 'video']),
        },
        annotations: { title: 'Upload media', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ path, kind }, extra) =>
        run(async () => client.request('POST', '/v1/uploads', { form: await prepareUpload(path, kind), timeoutMs: UPLOAD_TIMEOUT_MS, signal: extra?.signal }))()
    );
  }
}
