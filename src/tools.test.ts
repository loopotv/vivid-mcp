import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VividClient } from './client.js';
import { registerTools } from './tools.js';

/** Minimal fake of the VIVID API: route → handler. */
type Handler = (init: RequestInit, url: URL) => { status?: number; body: unknown };
const routes = new Map<string, Handler>();
const calls: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }> = [];

const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const key = `${method} ${url.pathname}`;
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
  let body: unknown;
  if (typeof init.body === 'string') body = JSON.parse(init.body);
  calls.push({ method, path: url.pathname, body, headers });
  const h = routes.get(key);
  if (!h) return new Response(JSON.stringify({ success: false, error: `no route ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
  const r = h(init, url);
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, new VividClient({ apiKey: 'vivid_test', apiUrl: 'https://api.test', fetchImpl: fetchMock }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>) => {
  const c = (r.content as Array<{ type: string; text?: string }>)[0];
  return c.text ?? '';
};

beforeEach(() => { routes.clear(); calls.length = 0; });

describe('vivid-mcp tools', () => {
  it('registers the full tool set', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'vivid_download_asset', 'vivid_generate_image', 'vivid_generate_video', 'vivid_get_asset', 'vivid_job_status',
      'vivid_list_assets', 'vivid_list_editor_projects', 'vivid_list_jobs', 'vivid_list_models', 'vivid_list_projects',
      'vivid_render_project', 'vivid_render_status', 'vivid_share_asset', 'vivid_upload_file', 'vivid_usage', 'vivid_whoami',
    ]);
  });

  it('vivid_whoami sends the API key header and returns the account summary', async () => {
    routes.set('GET /api/me', () => ({ body: { success: true, data: { id: 'u1', email: 'a@b.c', name: 'Ale', plan: 'pro', credits: 123.5, password_hash: 'nope' } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_whoami', arguments: {} });
    expect(calls[0].headers['X-API-Key']).toBe('vivid_test');
    const out = JSON.parse(textOf(r));
    expect(out).toEqual({ id: 'u1', email: 'a@b.c', name: 'Ale', plan: 'pro', credits: 123.5 });
    expect(JSON.stringify(out)).not.toContain('password');
  });

  it('vivid_list_models summarises video capabilities and pricing', async () => {
    routes.set('GET /api/ai/models', (_i, url) => {
      expect(url.searchParams.get('type')).toBe('video');
      return { body: { success: true, data: [{
        slug: 'seedance-2.5', display_name: 'Seedance 2.5', provider: 'kie-ai', type: 'video', speed: 'medium',
        credits_per_use: 0, credits_per_second: 32, tier_access: '["starter","pro"]', description: null,
        capabilities: { durations: [5, 10], resolutions: ['480p', '720p'], aspectRatios: ['16:9'], supportsStartFrame: true, supportsReference: true, supportsFixedCamera: false, maxReferenceImages: 9, pricing: { '480p': 14, '720p': 32 } },
      }] } };
    });
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_list_models', arguments: { type: 'video' } })));
    expect(out[0]).toMatchObject({ slug: 'seedance-2.5', creditsPerSecond: 32, pricingPerSecond: { '480p': 14, '720p': 32 }, tiers: ['starter', 'pro'], maxReferenceImages: 9 });
    expect(out[0].supports).toEqual(['startFrame', 'reference']);
  });

  it('vivid_list_models without type returns both catalogs', async () => {
    routes.set('GET /api/ai/models', (_i, url) => {
      const type = url.searchParams.get('type');
      return { body: { success: true, data: [{
        slug: type === 'image' ? 'z-image-turbo' : 'kling-o3', display_name: 'x', provider: 'wavespeed', type, speed: 'fast',
        credits_per_use: 1, credits_per_second: 8, tier_access: '["pro"]', description: null, capabilities: {},
      }] } };
    });
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_list_models', arguments: {} })));
    expect(out.image[0]).toMatchObject({ slug: 'z-image-turbo', creditsPerImage: 1 });
    expect(out.video[0]).toMatchObject({ slug: 'kling-o3', creditsPerSecond: 8 });
    expect(calls.filter((c) => c.path === '/api/ai/models')).toHaveLength(2);
  });

  it('vivid_generate_image posts the request, polls each job and returns absolute download URLs', async () => {
    routes.set('POST /api/ai/generate-image-v2', () => ({ status: 202, body: { success: true, data: { jobId: 'j1', status: 'processing', jobIds: ['j1', 'j2'], creditsRemaining: 90 } } }));
    let polls = 0;
    routes.set('GET /api/ai/image-status/j1', () => ({ body: { success: true, data: { jobId: 'j1', status: ++polls > 1 ? 'completed' : 'processing', assetId: 'a1', downloadUrl: '/api/assets/a1/download' } } }));
    routes.set('GET /api/ai/image-status/j2', () => ({ body: { success: true, data: { jobId: 'j2', status: 'failed', error: 'boom' } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_generate_image', arguments: { prompt: 'a red bag on marble', model: 'nano-banana-2', numImages: 2, wait: true, timeoutSec: 10 } });
    const req = calls.find((c) => c.path === '/api/ai/generate-image-v2')!;
    expect(req.body).toMatchObject({ prompt: 'a red bag on marble', model: 'nano-banana-2', aspectRatio: '1:1', numImages: 2, source: 'mcp' });
    const out = JSON.parse(textOf(r));
    expect(out.creditsRemaining).toBe(90);
    expect(out.images).toEqual([
      { jobId: 'j1', status: 'completed', assetId: 'a1', downloadUrl: 'https://api.test/api/assets/a1/download' },
      { jobId: 'j2', status: 'failed', error: 'boom' },
    ]);
  }, 20000);

  it('vivid_generate_video returns the jobId without waiting and forwards routing fields', async () => {
    routes.set('POST /api/ai/generate-video', () => ({ body: { success: true, data: { jobId: 'v1', taskId: 't1', estimatedTime: '60-120 secondi', creditsRemaining: 200, warning: 'frames folded' } } }));
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_generate_video', arguments: { prompt: 'espresso cup, steam rising', model: 'seedance-2.5', duration: 5, resolution: '480p', generateAudio: false, referenceImageUrls: ['https://cdn/x.jpg'] } })));
    expect(calls[0].body).toMatchObject({ model: 'seedance-2.5', requestedModel: 'seedance-2.5', duration: 5, aspectRatio: '16:9', resolution: '480p', generateAudio: false, referenceImageUrls: ['https://cdn/x.jpg'], source: 'mcp' });
    expect(out).toMatchObject({ jobId: 'v1', taskId: 't1', status: 'processing', creditsRemaining: 200, warning: 'frames folded' });
  });

  it('vivid_job_status refreshes a processing video job through the provider poll', async () => {
    routes.set('GET /api/jobs/v1', () => ({ body: { success: true, data: { id: 'v1', type: 'video_ugc', status: 'processing', credits_used: 55, created_at: 'now', output: '{"taskId":"t1"}' } } }));
    routes.set('GET /api/ai/video-status/v1', () => ({ body: { success: true, data: { jobId: 'v1', status: 'completed', assetId: 'as1', downloadUrl: '/api/assets/as1/download' } } }));
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_job_status', arguments: { jobId: 'v1' } })));
    expect(out).toMatchObject({ jobId: 'v1', type: 'video_ugc', status: 'completed', assetId: 'as1', downloadUrl: 'https://api.test/api/assets/as1/download', creditsUsed: 55 });
  });

  it('vivid_share_asset builds the public URL from share_token', async () => {
    routes.set('PATCH /api/assets/a1', (init) => {
      expect(JSON.parse(init.body as string)).toEqual({ is_public: true });
      return { body: { success: true, data: { id: 'a1', is_public: 1, is_favorite: 0, share_token: 'tok123' } } };
    });
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_share_asset', arguments: { assetId: 'a1', public: true } })));
    expect(out).toEqual({ id: 'a1', favorite: false, public: true, publicUrl: 'https://api.test/api/public/assets/tok123' });
  });

  it('vivid_render_project enqueues a job and returns the browser URL without opening it', async () => {
    routes.set('POST /api/render-jobs', (init) => {
      expect(JSON.parse(init.body as string)).toEqual({ projectAssetId: 'p1', name: 'spot' });
      return { status: 201, body: { success: true, data: { id: 'r1', status: 'queued', projectAssetId: 'p1', executor: null, progress: 0, options: { name: 'spot' }, outputAssetId: null, error: null, openUrl: 'https://vividai.tv/tools/editor?render=r1', createdAt: 'now' } } };
    });
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_render_project', arguments: { projectAssetId: 'p1', name: 'spot' } })));
    expect(out).toMatchObject({ renderJobId: 'r1', status: 'queued', openUrl: 'https://vividai.tv/tools/editor?render=r1', opened: false });
  });

  it('vivid_render_status reports the finished job with an absolute download URL', async () => {
    routes.set('GET /api/render-jobs/r1', () => ({ body: { success: true, data: { id: 'r1', status: 'completed', projectAssetId: 'p1', executor: 'browser', progress: 100, options: {}, outputAssetId: 'v9', downloadUrl: '/api/assets/v9/download', error: null, openUrl: 'u', createdAt: 'now' } } }));
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_render_status', arguments: { renderJobId: 'r1' } })));
    expect(out).toMatchObject({ status: 'completed', progress: 100, outputAssetId: 'v9', downloadUrl: 'https://api.test/api/assets/v9/download' });
  });

  it('surfaces API errors as tool errors with a hint for 401', async () => {
    routes.set('GET /api/me', () => ({ status: 401, body: { success: false, error: 'Unauthorized' } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_whoami', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/401.*VIVID_API_KEY/);
  });
});
