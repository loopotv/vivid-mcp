import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VividClient } from './client.js';
import { registerTools } from './tools.js';

/** Minimal fake of the VIVID API: route → handler. */
type Handler = (init: RequestInit, url: URL) => { status?: number; body: unknown; raw?: boolean };
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
  if (r.raw) return new Response(String(r.body), { status: r.status ?? 200, headers: { 'content-type': 'text/plain' } });
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
      'vivid_chat', 'vivid_compare_product', 'vivid_create_editor_project', 'vivid_download_asset', 'vivid_edit_timeline', 'vivid_generate_image', 'vivid_generate_music', 'vivid_generate_video', 'vivid_generate_voice', 'vivid_get_asset', 'vivid_get_editor_project', 'vivid_job_status',
      'vivid_list_assets', 'vivid_list_editor_projects', 'vivid_list_jobs', 'vivid_list_models', 'vivid_list_music_providers', 'vivid_list_projects', 'vivid_list_voices',
      'vivid_record_ui', 'vivid_render_project', 'vivid_render_status', 'vivid_retouch', 'vivid_share_asset', 'vivid_transcribe', 'vivid_upload_file', 'vivid_usage', 'vivid_whoami',
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

  it('vivid_generate_voice posts to tts-v2 and passes provider, voice and locale', async () => {
    routes.set('POST /api/ai/tts-v2', () => ({ body: { success: true, data: { url: 'https://api.test/api/temp/tmp/tts/x.mp3', provider: 'gemini', credits: 1 } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_generate_voice', arguments: { text: 'Ciao', provider: 'gemini', voice: 'Kore' } });
    expect(calls[0].body).toMatchObject({ provider: 'gemini', text: 'Ciao', voice: 'Kore', locale: 'it' });
    expect(JSON.parse(textOf(r))).toMatchObject({ provider: 'gemini', credits: 1, url: expect.stringContaining('.mp3') });
  });

  it('vivid_generate_music posts prompt, duration and provider and returns the temp url', async () => {
    routes.set('POST /api/ai/generate-music', () => ({ body: { success: true, data: { url: 'https://api.test/api/temp/tmp/music/t.mp3', durationSeconds: 97.5, requestedSeconds: 88, provider: 'minimax-music-3.0', credits: 14, exactDuration: false } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_generate_music', arguments: { prompt: 'warm lo-fi, 85 BPM', durationSec: 88 } });
    expect(calls[0].body).toEqual({ prompt: 'warm lo-fi, 85 BPM', duration: 88, provider: 'minimax-music-3.0', instrumental: true, format: 'mp3' });
    expect(JSON.parse(textOf(r))).toMatchObject({ url: 'https://api.test/api/temp/tmp/music/t.mp3', durationSeconds: 97.5, provider: 'minimax-music-3.0', credits: 14 });
  });

  it('vivid_generate_music passes stable-audio-3 + wav through', async () => {
    routes.set('POST /api/ai/generate-music', () => ({ body: { success: true, data: { url: 'https://api.test/api/temp/tmp/music/t.wav', durationSeconds: 30, requestedSeconds: 30, provider: 'stable-audio-3', credits: 25, exactDuration: true } } }));
    const client = await connect();
    await client.callTool({ name: 'vivid_generate_music', arguments: { prompt: 'rain on a tin roof', durationSec: 30, provider: 'stable-audio-3', format: 'wav' } });
    expect(calls[0].body).toMatchObject({ provider: 'stable-audio-3', format: 'wav', duration: 30 });
  });

  it('vivid_transcribe sends an asset id as assetId and returns words + cues', async () => {
    const data = { transcript: 'Ciao mondo.', words: [{ word: 'Ciao', startMs: 0, endMs: 300, confidence: 0.99 }], cues: [{ id: 'c1', text: 'Ciao mondo.', startMs: 0, endMs: 1500, words: [] }], durationMs: 900, language: 'it' };
    routes.set('POST /api/ai/transcribe', () => ({ body: { success: true, data } }));
    const client = await connect();
    const id = 'a'.repeat(32);
    const r = await client.callTool({ name: 'vivid_transcribe', arguments: { source: id } });
    expect(calls[0].body).toEqual({ assetId: id, locale: 'it', format: 'json', granularity: 'cue' });
    expect(JSON.parse(textOf(r))).toEqual(data);
  });

  it('vivid_transcribe returns the SRT text verbatim for a URL source', async () => {
    const srt = '1\n00:00:00,000 --> 00:00:01,500\nCiao mondo.\n';
    routes.set('POST /api/ai/transcribe', () => ({ body: srt, raw: true }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_transcribe', arguments: { source: 'https://cdn/x.mp4', format: 'srt', granularity: 'word', language: 'en' } });
    expect(calls[0].body).toEqual({ url: 'https://cdn/x.mp4', locale: 'en', format: 'srt', granularity: 'word' });
    expect(textOf(r)).toBe(srt);
  });

  it('vivid_retouch posts asset id + target + prompt and returns the new asset', async () => {
    const id = 'b'.repeat(32);
    routes.set('POST /api/ai/retouch', () => ({ body: { success: true, data: { jobId: 'j1', assetId: 'c'.repeat(32), downloadUrl: '/api/assets/' + 'c'.repeat(32) + '/download', region: { x: 0.5, y: 0.5, w: 0.1, h: 0.06 }, model: 'nano-banana', credits: 6 } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_retouch', arguments: { source: id, target: 'the ring', prompt: 'plain gold band' } });
    expect(calls[0].body).toMatchObject({ sourceAssetId: id, target: 'the ring', prompt: 'plain gold band', model: 'nano-banana' });
    expect(JSON.parse(textOf(r))).toMatchObject({ assetId: 'c'.repeat(32), downloadUrl: 'https://api.test/api/assets/' + 'c'.repeat(32) + '/download', credits: 6 });
  });

  it('vivid_retouch refuses a call without target, region or mask', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_retouch', arguments: { source: 'b'.repeat(32), prompt: 'gold band' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('target, region or mask');
  });

  it('vivid_compare_product sends both asset ids and the SKU notes', async () => {
    const data = { productVisible: true, match: 0.18, verdict: 'fail', differences: [], summary: 'no', fixPrompt: 'replace…', model: 'gpt', ms: 1, credits: 1 };
    routes.set('POST /api/ai/compare-product', () => ({ body: { success: true, data } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_compare_product', arguments: { candidate: 'a'.repeat(32), reference: 'b'.repeat(32), skuDescription: 'silver ring', focus: 'the ring' } });
    expect(calls[0].body).toEqual({ candidateAssetId: 'a'.repeat(32), referenceAssetId: 'b'.repeat(32), skuDescription: 'silver ring', focus: 'the ring', lang: 'it' });
    expect(JSON.parse(textOf(r))).toEqual(data);
  });

  describe('timeline tools (vivid-editor-core headless)', () => {
    const A = 'a'.repeat(32);
    const P = 'p'.repeat(32);
    let savedProject: Record<string, unknown> | undefined;
    const wire = () => {
      routes.set(`GET /api/assets/${A}`, () => ({ body: { success: true, data: { id: A, type: 'video', filename: 'hero.mp4', duration_sec: 10, metadata: '{"width":1080,"height":1920}', created_at: 'now' } } }));
      routes.set('POST /api/ai/save-editor-project', (init) => { savedProject = (JSON.parse(String(init.body)) as { projectData: Record<string, unknown> }).projectData; return { body: { success: true, data: { assetId: P, r2Key: 'k' } } }; });
    };

    it('vivid_create_editor_project imports media, applies commands and saves a v2 file', async () => {
      wire();
      routes.set(`GET /api/assets/${P}/download`, () => ({ body: JSON.stringify(savedProject), raw: true }));
      const client = await connect();
      const r = await client.callTool({ name: 'vivid_create_editor_project', arguments: {
        name: 'Spot', canvasPreset: 'portrait-fhd', media: [{ source: A }],
        commands: [{ type: 'ADD_CLIP', payload: { assetId: A } }, { type: 'ADD_TEXT', payload: { text: 'Ciao', startMs: 0, endMs: 2000, x: 0.5, y: 0.2 } }],
      } });
      const out = JSON.parse(textOf(r));
      expect(r.isError).toBeFalsy();
      expect(out.projectAssetId).toBe(P);
      expect(out.errors).toEqual([]);
      expect(out.applied).toBe(2);
      expect(out.imported).toEqual([{ id: A, name: 'hero.mp4', mediaType: 'video', durationMs: 10000 }]);
      expect(out.timeline.clips).toHaveLength(1);
      expect(out.timeline.clips[0]).toMatchObject({ assetId: A, startMs: 0, durationMs: 10000 });
      expect(out.timeline.textOverlays[0].text).toBe('Ciao');
      expect(out.timeline.canvasPreset).toMatchObject({ width: 1080, height: 1920 });
      expect(savedProject).toMatchObject({ schemaVersion: 2, projectName: 'Spot' });
      expect((savedProject!.assets as unknown[]).length).toBe(1);
    });

    it('vivid_edit_timeline loads, splits a clip and saves under the same id; vivid_get_editor_project reads it back', async () => {
      wire();
      routes.set(`GET /api/assets/${P}/download`, () => ({ body: JSON.stringify(savedProject), raw: true }));
      const client = await connect();
      await client.callTool({ name: 'vivid_create_editor_project', arguments: { name: 'Spot', media: [{ source: A }], commands: [{ type: 'ADD_CLIP', payload: { assetId: A } }] } });
      const clipId = (JSON.parse(textOf(await client.callTool({ name: 'vivid_get_editor_project', arguments: { projectAssetId: P } }))) as { clips: Array<{ id: string }> }).clips[0].id;
      calls.length = 0;
      const r = await client.callTool({ name: 'vivid_edit_timeline', arguments: { projectAssetId: P, commands: [
        { type: 'SPLIT_CLIP', payload: { clipId, splitAtMs: 4000 } },
        { type: 'SET_CANVAS_PRESET', payload: { id: 'square', label: '1:1 Square', width: 1080, height: 1080 } },
      ] } });
      const out = JSON.parse(textOf(r));
      expect(out.errors).toEqual([]);
      expect(out.saved).toBe(true);
      expect(out.timeline.clips.map((c: { durationMs: number }) => c.durationMs)).toEqual([4000, 6000]);
      const save = calls.find((c) => c.path === '/api/ai/save-editor-project');
      expect((save!.body as { assetId: string }).assetId).toBe(P);
      const again = JSON.parse(textOf(await client.callTool({ name: 'vivid_get_editor_project', arguments: { projectAssetId: P } })));
      expect(again.clips).toHaveLength(2);
      expect(again.canvasPreset.id).toBe('square');
    });

    it('vivid_edit_timeline dryRun reports errors for unknown clips without saving', async () => {
      wire();
      routes.set(`GET /api/assets/${P}/download`, () => ({ body: JSON.stringify(savedProject), raw: true }));
      const client = await connect();
      await client.callTool({ name: 'vivid_create_editor_project', arguments: { name: 'Spot' } });
      calls.length = 0;
      const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_edit_timeline', arguments: { projectAssetId: P, dryRun: true, commands: [{ type: 'REMOVE_CLIP', payload: { id: 'nope' } }, { type: 'NOPE', payload: {} }] } })));
      expect(out.saved).toBe(false);
      expect(out.errors.some((e: string) => /Unknown command type/.test(e))).toBe(true);
      expect(calls.some((c) => c.path === '/api/ai/save-editor-project')).toBe(false);
    });
  });

  it('vivid_generate_voice minimax passes the voice id and emotion to tts-v2', async () => {
    routes.set('POST /api/ai/tts-v2', () => ({ body: { success: true, data: { url: 'https://api.test/api/temp/tmp/tts/m.mp3', provider: 'minimax', credits: 1 } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_generate_voice', arguments: { text: 'Ciao', provider: 'minimax', voice: 'Italian_Narrator', emotion: 'happy' } });
    expect(calls[0].body).toMatchObject({ provider: 'minimax', text: 'Ciao', voice: 'Italian_Narrator', emotion: 'happy', locale: 'it' });
    expect(JSON.parse(textOf(r))).toMatchObject({ provider: 'minimax', credits: 1 });
  });

  it('vivid_generate_voice requires a reference for omnivoice-clone', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_generate_voice', arguments: { text: 'Ciao', provider: 'omnivoice-clone' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('referenceAudio');
  });

  it('vivid_chat posts the conversation to /api/ai/chat and returns text + credits', async () => {
    routes.set('POST /api/ai/chat', () => ({ body: { success: true, data: { text: 'Ciao!', model: 'claude-sonnet-5', family: 'claude', usage: { inputTokens: 12, outputTokens: 3 }, credits: 0.01, providerCredits: 1, creditsRemaining: 99.99 } } }));
    const client = await connect();
    const r = await client.callTool({ name: 'vivid_chat', arguments: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Ciao' }] } });
    expect(calls[0].body).toEqual({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Ciao' }], maxTokens: 2000 });
    const out = JSON.parse(textOf(r));
    expect(out.text).toBe('Ciao!');
    expect(out.credits).toBe(0.01);
  });

  it('vivid_list_models type=llm reads the chat catalog', async () => {
    routes.set('GET /api/ai/chat/models', () => ({ body: { success: true, data: [{ slug: 'grok-4.6', name: 'Grok 4.6', family: 'grok', creditsPerMTokens: { input: 150, output: 450 } }] } }));
    const client = await connect();
    const out = JSON.parse(textOf(await client.callTool({ name: 'vivid_list_models', arguments: { type: 'llm' } })));
    expect(out[0].slug).toBe('grok-4.6');
  });
});
