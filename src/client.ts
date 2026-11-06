// Thin client for the public AIVeed REST API (https://api.aiveed.io/v1). This is the only thing
// the server talks to: no other AIVeed service, no database, no provider keys. Everything it can
// do, the caller's own API key could already do with curl.

export const DEFAULT_BASE_URL = 'https://api.aiveed.io';
const API_KEY_RE = /^aiv_sk_[0-9a-f]{64}$/;
const ANY_API_KEY_RE = /aiv_sk_[0-9a-f]{64}/gi;
const DEFAULT_TIMEOUT_MS = 30_000;

export class AiveedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly param?: string
  ) {
    super(message);
    this.name = 'AiveedApiError';
  }
}

export const isApiKey = (key: string | undefined): key is string => !!key && API_KEY_RE.test(key);

/** Removes anything shaped like an API key from a string. */
export const redact = (text: string) => text.replace(ANY_API_KEY_RE, 'aiv_sk_[redacted]');

/** The same, through every string (and key) of a parsed JSON value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactDeep(v)])) as T;
  }
  return value;
}

/** https only, except a loopback host for local development of the API itself. */
export function normalizeBaseUrl(raw: string | undefined): string {
  const url = new URL(raw || DEFAULT_BASE_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`AIVEED_API_URL must be https:// (got ${url.protocol}//${url.host})`);
  }
  if (url.username || url.password) throw new Error('AIVEED_API_URL must not contain credentials');
  return url.origin;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  /** Public endpoints (models, pricing) work without a key. */
  auth?: boolean;
  timeoutMs?: number;
  /** Aborts the request, e.g. when the MCP client cancels the tool call. */
  signal?: AbortSignal;
}

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
  /** Aborts every request this client makes (HTTP mode: when the caller's connection closes). */
  signal?: AbortSignal;
}

export class AiveedClient {
  readonly baseUrl: string;
  readonly #apiKey?: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #signal?: AbortSignal;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    // Kept private (#) so it never shows up in a serialized or logged client object.
    this.#apiKey = opts.apiKey;
    this.#userAgent = opts.userAgent || 'aiveed-mcp';
    this.#fetch = opts.fetch || fetch;
    this.#signal = opts.signal;
  }

  get hasKey(): boolean {
    return !!this.#apiKey;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    // Checked on the raw path and again on the parsed URL, so an encoded dot segment
    // (/v1/%2e%2e/x, which URL parsing turns into /x) cannot step outside /v1/.
    if (!path.startsWith('/v1/') || /%2e|%2f|%5c|\\|\/\.\.?(\/|$)/i.test(path)) throw new Error(`refusing non-API path ${path}`);
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl || !url.pathname.startsWith('/v1/')) throw new Error(`refusing non-API path ${path}`);
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.#userAgent };
    if (opts.auth !== false) {
      if (!this.#apiKey) {
        throw new AiveedApiError(401, 'AUTH_REQUIRED', 'No AIVeed API key configured. Set AIVEED_API_KEY (create one at https://developer.aiveed.io/keys).');
      }
      headers['X-API-Key'] = this.#apiKey;
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body,
        redirect: 'error', // never follow a redirect with the key attached
        signal: AbortSignal.any(
          [opts.signal, this.#signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)].filter((s): s is AbortSignal => !!s)
        ),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : opts.signal?.aborted || this.#signal?.aborted ? 'was cancelled' : 'failed';
      throw new AiveedApiError(0, 'NETWORK_ERROR', `Request to ${url.host} ${reason}. For a generate call, check list_jobs before retrying, or retry with the same idempotency_key.`);
    }

    // Whatever comes back reaches the model as tool output: never let a key through, even if an
    // upstream error were to echo one. Redacted before parsing and again after, because JSON
    // escapes (\u0061iv_sk_...) only turn back into a key once parsed.
    const text = redact(await res.text());
    let data: any = undefined;
    if (text) {
      try {
        data = redactDeep(JSON.parse(text));
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      throw new AiveedApiError(
        res.status,
        typeof data?.code === 'string' ? data.code : `HTTP_${res.status}`,
        typeof data?.message === 'string' ? data.message : `AIVeed API returned HTTP ${res.status}`,
        data?.details,
        typeof data?.param === 'string' ? data.param : undefined
      );
    }
    return data as T;
  }
}
