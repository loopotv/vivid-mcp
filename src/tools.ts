import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VividClient, VividApiError, extensionFor, sleep } from './client.js';
import { ensureBeatAnalysis, editUrlFor, importMedia, loadProject, newProject, saveProject, summarize, subtitlesOf, type AiCommand, type MediaImport } from './editor.js';
import { openHeadlessProject, projectSchemaV2 } from 'vivid-editor-core';
import { resolveAssetUrl } from './editor.js';

// ── API shapes (subset we surface) ─────────────────────────────────────────

interface PublicUser {
  id: string; email: string; name: string | null; plan: string; credits: number; lang?: string;
}

interface AiModel {
  slug: string; display_name: string; provider: string; type: string; description: string | null;
  credits_per_use: number; credits_per_second: number; speed: string; tier_access: string | string[];
  icon?: string; capabilities?: Record<string, unknown>;
}

interface ChatModel {
  slug: string; name: string; family: string; provider: string; description: string | null;
  creditsPerMTokens: { input: number; output: number }; supportsReasoningEffort: boolean;
}

interface ChatResult {
  text: string; model: string; family: string; usage: { inputTokens: number; outputTokens: number };
  credits: number; providerCredits?: number; creditsRemaining: number;
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
  /** What the file is and what to tell the audience when publishing it (AI Act art. 50). null = the user's own upload. */
  disclosure?: { kind: 'avatar' | 'product_photo' | 'concept' | 'generated'; notice: string } | null;
}

interface MentionItem {
  id: string; label: string; type: 'product' | 'testimonial'; assetId: string; metadata?: Record<string, unknown>; isPublic?: boolean;
}

/**
 * Resolve saved products / testimonials given by name (case-insensitive,
 * accents ignored, "#"/"@" prefix tolerated) or by asset id. Throws with the
 * available names when something does not match.
 */
export async function resolveReferences(client: VividClient, kind: MentionItem['type'], wanted: string[] | undefined, projectId?: string): Promise<string[]> {
  if (!wanted || wanted.length === 0) return [];
  const { data } = await client.get<MentionItem[]>('/api/assets/mentionable', { project_id: projectId });
  const pool = data.filter((m) => m.type === kind);
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^[#@]/, '').replace(/[\s_-]+/g, ' ').trim().toLowerCase();
  const ids: string[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const key = norm(w);
    const hit = pool.find((m) => m.assetId === w || m.id === w)
      ?? pool.find((m) => norm(m.label) === key)
      ?? pool.find((m) => norm(m.label).includes(key) || key.includes(norm(m.label)));
    if (hit) { if (!ids.includes(hit.assetId)) ids.push(hit.assetId); } else missing.push(w);
  }
  if (missing.length) {
    const names = pool.map((m) => m.label).slice(0, 40).join(', ') || 'none';
    throw new VividApiError(`${kind === 'product' ? 'Product' : 'Testimonial'} not found: ${missing.join(', ')}. Available ${kind}s: ${names}`, 404);
  }
  return ids;
}

interface AnalyzeStatus {
  status: string; error?: string | null; generatedAssetId?: string | null; originalAssetId?: string | null;
  analysis?: { title?: string; description?: string; category?: string; colors?: unknown; material?: string; finish?: string; style?: string; keywords?: unknown } | null;
}

interface TestimonialStatus {
  status: 'processing' | 'completed' | 'failed'; compositeAssetId?: string; personId?: string; description?: Record<string, unknown>; error?: string;
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

interface RenderJob {
  id: string; status: 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled'; projectAssetId: string;
  executor: string | null; progress: number; options: { name?: string }; outputAssetId: string | null;
  downloadUrl?: string; error: string | null; openUrl: string; createdAt: string;
}

/**
 * What only a server running on the user's machine can do. The stdio server
 * passes the Node implementation (see tools-local.ts); the remote Worker
 * passes nothing, and the tools then skip local side effects (outputDir /
 * outputPath are ignored, vivid_download_asset is not registered).
 */
export interface LocalIo {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  join(...parts: string[]): string;
  openInBrowser(url: string): boolean;
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
          : err.status === 402 || /crediti insufficienti|insufficient credits|not enough credits/i.test(err.message) ? ' (not enough credits — top up on vividai.tv/billing)'
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
    // Seedance 2.x: with reference videos the rate drops but the uploaded
    // seconds are billed too — (input + output) × rate.
    if (caps.videoRefPricing) summary.creditsPerSecondWithReferenceVideo = { rates: caps.videoRefPricing, billedOn: 'reference video seconds + output seconds' };
    if (caps.supportsVideoReference) {
      summary.referenceVideos = Object.fromEntries(Object.entries({
        max: caps.videoReferenceCount, minSecondsEach: caps.videoReferenceMinS, maxSecondsEach: caps.videoReferenceMaxS,
        maxSecondsTotal: caps.videoReferenceMaxTotalS, minPixels: caps.videoReferenceMinPixels, maxPixels: caps.videoReferenceMaxPixels,
      }).filter(([, v]) => v != null));
    }
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

export function registerTools(server: McpServer, client: VividClient, io?: LocalIo): void {
  const abs = (p?: string) => (p ? client.url(p) : undefined);
  /** Text for the local server vs the hosted connector (no filesystem there). */
  const L = (local: string, remote: string) => (io ? local : remote);
  /** Schema fields that only make sense with a filesystem (outputDir / outputPath). */
  const localOnly = <T extends object>(shape: T): T => (io ? shape : ({} as T));
  const remoteOnly = <T extends object>(shape: T): T => (io ? ({} as T) : shape);
  /** Hosted connectors (Claude.ai, ChatGPT) cut a tool call after about a
   *  minute: there the long-running tools wait ~40 s, then hand back an id. */
  const WAIT = (localSec: number) => (io ? localSec : 40);

  /**
   * A download link a human can click. `/api/assets/:id/download` needs the
   * X-API-Key header, so the bare URL dies with AUTH_REQUIRED when the client
   * renders it as a link and the user clicks it in a browser. Takes whatever
   * we have — the path the API returned, an absolute URL, or a bare asset id —
   * and returns the signed, expiring twin.
   */
  const dl = async (pathOrId?: string): Promise<string | undefined> => {
    if (!pathOrId) return undefined;
    if (/[?&]sig=/.test(pathOrId)) return abs(pathOrId); // already signed by the API
    const m = /\/api\/assets\/([^/?#]+)\/download/.exec(pathOrId);
    const id = m ? m[1]! : (pathOrId.includes('/') ? undefined : pathOrId);
    return id ? client.downloadLink(id) : abs(pathOrId);
  };

  server.registerTool('vivid_whoami', {
    title: 'Who am I on VIVID',
    description: 'Return the VIVID account linked to the API key: name, email, plan and remaining credits. Call this first to check the connection.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    const { data } = await client.get<PublicUser>('/api/me');
    return json({ id: data.id, email: data.email, name: data.name, plan: data.plan, credits: data.credits, lang: data.lang });
  }));

  server.registerTool('vivid_usage', {
    title: 'Monthly usage',
    description: 'Monthly usage summary for the account (analyses, images, videos vs plan limits) and current credits.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    const { data } = await client.get<unknown>('/api/ai/usage');
    return json(data);
  }));

  server.registerTool('vivid_list_models', {
    title: 'List AI models',
    description: 'List the AI models available to this account with pricing (credits) and capabilities. Use the returned `slug` as the `model` argument of vivid_generate_image / vivid_generate_video. Video models expose durations, resolutions, aspect ratios and what they support (startFrame, endFrame, reference, audio…).',
    inputSchema: {
      type: z.enum(['image', 'video', 'llm']).optional().describe('Which catalog to list. Omit to get image + video; "llm" lists the chat models for vivid_chat.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ type }) => {
    if (type === 'llm') return json((await client.get<ChatModel[]>('/api/ai/chat/models')).data);
    const list = async (t: 'image' | 'video') => (await client.get<AiModel[]>('/api/ai/models', { type: t })).data.map(summariseModel);
    if (type) return json(await list(type));
    const [image, video] = await Promise.all([list('image'), list('video')]);
    return json({ image, video });
  }));

  server.registerTool('vivid_chat', {
    title: 'Chat with an LLM',
    description: 'Run one chat completion on VIVID\'s LLM routing (Grok, Claude, OpenAI GPT via Kie.ai; Kimi via Wavespeed) paid in credits: provider price + 50%, billed per token (list with vivid_list_models type="llm", prices in credits per 1M tokens). Non-streaming. Pass the full conversation each call (system/user/assistant); image parts as {type:"image_url", image_url:{url}} on vision models. Returns the reply text, token usage and the credits charged.',
    inputSchema: {
      messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.union([z.string(), z.array(z.union([
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().url() }) }),
        ]))]),
      })).min(1).max(80),
      model: z.string().optional().describe('Model slug from vivid_list_models type="llm" (grok-4.6, claude-sonnet-5, gpt-5.6-terra, kimi-k2-5…). Default: the account default (Grok 4.6).'),
      maxTokens: z.number().int().min(64).max(16000).default(2000),
      reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe('Grok / GPT only.'),
    },
    // spends credits, creates nothing
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const { data } = await client.post<ChatResult>('/api/ai/chat', { model: a.model, messages: a.messages, maxTokens: a.maxTokens, reasoningEffort: a.reasoningEffort });
    return json(data);
  }));

  server.registerTool('vivid_generate_image', {
    title: 'Generate image',
    description: 'Generate one or more images on VIVID from a text prompt. Feature saved products and testimonials by NAME with `products` / `testimonials` (same as the app\'s #Product / @Testimonial mentions — list them with vivid_list_references), or pass ad-hoc reference image URLs (public URLs, e.g. from vivid_upload_file). Credits are charged per image according to the model. By default waits for completion and returns the asset ids and download URLs.',
    inputSchema: {
      prompt: z.string().min(3).describe('What to generate. English works best.'),
      model: z.string().describe('Model slug from vivid_list_models (type=image), e.g. "nano-banana-2". For images that must carry legible text (claims, labels, posters, banners) prefer "ideogram-4.5".'),
      aspectRatio: z.enum(['1:1', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '3:2', '2:3']).default('1:1'),
      numImages: z.number().int().min(1).max(4).default(1),
      resolution: z.string().optional().describe('Model-specific, e.g. "1K" | "2K" | "4K" when supported.'),
      quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Quality tier for models that price by quality (GPT Image 2 / 2.5, Ideogram 4.5): credits grow with quality × resolution — see creditRates in vivid_list_models (e.g. gpt-image-2.5 1K: low 4, medium 5, high 12, xhigh 19, max 39; ideogram-4.5 1K or 2K: low 6, medium 9, high 25 — xhigh/max not supported). Default: medium (high for jewelry).'),
      style: z.string().optional().describe('Optional style preset slug.'),
      products: z.array(z.string()).optional().describe('Saved products to feature, by name (as in the app\'s "#" picker, e.g. "Borsa Nera") or asset id — see vivid_list_references. The product\'s look and geometry are locked like in the app.'),
      testimonials: z.array(z.string()).optional().describe('Saved testimonials / characters to cast, by name (as in the app\'s "@" picker, e.g. "Lina") or asset id — see vivid_list_references. Identity is locked.'),
      objectImageUrls: z.array(z.string().url()).optional().describe('Ad-hoc product reference image URLs (for products NOT saved in VIVID).'),
      modelImageUrls: z.array(z.string().url()).optional().describe('Ad-hoc person reference image URLs (for people NOT saved as testimonials).'),
      contextImageUrls: z.array(z.string().url()).optional().describe('Scene / context reference image URLs.'),
      projectId: z.string().optional().describe('Attach the generation to a VIVID project.'),
      wait: z.boolean().default(true).describe('Wait for the generation to finish (polls up to timeoutSec).'),
      timeoutSec: z.number().int().min(10).max(600).default(WAIT(180)).describe(L('Seconds to wait before returning the job ids still running.', 'Seconds to wait before returning the job ids still running — hosted connectors time out after about a minute, keep it short. Never re-generate a job that is still processing: poll it with vivid_job_status.')),
    },
    // spends credits, adds new assets
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const [objectImageIds, modelImageIds] = await Promise.all([
      resolveReferences(client, 'product', a.products, a.projectId),
      resolveReferences(client, 'testimonial', a.testimonials, a.projectId),
    ]);
    const { data } = await client.post<ImageGenResult>('/api/ai/generate-image-v2', {
      prompt: a.prompt, model: a.model, aspectRatio: a.aspectRatio, numImages: a.numImages,
      resolution: a.resolution, quality: a.quality, style: a.style,
      ...(objectImageIds.length ? { objectImageIds } : {}),
      ...(modelImageIds.length ? { modelImageIds } : {}),
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
    const pending = results.some((r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled');
    return json({
      creditsRemaining: data.creditsRemaining,
      images: await Promise.all(results.map(async (r, i) => ({
        jobId: jobIds[i], status: r.status, assetId: r.assetId, downloadUrl: await dl(r.downloadUrl ?? r.assetId), error: r.error,
      }))),
      hint: pending ? 'Still generating (already paid): call vivid_job_status with each processing jobId — do NOT generate again.' : undefined,
    });
  }));

  server.registerTool('vivid_generate_video', {
    title: 'Generate video',
    description: 'Start a video generation on VIVID. Pick a model with vivid_list_models (type=video) and respect its durations / resolutions / aspect ratios. Reference images, start/end frames and audio must be public URLs' + L(' (use vivid_upload_file for local files)', '') + '. Credits are pre-charged (credits/second × duration). Videos take 1-5 minutes: by default this returns the jobId immediately — poll with vivid_job_status. Note: a model\'s start/end frame and reference images can be mutually exclusive (e.g. Seedance 2.5): the backend resolves it and returns a warning. Reference videos (referenceVideoUrls) work on models whose vivid_list_models entry has `referenceVideos`: Seedance 2.0/2.5 bill the uploaded seconds too, Gemini Omni takes one source clip.',
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
      referenceVideoUrls: z.array(z.string().url()).max(3).optional().describe('Reference videos (MP4/MOV) to copy motion, rhythm or framing from. Seedance 2.0: max 3, 15 s in all. Seedance 2.5: max 3, 2–30 s each, 30 s in all, 480p or 720p only (never with start/end frame). Gemini Omni: 1 clip, first 10 s. Billed seconds: see vivid_list_models.'),
      mode: z.string().optional().describe('Model mode when applicable (e.g. "std" | "pro" for Kling O3).'),
      projectId: z.string().optional(),
      wait: z.boolean().default(false).describe('Block until the video is ready (polls up to timeoutSec). Prefer false + vivid_job_status for long clips.'),
      timeoutSec: z.number().int().min(30).max(900).default(420),
    },
    // spends credits, adds a new asset
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const { data } = await client.post<VideoGenResult>('/api/ai/generate-video', {
      prompt: a.prompt, model: a.model, requestedModel: a.model, duration: a.duration, aspectRatio: a.aspectRatio,
      resolution: a.resolution, generateAudio: a.generateAudio, mode: a.mode,
      startFrameUrl: a.startFrameUrl, endFrameUrl: a.endFrameUrl,
      referenceImageUrls: a.referenceImageUrls, audioFileUrls: a.audioFileUrls,
      ...(a.referenceVideoUrls?.length ? { videoReferences: a.referenceVideoUrls.map((url) => ({ url })) } : {}),
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
    return json({ ...base, status: final.status, assetId: final.assetId, downloadUrl: await dl(final.downloadUrl ?? final.assetId), error: final.error });
  }));

  server.registerTool('vivid_job_status', {
    title: 'Job status',
    description: 'Check a generation job (image or video). For video jobs this also triggers the provider status refresh, so call it to advance a processing job. Returns status, asset id and download URL when done.',
    inputSchema: {
      jobId: z.string(),
    },
    // NOT readOnly: on a processing video job this polls the provider, and the
    // server then records the finished result (status + asset). Nothing new is
    // created or removed — the generation was already paid for and produced —
    // so it is non-destructive and idempotent.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async ({ jobId }) => {
    let { data: job } = await client.get<Job>(`/api/jobs/${jobId}`);
    let live: JobStatus | undefined;
    if (job.status === 'processing' || job.status === 'pending') {
      const path = job.type === 'video_ugc' ? `/api/ai/video-status/${jobId}` : `/api/ai/image-status/${jobId}`;
      try { live = (await client.get<JobStatus>(path)).data; } catch { /* fall back to the stored job */ }
      // The poll may have just finished the job: the job read above predates
      // its asset (and older APIs send no assetId in the status), so read it again.
      if (live && live.status !== job.status && !live.assetId) {
        try { job = (await client.get<Job>(`/api/jobs/${jobId}`)).data; } catch { /* keep the first read */ }
      }
    }
    const output = parseJson(job.output) ?? {};
    const status = live?.status ?? job.status;
    const assetId = live?.assetId ?? (output.assetId as string | undefined) ?? job.assets?.[0]?.id;
    return json({
      jobId: job.id, type: job.type, status, creditsUsed: job.credits_used, createdAt: job.created_at,
      assetId, downloadUrl: await dl(assetId),
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async (a) => {
    const { data, pagination } = await client.get<Asset[]>('/api/assets', {
      type: a.type, category: a.category, favorite: a.favorite ? 'true' : undefined, project_id: a.projectId,
      page: a.page, limit: a.limit,
    });
    const links = await client.downloadLinks(data.map((x) => x.id));
    return json({
      pagination,
      assets: data.map((x) => ({
        id: x.id, type: x.type, category: x.category, filename: x.filename, createdAt: x.created_at,
        favorite: !!x.is_favorite, public: !!x.is_public,
        downloadUrl: links.get(x.id),
        publicUrl: x.is_public && x.share_token ? client.url(`/api/public/assets/${x.share_token}`) : undefined,
        thumbUrl: abs(x.thumbUrl),
      })),
    });
  }));

  server.registerTool('vivid_get_asset', {
    title: 'Get asset',
    description: 'Metadata for one asset (type, filename, favorite/public flags, share link if public, originating job).',
    inputSchema: { assetId: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ assetId }) => {
    const { data } = await client.get<Asset>(`/api/assets/${assetId}`);
    return json({
      ...data, favorite: !!data.is_favorite, public: !!data.is_public,
      downloadUrl: await dl(data.id),
      publicUrl: data.is_public && data.share_token ? client.url(`/api/public/assets/${data.share_token}`) : undefined,
    });
  }));

  if (io) {
  server.registerTool('vivid_download_asset', {
    title: 'Download asset',
    description: 'Download an asset (image / video) to a local directory and return the saved path.',
    inputSchema: {
      assetId: z.string(),
      outputDir: z.string().describe('Absolute directory path where the file will be written (created if missing).'),
      filename: z.string().optional().describe('Override the file name (extension added from the content type if missing).'),
    },
    // writes to the local filesystem and can overwrite a file
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, guarded(async ({ assetId, outputDir, filename }) => {
    const { data: meta } = await client.get<Asset>(`/api/assets/${assetId}`);
    const { bytes, contentType } = await client.download(`/api/assets/${assetId}/download`);
    await io!.mkdir(outputDir);
    let name = filename ?? meta.filename ?? assetId;
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name = `${name}.${extensionFor(contentType)}`;
    const path = io!.join(outputDir, name);
    await io!.writeFile(path, bytes);
    return json({ path, bytes: bytes.byteLength, contentType, ...(meta.disclosure ? { disclosure: meta.disclosure } : {}) });
  }));
  }

  server.registerTool('vivid_share_asset', {
    title: 'Share / unshare asset',
    description: 'Make an asset public and get a shareable URL (no login required), or revoke sharing. Also toggles the favorite flag. The reply carries `disclosure.notice`: relay it to the user when they share or publish AI-generated content.',
    inputSchema: {
      assetId: z.string(),
      public: z.boolean().optional().describe('true = publish and return the public URL, false = unpublish.'),
      favorite: z.boolean().optional(),
    },
    // publishes a link anyone can open, or revokes it — reversible
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async ({ assetId, public: isPublic, favorite }) => {
    if (isPublic === undefined && favorite === undefined) return fail('Pass `public` and/or `favorite`.');
    const { data } = await client.patch<Asset>(`/api/assets/${assetId}`, {
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
      ...(favorite === undefined ? {} : { is_favorite: favorite }),
    });
    return json({
      id: data.id, favorite: !!data.is_favorite, public: !!data.is_public,
      publicUrl: data.is_public && data.share_token ? client.url(`/api/public/assets/${data.share_token}`) : undefined,
      ...(data.disclosure ? { disclosure: data.disclosure } : {}),
    });
  }));

  server.registerTool('vivid_upload_file', {
    title: 'Upload file for generation',
    description: L('Upload a local file (absolute path) or a remote URL', 'Copy a remote URL') + ' — image, video or audio — to VIVID\'s temporary storage and get a public URL to use as startFrameUrl, referenceImageUrls, objectImageUrls or audioFileUrls. Temporary files expire after 7 days; generated results are stored permanently in the gallery.',
    inputSchema: {
      source: z.string().describe(L('Absolute local file path or http(s) URL.', 'http(s) URL of the file.')),
    },
    // adds a temporary file (expires after 7 days)
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async ({ source }) => {
    const data = await client.tempUpload(source);
    return json(data);
  }));

  // ── Saved references (products / testimonials) ───────────────────────────

  server.registerTool('vivid_list_references', {
    title: 'List saved products and testimonials',
    description: 'The account\'s saved PRODUCTS (from "Analizza prodotto": name, category, colors, material…) and TESTIMONIALS / characters (from "Crea testimonial": name, gender, age, look…) with their asset ids. Use the names in vivid_generate_image `products` / `testimonials` to feature them with locked look and identity — the same as typing #Product / @Testimonial in the app. Shared public talents are included (isPublic).',
    inputSchema: {
      type: z.enum(['product', 'testimonial', 'all']).default('all'),
      projectId: z.string().optional().describe('Order the active project\'s products first.'),
      query: z.string().optional().describe('Filter by name (substring, case-insensitive).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async (a) => {
    const { data } = await client.get<MentionItem[]>('/api/assets/mentionable', { project_id: a.projectId });
    const q = a.query?.trim().toLowerCase();
    const matches = data
      .filter((m) => a.type === 'all' || m.type === a.type)
      .filter((m) => !q || m.label.toLowerCase().includes(q));
    const links = await client.downloadLinks(matches.map((m) => m.assetId));
    const items = matches
      .map((m) => ({
        type: m.type, name: m.label, assetId: m.assetId, isPublic: m.isPublic || undefined,
        downloadUrl: links.get(m.assetId),
        ...(m.metadata && Object.keys(m.metadata).length ? { metadata: m.metadata } : {}),
      }));
    return json({ count: items.length, products: items.filter((i) => i.type === 'product'), testimonials: items.filter((i) => i.type === 'testimonial') });
  }));

  server.registerTool('vivid_analyze_product', {
    title: 'Analyze a product photo (save as product)',
    description: 'Run VIVID\'s "Analizza prodotto" on a product photo: vision analysis (name, category, colors, material, finish, style, keywords) + a clean e-commerce render, saved to the account as a PRODUCT you can then feature by name in vivid_generate_image `products` (see vivid_list_references). Free — counts toward the plan\'s monthly analysis quota (50/month on Free). Takes 30–90 s; waits by default. For jewelry the geometry lock may ask the app to confirm the category; the name comes from the analysis (rename in the app if needed).',
    inputSchema: {
      image: z.string().min(1).optional().describe(L(
        'Product photo: absolute local path (preferred — uploaded as multipart) or URL (JPEG/PNG/WebP, max 15 MB; some CDNs such as Pexels refuse server-side downloads → use a local path). URLs from vivid_upload_file work too.',
        'Product photo URL (JPEG/PNG/WebP, max 15 MB) — a public URL or one returned by vivid_upload_file.')),
      assetId: z.string().optional().describe('Analyze a photo already in the VIVID gallery (asset id from vivid_list_assets) instead of `image`.'),
      jobId: z.string().optional().describe('Resume waiting on an analysis that returned status "processing" (no new analysis, no quota).'),
      description: z.string().max(1000).optional().describe('What the product is, to help the analysis (e.g. "silver bracelet with blue pearls").'),
      locale: z.enum(['it', 'en', 'es']).default('it').describe('Language of the generated name/description.'),
      wait: z.boolean().default(true),
      timeoutSec: z.number().int().min(10).max(600).default(WAIT(240)),
    },
    // free, but saves a new product on the account
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    let started: { jobId: string; status: string };
    if (a.jobId) {
      started = { jobId: a.jobId, status: 'processing' };
    } else {
      if (!a.image && !a.assetId) throw new Error(L('Pass `image` (local path or URL) or `assetId`.', 'Pass `image` (URL) or `assetId`.'));
      const form = new FormData();
      if (!a.image) form.append('assetId', a.assetId!);
      else if (/^https?:\/\//i.test(a.image)) form.append('imageUrl', a.image);
      else { const f = await client.loadSource(a.image); form.append('image', f.blob, f.filename); }
      if (a.description) form.append('description', a.description);
      form.append('locale', a.locale);
      started = (await client.post<{ jobId: string; status: string }>('/api/ai/analyze-image', form)).data;
    }
    const resume = `Still analyzing: call vivid_analyze_product with jobId "${started.jobId}" to keep waiting — do NOT start a new analysis.`;
    if (!a.wait) return json({ jobId: started.jobId, status: started.status, hint: resume });
    const deadline = Date.now() + a.timeoutSec * 1000;
    let last: AnalyzeStatus = { status: 'processing' };
    while (Date.now() < deadline) {
      await sleep(4000);
      last = (await client.get<AnalyzeStatus>(`/api/ai/analyze-status/${started.jobId}`)).data;
      if (last.status === 'completed' || last.status === 'failed') break;
    }
    const an = last.analysis ?? {};
    return json({
      jobId: started.jobId, status: last.status, error: last.error ?? undefined,
      name: an.title, productAssetId: last.generatedAssetId ?? undefined, originalAssetId: last.originalAssetId ?? undefined,
      analysis: last.analysis ? { category: an.category, description: an.description, colors: an.colors, material: an.material, finish: an.finish, style: an.style, keywords: an.keywords } : undefined,
      downloadUrl: await dl(last.generatedAssetId ?? undefined),
      hint: last.status === 'completed' && an.title ? `Use products: ["${an.title}"] in vivid_generate_image.`
        : last.status === 'failed' ? undefined : resume,
    });
  }));

  server.registerTool('vivid_create_testimonial', {
    title: 'Create a testimonial (AI model / persona)',
    description: 'Create a reusable TESTIMONIAL on the account — a consistent person you can cast by name in vivid_generate_image `testimonials` (identity locked). Two ways: `photos` = three photos of a REAL person (left profile, front, right profile) → composite identity. Requires `consent: true`: set it ONLY after the user has confirmed that the person pictured is them or has consented to being turned into a virtual presenter; the consent is recorded with time and IP, and photos with nudity or sexual content are refused; or `attributes` = design the person from scratch (gender, age, ethnicity required; optional bodyType, faceShape, nose, eyeShape, eyeColor, hairColor, hairStyle, hairTexture, skinType, skinColor, expression, distinguishingMarks… values in English as in the app, e.g. gender "Female", age "25-35", ethnicity "Mediterranean"). Costs 50 credits. Takes 1–3 minutes; waits by default and returns the assigned name (personId) and the composite asset. The name is picked automatically from a curated pool.',
    inputSchema: {
      photos: z.object({ left: z.string(), front: z.string(), right: z.string() }).optional().describe(L('Local paths or URLs of the three views of a real person.', 'URLs of the three views of a real person.')),
      attributes: z.record(z.string(), z.string()).optional().describe('From-scratch persona attributes (gender, age, ethnicity + optional look fields).'),
      consent: z.boolean().optional().describe('Required with `photos`: true only once the user has confirmed the person pictured is them or has given consent. Never assume it.'),
      locale: z.enum(['it', 'en', 'es']).default('it'),
      projectId: z.string().optional(),
      wait: z.boolean().default(true),
      timeoutSec: z.number().int().min(30).max(900).default(WAIT(300)),
      jobId: z.string().optional().describe('Resume waiting on a testimonial that returned status "processing" (no new charge).'),
    },
    // spends credits, saves a new testimonial
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    let jobId: string;
    if (a.jobId) {
      jobId = a.jobId;
    } else if (a.photos) {
      if (a.consent !== true) {
        throw new VividApiError('Creating a testimonial from photos of a real person needs consent: true. Ask the user to confirm that the person pictured is them or has consented; if they cannot, use `attributes` to design a person instead.', 400);
      }
      const form = new FormData();
      for (const view of ['left', 'front', 'right'] as const) {
        const f = await client.loadSource(a.photos[view]);
        form.append(view, f.blob, f.filename);
      }
      form.append('locale', a.locale);
      form.append('consent', 'true');
      if (a.projectId) form.append('projectId', a.projectId);
      jobId = (await client.post<{ jobId: string }>('/api/ai/create-testimonial', form)).data.jobId;
    } else if (a.attributes) {
      for (const k of ['gender', 'age', 'ethnicity']) {
        if (!a.attributes[k]) throw new VividApiError(`attributes.${k} is required`, 400);
      }
      jobId = (await client.post<{ jobId: string }>('/api/ai/create-testimonial-scratch', { attributes: a.attributes, locale: a.locale, projectId: a.projectId })).data.jobId;
    } else {
      throw new VividApiError('Pass either photos {left, front, right} or attributes {gender, age, ethnicity, …}', 400);
    }
    const resume = `Still creating (already paid): call vivid_create_testimonial with jobId "${jobId}" to keep waiting — do NOT create it again.`;
    if (!a.wait) return json({ jobId, status: 'processing', hint: resume });
    const deadline = Date.now() + a.timeoutSec * 1000;
    let last: TestimonialStatus = { status: 'processing' };
    while (Date.now() < deadline) {
      await sleep(5000);
      last = (await client.get<TestimonialStatus>(`/api/ai/testimonial-status/${jobId}`)).data;
      if (last.status === 'completed' || last.status === 'failed') break;
    }
    return json({
      jobId, status: last.status, error: last.error,
      name: last.personId, testimonialAssetId: last.compositeAssetId,
      description: last.description,
      downloadUrl: await dl(last.compositeAssetId ?? undefined),
      hint: last.status === 'completed' && last.personId ? `Use testimonials: ["${last.personId}"] in vivid_generate_image.`
        : last.status === 'failed' ? undefined : resume,
    });
  }));

  // ── Voice (TTS) ──────────────────────────────────────────────────────────

  server.registerTool('vivid_list_voices', {
    title: 'List TTS voices and providers',
    description: 'List the text-to-speech providers and preset voices available on VIVID (Deepgram Aura-2, MiniMax HD + cloned voices, OmniVoice, OmniVoice Voice Clone, Gemini 3.1 Flash) with their credit cost. Use it before vivid_generate_voice.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    const { data } = await client.get<Record<string, unknown>>('/api/ai/tts-voices');
    return json(data);
  }));

  server.registerTool('vivid_generate_voice', {
    title: 'Generate voice (TTS)',
    description: 'Synthesize speech from text. Providers: "omnivoice-clone" clones a voice from a 3–10 s reference (0.5 credits/clip, best for a consistent presenter), "gemini" = Google Gemini 3.1 Flash presets like Kore/Puck/Zephyr/Charon/Aoede (1 credit/clip, rich prosody), "minimax" = MiniMax Speech 2.8 HD presets (ids from vivid_list_voices → minimax[]) or one of the account\'s cloned voices (pass its id) with an optional emotion (1 credit/clip), "omnivoice" = voice designed from an English description (0.5), "deepgram" = Aura-2 presets (free). Returns a public MP3 URL (7-day temp storage) and optionally downloads it.',
    inputSchema: {
      text: z.string().min(1).max(3000),
      provider: z.enum(['omnivoice-clone', 'gemini', 'minimax', 'omnivoice', 'deepgram']).default('gemini'),
      locale: z.enum(['it', 'en', 'es']).default('it'),
      voice: z.string().optional().describe('gemini: preset name (Kore…); minimax: preset id (Italian_Narrator…) or a cloned voice id; deepgram: model id (aura-2-livia-it…); omnivoice: voice description in English.'),
      emotion: z.enum(['neutral', 'happy', 'sad', 'angry', 'surprised', 'calm', 'whisper', 'fearful']).optional().describe('minimax only.'),
      referenceAudio: z.string().optional().describe(L('omnivoice-clone: local path or URL of 3–10 s of the voice to clone.', 'omnivoice-clone: URL of 3–10 s of the voice to clone.')),
      referenceText: z.string().optional().describe('omnivoice-clone: transcript of the reference clip (improves accuracy).'),
      speed: z.number().min(0.1).max(5).optional(),
      ...localOnly({ outputDir: z.string().optional().describe('Download the MP3 into this local directory.') }),
      filename: z.string().optional(),
    },
    // spends credits, adds a new asset
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    let referenceAudioUrl: string | undefined;
    if (a.provider === 'omnivoice-clone') {
      if (!a.referenceAudio) throw new VividApiError('referenceAudio is required for omnivoice-clone', 400);
      referenceAudioUrl = /^https?:\/\//i.test(a.referenceAudio) ? a.referenceAudio : (await client.tempUpload(a.referenceAudio)).url;
    }
    const { data } = await client.post<{ url: string; provider: string; credits: number }>('/api/ai/tts-v2', {
      provider: a.provider, text: a.text, locale: a.locale, voice: a.voice, speed: a.speed, emotion: a.emotion, referenceAudioUrl, referenceText: a.referenceText,
    });
    let path: string | undefined;
    if (a.outputDir && io) {
      const { bytes } = await client.download(data.url);
      await io.mkdir(a.outputDir);
      path = io.join(a.outputDir, a.filename ?? `voice_${Date.now()}.mp3`);
      await io.writeFile(path, bytes);
    }
    return json({ url: data.url, provider: data.provider, credits: data.credits, path });
  }));

  server.registerTool('vivid_list_projects', {
    title: 'List projects',
    description: 'List the account projects (brand containers) — use a project id to group generations.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    const { data } = await client.get<Array<Record<string, unknown>>>('/api/projects');
    return json(data.map((p) => ({ id: p.id, name: p.name, brandName: p.brand_name, status: p.status, createdAt: p.created_at })));
  }));

  // ── Music ────────────────────────────────────────────────────────────────

  type MusicTask = {
    taskId: string; status: 'processing' | 'completed' | 'failed'; provider: string; credits: number;
    requestedSeconds: number; url?: string; durationSeconds?: number; error?: string; elapsedSeconds?: number;
  };
  // Poll the async music task, then (local server only) download the file.
  const finishMusic = async (taskId: string, timeoutSec: number, outputDir?: string, filename?: string) => {
    const deadline = Date.now() + timeoutSec * 1000;
    let t = (await client.get<MusicTask>(`/api/ai/music-status/${taskId}`)).data;
    while (t.status === 'processing' && Date.now() < deadline) {
      await sleep(5000);
      t = (await client.get<MusicTask>(`/api/ai/music-status/${taskId}`)).data;
    }
    if (t.status === 'processing') {
      return json({ ...t, next: `Still rendering (songs take 1–3 minutes). Call vivid_music_status with taskId "${taskId}" in a minute — credits are charged only when the track is ready.` });
    }
    let path: string | undefined;
    if (t.status === 'completed' && t.url && outputDir && io) {
      const { bytes } = await client.download(t.url);
      await io.mkdir(outputDir);
      const ext = t.url.endsWith('.wav') ? 'wav' : 'mp3';
      path = io.join(outputDir, filename ?? `music_${Date.now()}.${ext}`);
      await io.writeFile(path, bytes);
    }
    return json({ ...t, path });
  };

  server.registerTool('vivid_generate_music', {
    title: 'Generate music (MiniMax Music 3.0)',
    description: 'Generate a unique royalty-free track from a text brief (genre, mood, instruments, BPM, use). Providers: "minimax-music-3.0" (default, 14 credits, charged only when the track is ready) — full studio arrangements at 44.1 kHz/256 kbps, instrumental or with vocals (pass `lyrics`, [Verse]/[Chorus] tags allowed); it has NO exact length control: `durationSec` is a strong hint (30 s asked → ~2 min delivered), so trim in the editor. Rendering takes 1–3 minutes: the tool waits up to `waitSec`, then returns `status: "processing"` with a `taskId` — call vivid_music_status with it to get the track. Returns a public URL (7-day temp storage) usable as an editor audio clip or video soundtrack' + L('; set outputDir to also download it.', '.'),
    inputSchema: {
      prompt: z.string().min(3).max(1500).describe('Style brief in English: genre, mood, instruments, tempo, what it accompanies.'),
      durationSec: z.number().int().min(5).max(300).default(60),
      provider: z.enum(['minimax-music-3.0']).default('minimax-music-3.0'),
      instrumental: z.boolean().default(true).describe('false = with vocals (MiniMax only; give lyrics or let it write them).'),
      lyrics: z.string().max(3000).optional().describe('MiniMax with vocals: the lyrics, optionally with [Verse]/[Chorus]/[Bridge] tags.'),
      waitSec: z.number().int().min(0).max(240).default(io ? 240 : 40).describe('How long to wait for the track before returning a taskId to poll. Hosted connectors time out after about a minute, so keep it short there.'),
      ...localOnly({ outputDir: z.string().optional().describe('Download the file into this local directory.') }),
      filename: z.string().optional(),
    },
    // spends credits, adds a new asset
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const { data } = await client.post<{ taskId?: string; url?: string }>('/api/ai/generate-music', {
      prompt: a.prompt, duration: a.durationSec, provider: a.provider, instrumental: a.instrumental, lyrics: a.lyrics, format: 'mp3', async: true,
    });
    // An API older than async music ignores the flag and answers with the track.
    if (!data.taskId) return json({ status: 'completed', ...data });
    return finishMusic(data.taskId, a.waitSec, a.outputDir, a.filename);
  }));

  server.registerTool('vivid_music_status', {
    title: 'Music task status',
    description: 'Get the track of a vivid_generate_music call that returned status "processing". Waits up to `waitSec`; returns the public URL when ready (status "completed"), or "processing" again. Credits are charged once, when the track is ready; failed tracks are free.',
    inputSchema: {
      taskId: z.string().min(6),
      waitSec: z.number().int().min(0).max(240).default(io ? 240 : 40),
      ...localOnly({ outputDir: z.string().optional().describe('Download the file into this local directory.') }),
      filename: z.string().optional(),
    },
    // polls; on completion the server stores the file and charges the reserved price once
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async (a) => finishMusic(a.taskId, a.waitSec, a.outputDir, a.filename)));

  server.registerTool('vivid_list_music_providers', {
    title: 'List music providers',
    description: 'Music generation providers with credits, capabilities (exact duration, vocals, max length) and whether each is configured on the server.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    const { data } = await client.get<Record<string, unknown>>('/api/ai/music-providers');
    return json(data);
  }));

  // ── Transcription / subtitles ────────────────────────────────────────────

  server.registerTool('vivid_transcribe', {
    title: 'Transcribe audio/video (word timestamps, SRT/VTT)',
    description: 'Speech-to-text with Deepgram Nova-3 (free). Input: a VIVID asset id, a public URL' + L(', or a local audio/video file (uploaded for you).', '.') + ' Returns JSON with `words[]` (raw per-word startMs/endMs — use these for voice↔subtitle alignment), readable `cues[]` (3–8 words, timing stretched for legibility) and the full `transcript`; or a ready-to-use SRT / VTT file (format=srt|vtt, granularity=cue|word), optionally written to outputPath. Languages: it, en, es. Max 100 MB.',
    inputSchema: {
      source: z.string().min(1).describe(L('Asset id (32 hex chars), http(s) URL, or local file path of the audio/video.', 'Asset id (32 hex chars) or http(s) URL of the audio/video.')),
      language: z.enum(['it', 'en', 'es']).default('it'),
      format: z.enum(['json', 'srt', 'vtt']).default('json'),
      granularity: z.enum(['cue', 'word']).default('cue').describe('srt/vtt only: one block per readable cue, or one per word (karaoke / alignment checks).'),
      ...localOnly({ outputPath: z.string().optional().describe('srt/vtt only: write the subtitle file here.') }),
    },
    // free; may upload the file and write a local subtitle file
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async (a) => {
    const body: Record<string, unknown> = { locale: a.language, format: a.format, granularity: a.granularity };
    if (/^[a-f0-9]{32}$/i.test(a.source)) body.assetId = a.source;
    else if (/^https?:\/\//i.test(a.source)) body.url = a.source;
    else body.url = (await client.tempUpload(a.source)).url;

    if (a.format === 'json') {
      const { data } = await client.post<Record<string, unknown>>('/api/ai/transcribe', body);
      return json(data);
    }
    const text = await client.postText('/api/ai/transcribe', body);
    if (a.outputPath && io) {
      await io.writeFile(a.outputPath, text);
      return json({ path: a.outputPath, format: a.format, granularity: a.granularity, bytes: new TextEncoder().encode(text).byteLength });
    }
    return { content: [{ type: 'text', text }] };
  }));

  // ── Local retouch + product QC ───────────────────────────────────────────

  const ASSET_ID = /^[a-f0-9]{32}$/i;
  /** assetId | URL | local path → { assetId } or { url } (uploading local files / foreign URLs). */
  async function imageRef(source: string): Promise<{ assetId?: string; url?: string }> {
    if (ASSET_ID.test(source)) return { assetId: source };
    if (/^https?:\/\//i.test(source) && source.includes('/api/temp/')) return { url: source };
    return { url: (await client.tempUpload(source)).url };
  }

  server.registerTool('vivid_retouch', {
    title: 'Retouch one object in an image (masked edit)',
    description: 'Edit ONLY one object/area of an image and leave every other pixel untouched — e.g. "the ring on the left hand" → "make it a plain yellow gold band". Say WHERE with `target` (plain text: the tool locates it with a two-pass labelled-grid vision step, ~40–60 s), or `region` {x,y,w,h} as fractions of the frame, or a `mask` image (white = edit). A square crop around the target goes to the edit model at full resolution and the original bytes are composited back outside a feathered region, so the rest of the photo is byte-identical. Models: nano-banana (default, 6 credits, best fidelity), seedream (4), grok (3), z-image (2, true mask inpaint — needs region or mask). Returns the new asset id + download URL; chain with vivid_compare_product to verify against the SKU and feed its fixPrompt back here.',
    inputSchema: {
      source: z.string().min(1).describe(L('Asset id (32 hex), VIVID temp URL, other URL or local file path of the image to edit.', 'Asset id (32 hex), VIVID temp URL or other URL of the image to edit.')),
      prompt: z.string().min(3).max(1500).describe('What the target should become. Be concrete about material, colour, shape; the tool adds the "change nothing else" constraints.'),
      target: z.string().max(300).optional().describe('Plain-text description of the object/area to edit, e.g. "the ring on the ring finger".'),
      region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).optional().describe('Explicit bounding box, fractions of width/height (top-left origin). Skips the locate step.'),
      mask: z.string().optional().describe(L('Mask image (white = edit, black = keep), any size: local path, URL or asset id.', 'Mask image (white = edit, black = keep), any size: URL or asset id.')),
      model: z.enum(['nano-banana', 'seedream', 'grok', 'z-image']).default('nano-banana'),
      filename: z.string().optional(),
      ...localOnly({ outputDir: z.string().optional().describe('Also download the result into this local directory.') }),
      ...remoteOnly({ jobId: z.string().optional().describe('Resume waiting on a retouch that returned status "processing" (no new charge).') }),
    },
    // spends credits, adds a new asset (the original is untouched)
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    // Hosted connector: the locate + edit steps often outlast its ~1 min cut,
    // so run it on the queue and wait ~40 s; the local server stays sync.
    const finishAsync = async (jobId: string) => {
      const r = await pollUntilDone(async () => (await client.get<JobStatus>(`/api/ai/image-status/${jobId}`)).data, 40_000, 3000);
      const done = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled';
      return json({
        jobId, status: r.status, assetId: r.assetId, downloadUrl: await dl(r.downloadUrl ?? r.assetId), error: r.error,
        hint: done ? undefined : `Still retouching (already paid): call vivid_retouch again with the same source and jobId "${jobId}" to keep waiting, or vivid_job_status — do NOT retouch again.`,
      });
    };
    if (!io && a.jobId) return finishAsync(a.jobId);
    if (!a.target && !a.region && !a.mask) throw new VividApiError('one of target, region or mask is required', 400);
    const src = await imageRef(a.source);
    const body: Record<string, unknown> = { sourceAssetId: src.assetId, sourceUrl: src.url, prompt: a.prompt, target: a.target, region: a.region, model: a.model, filename: a.filename };
    if (a.mask) {
      const m = await imageRef(a.mask);
      body.maskUrl = m.url ?? `${client.apiUrl}/api/assets/${m.assetId}/download`;
    }
    if (!io) {
      const { data: started } = await client.post<{ jobId: string }>('/api/ai/retouch', { ...body, async: true });
      return finishAsync(started.jobId);
    }
    const { data } = await client.post<Record<string, unknown> & { assetId: string; downloadUrl: string }>('/api/ai/retouch', body);
    let path: string | undefined;
    if (a.outputDir && io) {
      const { bytes } = await client.download(data.downloadUrl);
      await io.mkdir(a.outputDir);
      path = io.join(a.outputDir, `${(a.filename ?? 'retouch').replace(/\.[a-z0-9]+$/i, '')}_${data.assetId.slice(0, 8)}.png`);
      await io.writeFile(path, bytes);
    }
    return json({ ...data, downloadUrl: await dl(data.downloadUrl ?? data.assetId), path });
  }));

  server.registerTool('vivid_compare_product', {
    title: 'Compare a render with the SKU reference (visual QC)',
    description: 'Visual quality control: checks that the product in a generated/retouched image matches the real product photo (SKU card). Vision LLM compares shape, proportions, materials/finish, colours, stones/elements, logos, hardware — product only, background ignored. Returns match 0–1, verdict pass|review|fail, a list of differences with severity, a summary and a `fixPrompt` you can pass straight to vivid_retouch. 1 credit, ~15–25 s.',
    inputSchema: {
      candidate: z.string().min(1).describe(L('Image to check: asset id, URL or local path.', 'Image to check: asset id or URL.')),
      reference: z.string().min(1).describe(L('SKU / real product photo: asset id, URL or local path.', 'SKU / real product photo: asset id or URL.')),
      skuDescription: z.string().max(2000).optional().describe('SKU notes: material, stone, colour, size… anything the reference photo does not show.'),
      focus: z.string().max(300).optional().describe('Which object to compare when the candidate shows several, e.g. "the ring on the hand".'),
      language: z.enum(['it', 'en', 'es']).default('it').describe('Language of the summary.'),
    },
    // Not readOnly: the check costs 1 credit, so it changes the account balance.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async (a) => {
    const [cand, ref] = await Promise.all([imageRef(a.candidate), imageRef(a.reference)]);
    const { data } = await client.post<Record<string, unknown>>('/api/ai/compare-product', {
      candidateAssetId: cand.assetId, candidateUrl: cand.url, referenceAssetId: ref.assetId, referenceUrl: ref.url,
      skuDescription: a.skuDescription, focus: a.focus, lang: a.language,
    });
    return json(data);
  }));

  // ── Product reference sheet ──────────────────────────────────────────────

  type SheetPanel = { assetId: string | null; thumbUrl?: string };
  type SheetState = {
    sheet: null | {
      id: string; jobId: string | null; status: 'processing' | 'ready' | 'failed'; category: string | null; attempts: number;
      creditsCharged: number; free: boolean; error: string | null; step: string | null; message: string | null;
      gridAssetId: string | null; panels: Record<'front' | 'view2' | 'view3' | 'worn', SheetPanel>;
      qc: Array<{ panel: string; match: number; verdict: string }> | null; createdAt: string; updatedAt: string;
    };
    offer: { credits: number; free: boolean };
  };
  // Signed links instead of the app's thumb URLs; the sheet stays as the API returns it otherwise.
  const sheetOut = async (s: SheetState, extra: Record<string, unknown> = {}) => {
    if (!s.sheet) return json({ sheet: null, offer: s.offer, ...extra });
    const { panels, ...rest } = s.sheet;
    const out: Record<string, unknown> = { ...rest };
    if (rest.status === 'ready') {
      const ids = [rest.gridAssetId, ...Object.values(panels).map((p) => p.assetId)].filter((id): id is string => !!id);
      const links = await client.downloadLinks(ids);
      out.gridDownloadUrl = rest.gridAssetId ? links.get(rest.gridAssetId) : undefined;
      out.panels = Object.fromEntries(Object.entries(panels).map(([k, p]) => [k, { assetId: p.assetId, downloadUrl: p.assetId ? links.get(p.assetId) : undefined }]));
    }
    return json({ sheet: out, offer: s.offer, ...extra });
  };

  server.registerTool('vivid_product_sheet', {
    title: 'Product reference sheet (4 views + QC)',
    description: 'The reference sheet of a saved product: Nano Banana 2.1 draws a 2×2 grid (front, two category-specific angles, worn/in use) from the product photos, then every panel is checked against the real photo with the same vision QC as vivid_compare_product; one failed check is regenerated for free, a second failure refunds everything. Without `create` it only returns the current sheet and what a new one would cost (free). With `create: true` it starts a sheet — 13 credits, or free for the first sheet of a free account — and waits up to `waitSec` (it takes 1–3 minutes); call again without `create` to poll. Angles the photos do not show are reconstructed: pass an extra photo of the side/back in `extraPhotos` for a faithful sheet. Returns the four panels and the grid with download links, the QC scores, or the failure message.',
    inputSchema: {
      product: z.string().min(1).describe('Saved product by name (as in vivid_list_references) or asset id.'),
      create: z.boolean().default(false).describe('Start a new sheet (spends credits unless free). false = just read the latest one.'),
      extraPhotos: z.array(z.string()).max(3).optional().describe('create only: more photos of the same product (side, back, detail) as saved products by name or image asset ids of the account.'),
      language: z.enum(['it', 'en', 'es']).default('it').describe('Language of the failure message.'),
      waitSec: z.number().int().min(0).max(240).default(io ? 200 : 40).describe('How long to wait for a running sheet. Hosted connectors time out after about a minute, so keep it short there.'),
      projectId: z.string().optional(),
    },
    // create: spends credits and adds assets; read-only otherwise
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const productId = ASSET_ID.test(a.product) ? a.product : (await resolveReferences(client, 'product', [a.product], a.projectId))[0]!;
    const path = `/api/products/${productId}/sheet`;
    let started: Record<string, unknown> | undefined;
    if (a.create) {
      const extras = a.extraPhotos?.length
        ? await Promise.all(a.extraPhotos.map(async (p) => (ASSET_ID.test(p) ? p : (await resolveReferences(client, 'product', [p], a.projectId))[0]!)))
        : undefined;
      try {
        const { data } = await client.post<{ sheetId: string; jobId: string; credits: number; free: boolean }>(path, { locale: a.language, extraAssetIds: extras });
        started = { started: { credits: data.credits, free: data.free } };
      } catch (err) {
        // One sheet at a time per product: wait for the running one instead of failing.
        if (!(err instanceof VividApiError && err.code === 'SHEET_IN_PROGRESS')) throw err;
        started = { started: false, note: 'A sheet for this product was already being made: waiting for that one (nothing charged).' };
      }
    }
    const deadline = Date.now() + a.waitSec * 1000;
    let s = (await client.get<SheetState>(path)).data;
    while (s.sheet?.status === 'processing' && Date.now() < deadline) {
      await sleep(5000);
      s = (await client.get<SheetState>(path)).data;
    }
    const next = s.sheet?.status === 'processing'
      ? { next: `Still working (step: ${s.sheet.step ?? 'reading'}). Call vivid_product_sheet with the same product and no create in a minute.` }
      : !s.sheet ? { next: `No sheet yet. create: true starts one (${s.offer.free ? 'free' : `${s.offer.credits} credits`}).` } : {};
    return sheetOut(s, { productAssetId: productId, ...started, ...next });
  }));

  // ── Video editor: projects + render queue ────────────────────────────────

  server.registerTool('vivid_list_editor_projects', {
    title: 'List video editor projects',
    description: 'List the saved video-editor projects (timelines) of the account. Use the id with vivid_render_project.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ limit }) => {
    const { data } = await client.get<Asset[]>('/api/assets', { type: 'script', limit });
    return json(data.map((a) => ({
      id: a.id, name: a.filename.replace(/\.json$/, ''), createdAt: a.created_at,
      editUrl: `${client.apiUrl.includes('vividoai') ? 'https://vividai.tv' : client.apiUrl}/tools/editor?project=${a.id}`,
    })));
  }));

  // ── Video editor: timeline editing (vivid-editor-core, headless) ────────

  const COMMANDS_DOC = `Commands are the same AiCommand objects the VIVID Art Director uses: [{ "type", "payload" }].
Timeline: ADD_CLIP {assetId, canvasObject?{x,y,w,h,rotation,opacity,blendMode}} (places the whole asset at the first free gap of a matching track; then trim it with UPDATE_CLIP) · UPDATE_CLIP {id, startMs?, durationMs?, sourceOffsetMs?, playbackRate?, volume?, opacity?} · REMOVE_CLIP {id} · SPLIT_CLIP {clipId, splitAtMs} · DUPLICATE_CLIP {id} · DETACH_AUDIO {clipId} · ADD_TRACK {type:'visual'|'audio'} · CUT_TO_BEAT {audioClipId (an AUDIO clip id in the timeline), beatInterval (1–32: beats or peaks between cuts; 4 = one cut per bar), grid?: 'beats' (constant BPM grid, default) | 'peaks' (detected hits/accents — right for cuts "sui picchi", drops, voice, music without a steady tempo), minStrength? (grid peaks: 0–1, keep only hits ≥ it), mode?: 'redistribute' (default: re-slice all visual clips in order to fill the music) | 'snap' (only nudge existing edges), syncClips?: 'all' | [clipIds]} — the audio is analysed on the server automatically (free); to plan cuts by hand call vivid_analyze_audio and use its beats/peaks (ms) as UPDATE_CLIP boundaries.
Look: SET_TRANSITION {clipId, edge:'in'|'out', type:'dissolve'|'fade-black' (visual) | 'crossfade'|'fade-in'|'fade-out' (audio), durationMs} · SET_CLIP_ANIMATION {clipId, phase:'in'|'out', type:'fade'|'slide-up'|'slide-down'|'zoom-in'|'zoom-out'|'zoom-pan'|'spin'|'blur-reveal', durationMs} · SET_CINEMATIC_LOOK {look} · SET_CANVAS_PRESET {id,label,width,height} (crop/reframe: landscape 1280x720, landscape-fhd 1920x1080, portrait 720x1280, portrait-fhd 1080x1920, square 1080x1080, social 864x1080) · UPDATE_CANVAS_OBJECT {id, x?, y?, w?, h?, rotation?, blendMode?}.
Text: ADD_TEXT {text, startMs, endMs, x (0-1), y (0-1), fontFamily?, fontSize?, color?, animation?, fill?} · UPDATE_TEXT {id, ...} · REMOVE_TEXT {id}. fill = animated gradient on the glyphs: {type:'gradient', colors:['#ff6ec4','#7873f5','#4ade80','#facc15'], angle: 100, animate:'shift'|'none', speed?: periods/s (0.35)} — presets: iridescent, sunset, ocean, gold, candy (same colors as the in-app Fill picker).
Subtitles (CapCut-style word-level captions): SET_SUBTITLES {cues:[{text, startMs, endMs, words?:[{word,startMs,endMs}]}] | null, templateId?:'outline-reveal'|'ugc-pop'|'karaoke-marker'|'cinematic-fade'|'neon-cyberpunk'|'playful-wiggle', position? (0 top – 100 bottom), styleOverrides?:{fontSize,color,highlightColor,…}, layout?:{x,y,scale,maxWidthPct,rotation}}. Get cues from vivid_transcribe (its cues[] carry per-word timing) on the voice/video asset; words are synthesized evenly when omitted.
Keyframes & effects (v2): SET_ANIMATIONS {objectId, objectType:'canvas'|'text', animations:{x|y|scale|rotation|opacity|blur|...: {keyframes:[{t (ms), v, easing?}]}}} · SET_OBJECT_ANIMATION · ADD_EFFECT {objectId, objectType, effect:{type:'blur'|'vignette'|'colorGrade'|'grain'|'glitch'|'chromaticAberration'|'pixelate', ...}, replace?} · REMOVE_EFFECT {objectId, objectType, effectType}
Motion & light effects (canvas objects only): {type:'motionBlur', intensity 0–1 (shutter = intensity × 2 frames; blurs the clip's OWN movement — keyframes, intro/outro, shake, beat pump — not motion inside the footage, so pair it with SET_ANIMATIONS or SET_CLIP_ANIMATION), samples? 2–32} · {type:'cameraShake', intensity 0–1 (1 = ±3% of the short side, ±2°), speed? Hz 0.5–20 (6), seed?} · {type:'flash', intensity 0–1, color? '#rrggbb' (white), everyBeats? 1–16, bpm? (used only when the project has no analysed music), decayMs? 30–2000 (150)} · {type:'zoomBlur', amount 0–1, centerX? centerY? 0–1} · {type:'lightLeak', intensity 0–1, speed? 0.1–4, hue? 0–360 (25 = warm)}.
Effect recipes (one style across the edit, preferred over hand-written effects/keyframes): APPLY_EFFECT_RECIPE {recipe:'beat-flash' (flash pinned to the music's real beats — needs an analysed audio clip, like CUT_TO_BEAT) | 'punch-in' (scale pop + motion blur on every cut) | 'whip' (fast slide-in from alternating sides + motion blur on every cut) | 'handheld' (subtle shake) | 'light-leak' | 'clear' (removes what recipes added), intensity? 0–1 (0.6), clipIds? (default all visual clips), everyBeats? (beat-flash), color? (beat-flash), audioClipId? (beat-flash)} — its keyframes sit on the timeline, so send it AFTER CUT_TO_BEAT or anything that moves clips. · SET_MASK {objectId, mask:{type:'rect'|'circle'|'reveal'|'clipPath'|'none', ...}} · ADD_AUDIO_REACTIVE.
Speed: UPDATE_CLIP.playbackRate is constant per clip; SET_SPEED_RAMP {clipId, preset:'speed-up'|'slow-down'|'slow-mo-hit'|'punch-in'|'ease-in-out'|'none'} or {clipId, keyframes:[{t (ms from clip start on the timeline), v (rate 0.1–8)}]} gives a variable speed (linear between keyframes; the clip keeps its timeline duration unless the source runs out, then it is shortened). Ids: read them from vivid_get_editor_project or from "created" in the previous result; a batch is applied one command at a time, so a later command can use a clip created earlier in the same batch.`;

  const mediaSchema = z.object({
    source: z.string().min(1).describe(L('VIVID asset id (32 hex), URL or local file path (uploaded as editor media).', 'VIVID asset id (32 hex) or URL (uploaded as editor media).')),
    name: z.string().optional(),
    durationMs: z.number().int().positive().optional().describe('Supply when the API does not know it (uploaded videos); otherwise it is read from the asset/job or probed.'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    localId: z.string().optional().describe('Id to use inside the project (defaults to the asset id). Reference it in ADD_CLIP.assetId.'),
  });
  const commandsSchema = z.array(z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) }).passthrough());
  const needsBeatAnalysis = (commands: Array<{ type: string }> | undefined) => !!commands?.some((c) => c.type === 'CUT_TO_BEAT');

  server.registerTool('vivid_analyze_audio', {
    title: 'Analyze audio: tempo (BPM) and peaks',
    description: 'Tempo and transient analysis of a music / voice file, computed on the VIVID server (free, cached per asset). Returns bpm, firstBeatMs, the beat grid (beats[] / downbeats[] in ms from the start of the file, constant tempo) and peaks[] — the detected hits/accents/drops ({ms, strength 0–1}). Use beats for metronomic cuts and peaks for cuts on what the ear hears (dynamic montage, "tagli sui picchi"): pass them as clip boundaries (UPDATE_CLIP startMs/durationMs) or let CUT_TO_BEAT do it (grid beats|peaks). Input: VIVID asset id' + L(', public URL or local file (uploaded for you)', ' or public URL') + '. MP3 or WAV only — convert other formats first (ffmpeg -c:a libmp3lame). First 90 s analysed by default.',
    inputSchema: {
      source: z.string().min(1).describe(L('Asset id (32 hex chars), http(s) URL, or local MP3/WAV path.', 'Asset id (32 hex chars) or http(s) URL of an MP3/WAV.')),
      mode: z.enum(['bpm', 'peaks', 'both']).default('both'),
      bpmHint: z.number().min(40).max(240).optional().describe('Known tempo; fixes half/double-tempo detections. A "128 BPM" in the file name is picked up automatically.'),
      minGapMs: z.number().int().min(50).max(5000).optional().describe('Minimum distance between two peaks (default 250 ms). Raise it (600–1500) for fewer, bigger accents.'),
      sensitivity: z.number().min(0).max(1).optional().describe('0 = only the strongest hits … 1 = every small transient (default 0.5).'),
      maxSeconds: z.number().int().min(5).max(180).optional().describe('Seconds analysed from the start (default 90).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const body: Record<string, unknown> = { mode: a.mode, bpmHint: a.bpmHint, minGapMs: a.minGapMs, sensitivity: a.sensitivity, maxSeconds: a.maxSeconds };
    if (/^[a-f0-9]{32}$/i.test(a.source)) body.assetId = a.source;
    else if (/^https?:\/\//i.test(a.source)) body.url = a.source;
    else { body.url = (await client.tempUpload(a.source)).url; body.name = a.source.split(/[\\/]/).pop(); }
    const { data } = await client.post<Record<string, unknown>>('/api/ai/audio-analysis', body);
    const peaks = data.peaks as Array<{ ms: number; strength: number }> | undefined;
    return json({ ...data, strongPeaks: peaks?.filter((p) => p.strength >= 0.6).map((p) => p.ms),
      hint: 'beats/peaks are ms from the start of the FILE; on the timeline add the audio clip startMs and subtract its sourceOffsetMs.' });
  }));

  async function addMedia(editor: { store: { getState: () => { addAsset: (a: import('vivid-editor-core').AssetClip) => void; assetLibrary: Array<{ id: string }> } } }, media: MediaImport[] | undefined) {
    const added: Array<{ id: string; name: string; mediaType: string; durationMs: number }> = [];
    for (const m of media ?? []) {
      const clip = await importMedia(client, m);
      if (editor.store.getState().assetLibrary.some((a) => a.id === clip.id)) continue;
      editor.store.getState().addAsset(clip);
      added.push({ id: clip.id, name: clip.name, mediaType: clip.mediaType, durationMs: clip.durationMs });
    }
    return added;
  }

  server.registerTool('vivid_get_editor_project', {
    title: 'Read a video editor project (timeline)',
    description: 'Load a saved editor project and return its timeline: canvas preset, tracks, media library (assets with local ids), clips (id, track, start/duration/source offset, speed, transitions, animations), canvas objects (position/size/rotation, effects, masks) and text overlays. Use the ids in vivid_edit_timeline. Pass raw=true to get the full project JSON instead.',
    inputSchema: {
      projectAssetId: z.string().min(1).describe('Id from vivid_list_editor_projects.'),
      raw: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async (a) => {
    const { raw, editor } = await loadProject(client, a.projectAssetId);
    if (a.raw) return json(raw);
    return json(summarize(editor.store.getState(), { projectAssetId: a.projectAssetId, editUrl: editUrlFor(client, a.projectAssetId), missingAssets: editor.missingAssets, subtitles: subtitlesOf(editor) }));
  }));

  server.registerTool('vivid_create_editor_project', {
    title: 'Create a video editor project',
    description: `Create a new editor project (timeline) on the account: pick a canvas preset, import media (VIVID assets, URLs${io ? ' or local files' : ''}), optionally apply an initial batch of commands, and save. Returns the project id (use it with vivid_edit_timeline / vivid_render_project) and the timeline summary. Media added here is available to ADD_CLIP by its local id (= asset id unless localId is given).\n${COMMANDS_DOC}`,
    inputSchema: {
      name: z.string().min(1).max(120),
      canvasPreset: z.enum(['landscape', 'landscape-fhd', 'portrait', 'portrait-fhd', 'square', 'social']).default('portrait-fhd'),
      media: z.array(mediaSchema).optional().describe('Media to import into the project library.'),
      commands: commandsSchema.optional().describe('Initial commands, e.g. ADD_CLIP for each media item.'),
    },
    // creates a new project
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const file = newProject(a.name, a.canvasPreset);
    const editor = openHeadlessProject(file, { resolveUrl: resolveAssetUrl(client) });
    const imported = await addMedia(editor, a.media);
    const audioAnalysis = needsBeatAnalysis(a.commands) ? await ensureBeatAnalysis(client, editor) : undefined;
    const result = a.commands?.length ? editor.apply(a.commands as unknown as AiCommand[]) : { applied: 0, errors: [], created: undefined };
    const out = editor.toProjectFile();
    const check = projectSchemaV2.safeParse(out);
    if (!check.success) throw new VividApiError(`Project failed validation before save: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 500);
    const { assetId } = await saveProject(client, out, a.name);
    return json({ projectAssetId: assetId, editUrl: editUrlFor(client, assetId), imported, audioAnalysis, applied: result.applied, errors: result.errors, created: result.created, timeline: summarize(editor.store.getState(), { subtitles: subtitlesOf(editor) }) });
  }));

  server.registerTool('vivid_edit_timeline', {
    title: 'Edit a video editor project (timeline commands)',
    description: `Apply editing commands to a saved editor project — clips, trims, speed and speed ramps, transitions, canvas preset (16:9 ↔ 9:16), texts (incl. animated gradient fills), word-level subtitles, masks, keyframes, audio — through the same orchestrator as the in-app Art Director, then save it back under the same id. Optionally import media first. Returns applied/errors, the ids created, and the updated timeline. Render the result with vivid_render_project.\n${COMMANDS_DOC}`,
    inputSchema: {
      projectAssetId: z.string().min(1),
      commands: commandsSchema.min(1),
      media: z.array(mediaSchema).optional().describe('Media to import into the library before applying the commands.'),
      dryRun: z.boolean().default(false).describe('Apply and report, but do not save.'),
    },
    // edits the project in place — commands can remove clips
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const { editor } = await loadProject(client, a.projectAssetId);
    const imported = await addMedia(editor, a.media);
    const audioAnalysis = needsBeatAnalysis(a.commands) ? await ensureBeatAnalysis(client, editor) : undefined;
    const result = editor.apply(a.commands as unknown as AiCommand[]);
    const out = editor.toProjectFile();
    const check = projectSchemaV2.safeParse(out);
    if (!check.success) throw new VividApiError(`Project failed validation after edit (not saved): ${check.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 500);
    let saved = false;
    if (!a.dryRun && (result.applied > 0 || imported.length > 0)) {
      await saveProject(client, out, out.projectName || 'Editor Project', a.projectAssetId);
      saved = true;
    }
    return json({ projectAssetId: a.projectAssetId, editUrl: editUrlFor(client, a.projectAssetId), saved, imported, audioAnalysis, applied: result.applied, errors: result.errors, created: result.created, timeline: summarize(editor.store.getState(), { missingAssets: editor.missingAssets, subtitles: subtitlesOf(editor) }) });
  }));

  server.registerTool('vivid_render_project', {
    title: 'Render editor project',
    description: 'Queue a render (MP4 export) of a saved video-editor project. VIVID renders in the browser: the job returns an `openUrl` — open it (or pass openBrowser=true to open it automatically on this machine) and the editor renders, uploads the MP4 to the gallery and marks the job done. Poll with vivid_render_status. Requires being logged in on vividai.tv in that browser.',
    inputSchema: {
      projectAssetId: z.string().describe('Editor project id from vivid_list_editor_projects.'),
      name: z.string().optional().describe('File name for the rendered video (without extension).'),
      openBrowser: z.boolean().default(false).describe('Open the render URL in the default browser of this machine.'),
      wait: z.boolean().default(false).describe('Wait for completion (polls up to timeoutSec).'),
      timeoutSec: z.number().int().min(30).max(1800).default(600),
    },
    // queues a render, adds a new asset
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const { data: job } = await client.post<RenderJob>('/api/render-jobs', { projectAssetId: a.projectAssetId, name: a.name });
    const opened = a.openBrowser && io ? io.openInBrowser(job.openUrl) : false;
    if (!a.wait) {
      return json({ renderJobId: job.id, status: job.status, openUrl: job.openUrl, opened, hint: opened
        ? 'The editor is rendering in your browser — poll vivid_render_status.'
        : 'Open openUrl in a browser logged into vividai.tv to run the render, then poll vivid_render_status.' });
    }
    const deadline = Date.now() + a.timeoutSec * 1000;
    let last = job;
    while (Date.now() < deadline) {
      await sleep(5000);
      last = (await client.get<RenderJob>(`/api/render-jobs/${job.id}`)).data;
      if (last.status === 'completed' || last.status === 'failed' || last.status === 'cancelled') break;
    }
    return json({ renderJobId: last.id, status: last.status, progress: last.progress, outputAssetId: last.outputAssetId,
      downloadUrl: await dl(last.downloadUrl ?? last.outputAssetId ?? undefined), error: last.error, openUrl: last.openUrl, opened });
  }));

  server.registerTool('vivid_render_status', {
    title: 'Render job status',
    description: 'Status of a render job created with vivid_render_project: queued, rendering (with progress), completed (with the output asset and download URL) or failed.',
    inputSchema: { renderJobId: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ renderJobId }) => {
    const { data: j } = await client.get<RenderJob>(`/api/render-jobs/${renderJobId}`);
    return json({ renderJobId: j.id, status: j.status, progress: j.progress, executor: j.executor, projectAssetId: j.projectAssetId,
      outputAssetId: j.outputAssetId, downloadUrl: await dl(j.downloadUrl ?? j.outputAssetId ?? undefined), error: j.error, openUrl: j.openUrl, createdAt: j.createdAt });
  }));
}
