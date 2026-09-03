import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VividClient, VividApiError, extensionFor, sleep } from './client.js';

// ── API shapes (subset we surface) ─────────────────────────────────────────

interface PublicUser {
  id: string; email: string; name: string | null; plan: string; credits: number; lang?: string;
}

interface AiModel {
  slug: string; display_name: string; provider: string; type: string; description: string | null;
  credits_per_use: number; credits_per_second: number; speed: string; tier_access: string | string[];
  icon?: string; capabilities?: Record<string, unknown>;
}

interface Job {
  id: string; type: string; status: string; input?: string | Record<string, unknown>;
  output?: string | Record<string, unknown>; credits_used: number; created_at: string; project_id?: string | null;
  assets?: Asset[];
}

interface Asset {
  id: string; job_id: string | null; type: string; category?: string; filename: string;
  is_favorite: number | boolean; is_public: number | boolean; share_token?: string | null; created_at: string;
  thumbUrl?: string;
}

interface ImageGenResult {
  jobId: string; status: 'processing' | 'completed' | 'failed'; assetId?: string; downloadUrl?: string; error?: string;
  jobIds?: string[]; creditsRemaining?: number;
}

interface VideoGenResult {
  jobId: string; taskId?: string; estimatedTime?: string; statusUrl?: string; creditsRemaining?: number; warning?: string;
  routing?: unknown; requiresConfirmation?: boolean; confirmOptions?: unknown;
}

interface JobStatus {
  jobId: string; status: string; assetId?: string; downloadUrl?: string; error?: string; taskId?: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));
const fail = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

function parseJson<T = Record<string, unknown>>(v: unknown): T | undefined {
  if (v == null) return undefined;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return undefined; }
}

/** Wrap a tool handler so API errors become readable tool errors, not crashes. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof VividApiError) {
        const hint = err.status === 401 ? ' (check VIVID_API_KEY — generate one in Settings on vividai.tv)'
          : err.status === 402 || /crediti|credits/i.test(err.message) ? ' (not enough credits — top up on vividai.tv/billing)'
          : '';
        return fail(`VIVID API error ${err.status}: ${err.message}${hint}`);
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

function summariseModel(m: AiModel) {
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  const pricing = (caps.pricing ?? (m as unknown as { pricing?: unknown }).pricing) as Record<string, number> | undefined;
  const summary: Record<string, unknown> = {
    slug: m.slug,
    name: m.display_name,
    provider: m.provider,
    speed: m.speed,
    tiers: typeof m.tier_access === 'string' ? safeArray(m.tier_access) : m.tier_access,
  };
  if (m.type === 'video') {
    if (m.credits_per_second) summary.creditsPerSecond = m.credits_per_second;
    if (pricing) summary.pricingPerSecond = pricing;
    // Models priced per generation: a flat rate, or a resolution × duration
    // grid (Gemini Omni) — surface them or the model looks free.
    if (caps.flatCredits) summary.creditsPerVideo = caps.flatCredits;
    if (caps.creditTable) summary.creditsByResolutionAndDuration = caps.creditTable;
    if (caps.videoInputCredits) summary.creditsWithSourceVideo = caps.videoInputCredits;
    summary.durations = caps.durations;
    summary.resolutions = caps.resolutions;
    summary.aspectRatios = caps.aspectRatios;
    summary.supports = Object.entries(caps)
      .filter(([k, v]) => k.startsWith('supports') && v === true)
      .map(([k]) => k.replace(/^supports/, '').replace(/^[A-Z]/, (c) => c.toLowerCase()));
    if (caps.maxReferenceImages) summary.maxReferenceImages = caps.maxReferenceImages;
  } else {
    summary.creditsPerImage = m.credits_per_use;
    if (caps.creditRates) summary.creditRates = caps.creditRates;
    if (caps.aspectRatios) summary.aspectRatios = caps.aspectRatios;
    if (caps.resolutions) summary.resolutions = caps.resolutions;
  }
  if (m.description) summary.description = m.description;
  return summary;
}

function safeArray(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

async function pollUntilDone(
  fetchStatus: () => Promise<JobStatus>,
  timeoutMs: number,
  intervalMs: number,
): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: JobStatus | undefined;
  while (Date.now() < deadline) {
    last = await fetchStatus();
    if (last.status === 'completed' || last.status === 'failed' || last.status === 'cancelled') return last;
    await sleep(intervalMs);
  }
  return last ?? { jobId: '', status: 'processing' };
}

// ── registration ───────────────────────────────────────────────────────────

export function registerTools(server: McpServer, client: VividClient): void {
  const abs = (p?: string) => (p ? client.url(p) : undefined);

  server.registerTool('vivid_whoami', {
    title: 'Who am I on VIVID',
    description: 'Return the VIVID account linked to the API key: name, email, plan and remaining credits. Call this first to check the connection.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guarded(async () => {
    const { data } = await client.get<PublicUser>('/api/me');
    return json({ id: data.id, email: data.email, name: data.name, plan: data.plan, credits: data.credits, lang: data.lang });
  }));

  server.registerTool('vivid_usage', {
    title: 'Monthly usage',
    description: 'Monthly usage summary for the account (analyses, images, videos vs plan limits) and current credits.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guarded(async () => {
    const { data } = await client.get<unknown>('/api/ai/usage');
    return json(data);
  }));

  server.registerTool('vivid_list_models', {
    title: 'List AI models',
    description: 'List the AI models available to this account with pricing (credits) and capabilities. Use the returned `slug` as the `model` argument of vivid_generate_image / vivid_generate_video. Video models expose durations, resolutions, aspect ratios and what they support (startFrame, endFrame, reference, audio…).',
    inputSchema: {
      type: z.enum(['image', 'video']).describe('Which catalog to list.'),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ type }) => {
    const { data } = await client.get<AiModel[]>('/api/ai/models', { type });
    return json(data.map(summariseModel));
  }));

  server.registerTool('vivid_generate_image', {
    title: 'Generate image',
    description: 'Generate one or more images on VIVID from a text prompt. Optionally pass product / person / context reference image URLs (public URLs, e.g. from vivid_upload_file). Credits are charged per image according to the model. By default waits for completion and returns the asset ids and download URLs.',
    inputSchema: {
      prompt: z.string().min(3).describe('What to generate. English works best.'),
      model: z.string().describe('Model slug from vivid_list_models (type=image), e.g. "nano-banana-2".'),
      aspectRatio: z.enum(['1:1', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '3:2', '2:3']).default('1:1'),
      numImages: z.number().int().min(1).max(4).default(1),
      resolution: z.string().optional().describe('Model-specific, e.g. "1K" | "2K" | "4K" when supported.'),
      style: z.string().optional().describe('Optional style preset slug.'),
      objectImageUrls: z.array(z.string().url()).optional().describe('Product reference image URLs to preserve.'),
      modelImageUrls: z.array(z.string().url()).optional().describe('Person / testimonial reference image URLs.'),
      contextImageUrls: z.array(z.string().url()).optional().describe('Scene / context reference image URLs.'),
      projectId: z.string().optional().describe('Attach the generation to a VIVID project.'),
      wait: z.boolean().default(true).describe('Wait for the generation to finish (polls up to timeoutSec).'),
      timeoutSec: z.number().int().min(10).max(600).default(180),
    },
  }, guarded(async (a) => {
    const { data } = await client.post<ImageGenResult>('/api/ai/generate-image-v2', {
      prompt: a.prompt, model: a.model, aspectRatio: a.aspectRatio, numImages: a.numImages,
      resolution: a.resolution, style: a.style,
      objectImageUrls: a.objectImageUrls, modelImageUrls: a.modelImageUrls, contextImageUrls: a.contextImageUrls,
      projectId: a.projectId, source: 'mcp',
    });
    const jobIds = data.jobIds?.length ? data.jobIds : [data.jobId];
    if (!a.wait) {
      return json({ jobIds, status: data.status, creditsRemaining: data.creditsRemaining, hint: 'Call vivid_job_status with each jobId to collect the results.' });
    }
    const results = await Promise.all(jobIds.map((jobId) => pollUntilDone(
      async () => (await client.get<JobStatus>(`/api/ai/image-status/${jobId}`)).data,
      a.timeoutSec * 1000, 3000,
    )));
    return json({
      creditsRemaining: data.creditsRemaining,
      images: results.map((r, i) => ({
        jobId: jobIds[i], status: r.status, assetId: r.assetId, downloadUrl: abs(r.downloadUrl), error: r.error,
      })),
    });
  }));

  server.registerTool('vivid_generate_video', {
    title: 'Generate video',
    description: 'Start a video generation on VIVID. Pick a model with vivid_list_models (type=video) and respect its durations / resolutions / aspect ratios. Reference images, start/end frames and audio must be public URLs (use vivid_upload_file for local files). Credits are pre-charged (credits/second × duration). Videos take 1-5 minutes: by default this returns the jobId immediately — poll with vivid_job_status. Note: a model\'s start/end frame and reference images can be mutually exclusive (e.g. Seedance 2.5): the backend resolves it and returns a warning.',
    inputSchema: {
      prompt: z.string().min(3).describe('Shot description. Describe subject, action, camera, lighting; keep camera and subject movement in separate sentences.'),
      model: z.string().describe('Video model slug, e.g. "seedance-2.5", "kling-o3", "minimax-h3".'),
      duration: z.number().int().min(1).max(60).describe('Seconds — must be one of the model\'s supported durations.'),
      aspectRatio: z.string().default('16:9'),
      resolution: z.string().optional().describe('e.g. "480p" | "720p" | "1080p" when the model supports it. Defaults to the model default (usually 720p).'),
      generateAudio: z.boolean().optional().describe('Native audio (dialogue / SFX) when the model supports it.'),
      startFrameUrl: z.string().url().optional().describe('Image-to-video first frame.'),
      endFrameUrl: z.string().url().optional().describe('Last frame (needs startFrameUrl on most models).'),
      referenceImageUrls: z.array(z.string().url()).optional().describe('Subject / product reference images (models with "reference" support).'),
      audioFileUrls: z.array(z.string().url()).optional().describe('Audio files: voice for talking-head models, or reference audio where supported.'),
      mode: z.string().optional().describe('Model mode when applicable (e.g. "std" | "pro" for Kling O3).'),
      projectId: z.string().optional(),
      wait: z.boolean().default(false).describe('Block until the video is ready (polls up to timeoutSec). Prefer false + vivid_job_status for long clips.'),
      timeoutSec: z.number().int().min(30).max(900).default(420),
    },
  }, guarded(async (a) => {
    const { data } = await client.post<VideoGenResult>('/api/ai/generate-video', {
      prompt: a.prompt, model: a.model, requestedModel: a.model, duration: a.duration, aspectRatio: a.aspectRatio,
      resolution: a.resolution, generateAudio: a.generateAudio, mode: a.mode,
      startFrameUrl: a.startFrameUrl, endFrameUrl: a.endFrameUrl,
      referenceImageUrls: a.referenceImageUrls, audioFileUrls: a.audioFileUrls,
      projectId: a.projectId, source: 'mcp',
    });
    if (data.requiresConfirmation) {
      return json({ requiresConfirmation: true, message: 'The backend asks for a confirmation (model incompatible with the inputs). Options:', confirmOptions: data.confirmOptions, routing: data.routing });
    }
    const base = { jobId: data.jobId, taskId: data.taskId, creditsRemaining: data.creditsRemaining, warning: data.warning };
    if (!a.wait) {
      return json({ ...base, status: 'processing', estimatedTime: data.estimatedTime, hint: `Poll with vivid_job_status jobId=${data.jobId}.` });
    }
    const final = await pollUntilDone(
      async () => (await client.get<JobStatus>(`/api/ai/video-status/${data.jobId}`)).data,
      a.timeoutSec * 1000, 10000,
    );
    return json({ ...base, status: final.status, assetId: final.assetId, downloadUrl: abs(final.downloadUrl), error: final.error });
  }));

  server.registerTool('vivid_job_status', {
    title: 'Job status',
    description: 'Check a generation job (image or video). For video jobs this also triggers the provider status refresh, so call it to advance a processing job. Returns status, asset id and download URL when done.',
    inputSchema: {
      jobId: z.string(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ jobId }) => {
    const { data: job } = await client.get<Job>(`/api/jobs/${jobId}`);
    let live: JobStatus | undefined;
    if (job.status === 'processing' || job.status === 'pending') {
      const path = job.type === 'video_ugc' ? `/api/ai/video-status/${jobId}` : `/api/ai/image-status/${jobId}`;
      try { live = (await client.get<JobStatus>(path)).data; } catch { /* fall back to the stored job */ }
    }
    const output = parseJson(job.output) ?? {};
    const status = live?.status ?? job.status;
    const assetId = live?.assetId ?? (output.assetId as string | undefined) ?? job.assets?.[0]?.id;
    return json({
      jobId: job.id, type: job.type, status, creditsUsed: job.credits_used, createdAt: job.created_at,
      assetId, downloadUrl: assetId ? client.url(`/api/assets/${assetId}/download`) : undefined,
      error: live?.error ?? (output.error as string | undefined),
      assets: job.assets?.map((x) => ({ id: x.id, type: x.type, filename: x.filename })),
    });
  }));

  server.registerTool('vivid_list_jobs', {
    title: 'List jobs',
    description: 'List recent generation jobs, newest first. Filter by type (image_gen, video_ugc, product_analysis…) or status (pending, processing, completed, failed).',
    inputSchema: {
      type: z.string().optional(),
      status: z.string().optional(),
      projectId: z.string().optional(),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (a) => {
    const { data, pagination } = await client.get<Job[]>('/api/jobs', {
      type: a.type, status: a.status, project_id: a.projectId, page: a.page, limit: a.limit,
    });
    return json({
      pagination,
      jobs: data.map((j) => {
        const input = parseJson(j.input) ?? {};
        const output = parseJson(j.output) ?? {};
        return {
          id: j.id, type: j.type, status: j.status, creditsUsed: j.credits_used, createdAt: j.created_at,
          model: input.model, prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 160) : undefined,
          assetId: output.assetId ?? output.generatedAssetId, error: output.error,
        };
      }),
    });
  }));

  server.registerTool('vivid_list_assets', {
    title: 'List assets',
    description: 'Browse the account gallery: generated images/videos, uploaded products, testimonials (type: image | video | audio; category: generated | ecommerce | model | context | video …).',
    inputSchema: {
      type: z.enum(['image', 'video', 'audio']).optional(),
      category: z.string().optional(),
      favorite: z.boolean().optional(),
      projectId: z.string().optional(),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(24),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (a) => {
    const { data, pagination } = await client.get<Asset[]>('/api/assets', {
      type: a.type, category: a.category, favorite: a.favorite ? 'true' : undefined, project_id: a.projectId,
      page: a.page, limit: a.limit,
    });
    return json({
      pagination,
      assets: data.map((x) => ({
        id: x.id, type: x.type, category: x.category, filename: x.filename, createdAt: x.created_at,
        favorite: !!x.is_favorite, public: !!x.is_public,
        downloadUrl: client.url(`/api/assets/${x.id}/download`),
        publicUrl: x.is_public && x.share_token ? client.url(`/api/public/assets/${x.share_token}`) : undefined,
        thumbUrl: x.thumbUrl,
      })),
    });
  }));

  server.registerTool('vivid_get_asset', {
    title: 'Get asset',
    description: 'Metadata for one asset (type, filename, favorite/public flags, share link if public, originating job).',
    inputSchema: { assetId: z.string() },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ assetId }) => {
    const { data } = await client.get<Asset>(`/api/assets/${assetId}`);
    return json({
      ...data, favorite: !!data.is_favorite, public: !!data.is_public,
      downloadUrl: client.url(`/api/assets/${data.id}/download`),
      publicUrl: data.is_public && data.share_token ? client.url(`/api/public/assets/${data.share_token}`) : undefined,
    });
  }));

  server.registerTool('vivid_download_asset', {
    title: 'Download asset',
    description: 'Download an asset (image / video) to a local directory and return the saved path.',
    inputSchema: {
      assetId: z.string(),
      outputDir: z.string().describe('Absolute directory path where the file will be written (created if missing).'),
      filename: z.string().optional().describe('Override the file name (extension added from the content type if missing).'),
    },
  }, guarded(async ({ assetId, outputDir, filename }) => {
    const { data: meta } = await client.get<Asset>(`/api/assets/${assetId}`);
    const { bytes, contentType } = await client.download(`/api/assets/${assetId}/download`);
    await mkdir(outputDir, { recursive: true });
    let name = filename ?? meta.filename ?? assetId;
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name = `${name}.${extensionFor(contentType)}`;
    const path = join(outputDir, name);
    await writeFile(path, bytes);
    return json({ path, bytes: bytes.byteLength, contentType });
  }));

  server.registerTool('vivid_share_asset', {
    title: 'Share / unshare asset',
    description: 'Make an asset public and get a shareable URL (no login required), or revoke sharing. Also toggles the favorite flag.',
    inputSchema: {
      assetId: z.string(),
      public: z.boolean().optional().describe('true = publish and return the public URL, false = unpublish.'),
      favorite: z.boolean().optional(),
    },
  }, guarded(async ({ assetId, public: isPublic, favorite }) => {
    if (isPublic === undefined && favorite === undefined) return fail('Pass `public` and/or `favorite`.');
    const { data } = await client.patch<Asset>(`/api/assets/${assetId}`, {
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
      ...(favorite === undefined ? {} : { is_favorite: favorite }),
    });
    return json({
      id: data.id, favorite: !!data.is_favorite, public: !!data.is_public,
      publicUrl: data.is_public && data.share_token ? client.url(`/api/public/assets/${data.share_token}`) : undefined,
    });
  }));

  server.registerTool('vivid_upload_file', {
    title: 'Upload file for generation',
    description: 'Upload a local file (absolute path) or a remote URL — image, video or audio — to VIVID\'s temporary storage and get a public URL to use as startFrameUrl, referenceImageUrls, objectImageUrls or audioFileUrls. Temporary files expire after 7 days; generated results are stored permanently in the gallery.',
    inputSchema: {
      source: z.string().describe('Absolute local file path or http(s) URL.'),
    },
  }, guarded(async ({ source }) => {
    const data = await client.tempUpload(source);
    return json(data);
  }));

  server.registerTool('vivid_list_projects', {
    title: 'List projects',
    description: 'List the account projects (brand containers) — use a project id to group generations.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guarded(async () => {
    const { data } = await client.get<Array<Record<string, unknown>>>('/api/projects');
    return json(data.map((p) => ({ id: p.id, name: p.name, brandName: p.brand_name, status: p.status, createdAt: p.created_at })));
  }));
}
