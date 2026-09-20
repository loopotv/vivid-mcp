
export const DEFAULT_API_URL = 'https://vivid-api.vividoai.workers.dev';

export interface VividClientOptions {
  apiKey: string;
  apiUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Read a local file by absolute path. Provided by the stdio server (Node);
   *  absent on the remote server, where only URLs are accepted. */
  readLocal?: (path: string) => Promise<Uint8Array>;
}

export class VividApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'VividApiError';
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Thin, typed wrapper over the VIVID REST API. Every call authenticates with
 * the user's API key (Settings → API key on vividai.tv) via the X-API-Key
 * header — the same key the public API accepts, no JWT involved.
 */
export class VividClient {
  private readonly apiKey: string;
  readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readLocal?: (path: string) => Promise<Uint8Array>;

  constructor(opts: VividClientOptions) {
    if (!opts.apiKey) throw new Error('VIVID_API_KEY is required');
    this.apiKey = opts.apiKey;
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    // Bound wrapper: on Cloudflare Workers, calling the global fetch with `this`
    // set to the client throws "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.readLocal = opts.readLocal;
  }

  /** Absolute URL for an API path (handy for download links in tool output). */
  url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path; // already absolute (temp URLs, share links)
    return `${this.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-API-Key': this.apiKey, Accept: 'application/json', ...extra };
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<{ data: T; pagination?: ApiEnvelope<T>['pagination'] }> {
    const url = new URL(this.url(path));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const init: RequestInit = { method, headers: this.headers() };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers = this.headers({ 'Content-Type': 'application/json' });
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    let json: ApiEnvelope<T> | undefined;
    try { json = JSON.parse(text) as ApiEnvelope<T>; } catch { /* non-JSON body */ }
    if (!res.ok || !json?.success) {
      const msg = json?.error ?? (text ? text.slice(0, 300) : `HTTP ${res.status}`);
      throw new VividApiError(msg, res.status, json?.code);
    }
    return { data: json.data as T, pagination: json.pagination };
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('GET', path, undefined, query);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  /** POST expecting a plain-text body (SRT/VTT exports). JSON error envelopes are still surfaced. */
  async postText(path: string, body: unknown): Promise<string> {
    const res = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: '*/*' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300) || `HTTP ${res.status}`;
      let code: string | undefined;
      try { const j = JSON.parse(text) as ApiEnvelope<unknown>; msg = j.error ?? msg; code = j.code; } catch { /* plain text */ }
      throw new VividApiError(msg, res.status, code);
    }
    return text;
  }

  /** Raw binary GET (asset download). Returns bytes + content type. */
  async download(path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.fetchImpl(this.url(path), { headers: this.headers({ Accept: '*/*' }) });
    if (!res.ok) throw new VividApiError(`Download failed: HTTP ${res.status}`, res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** Read a local file (absolute path) or fetch a URL into a Blob for multipart uploads. */
  async loadSource(source: string): Promise<{ blob: Blob; filename: string; contentType: string }> {
    let bytes: Uint8Array;
    let contentType: string;
    let filename: string;
    if (/^https?:\/\//i.test(source)) {
      const res = await this.fetchImpl(source);
      if (!res.ok) throw new VividApiError(`Could not fetch ${source}: HTTP ${res.status}`, res.status);
      bytes = new Uint8Array(await res.arrayBuffer());
      contentType = res.headers.get('content-type')?.split(';')[0] ?? guessContentType(source);
      filename = basenameOf(new URL(source).pathname) || 'upload';
    } else {
      if (!this.readLocal) {
        throw new VividApiError(`Local file paths are not available on this server (${source}): pass a public http(s) URL instead.`, 400, 'local_path_unsupported');
      }
      bytes = await this.readLocal(source);
      contentType = guessContentType(source);
      filename = basenameOf(source);
    }
    // Node's Uint8Array is typed over ArrayBufferLike; Blob wants a plain ArrayBuffer view.
    return { blob: new Blob([bytes as unknown as ArrayBufferView<ArrayBuffer>], { type: contentType }), filename, contentType };
  }

  /**
   * Upload a local file or a remote URL to VIVID's temporary bucket and get
   * back a public URL usable as start frame / reference / audio input.
   */
  async tempUpload(source: string): Promise<{ url: string; key: string }> {
    const { blob, filename, contentType } = await this.loadSource(source);
    const form = new FormData();
    form.append('file', blob, filename);
    // Audio has its own endpoint (temp-upload only accepts images/videos).
    const endpoint = contentType.startsWith('audio/') ? '/api/ai/temp-audio-upload' : '/api/ai/temp-upload';
    const { data } = await this.post<{ url: string; key: string }>(endpoint, form);
    return data;
  }
}

/** Last path segment, for file names (pure — no node:path). */
export function basenameOf(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

export function guessContentType(name: string): string {
  const ext = name.toLowerCase().split('?')[0].split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
    'application/json': 'json', 'text/plain': 'txt',
  };
  return map[contentType.split(';')[0]] ?? 'bin';
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
