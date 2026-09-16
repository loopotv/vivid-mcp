/**
 * UI recorder — drives a local Chromium through Playwright, records the
 * session to video and uploads it to VIVID as a permanent video asset that
 * the editor tools can put on a timeline.
 *
 * Playwright is an optional dependency (`playwright-core`): it is imported
 * lazily so `npx -y vivid-mcp` stays light for everyone who never records.
 * The browser is the locally installed Chrome when available, otherwise the
 * Chromium that `npx playwright install chromium` downloads.
 *
 * Login: the API key is exchanged for a browser session through
 * POST /api/me/session and seeded into localStorage before the first
 * navigation, so vividai.tv opens already authenticated.
 */

import { mkdtemp, readFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { VividClient, VividApiError } from './client.js';

type PW = typeof import('playwright-core');
type Page = import('playwright-core').Page;
type Browser = import('playwright-core').Browser;

export type StepAction = 'goto' | 'click' | 'hover' | 'move' | 'type' | 'fill' | 'press' | 'scroll' | 'wait' | 'hide' | 'evaluate';

export interface RecordStep {
  action: StepAction;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaY?: number;
  ms?: number;
  delayMs?: number;
  script?: string;
  waitMs?: number;
  /** Skip the step (with a warning) instead of failing when its element does not appear within `ms` (default 3000). */
  optional?: boolean;
}

export interface RecordOptions {
  steps: RecordStep[];
  url?: string;
  site?: string;
  login?: boolean;
  viewport?: { width: number; height: number };
  scale?: number;
  cursor?: boolean;
  hideSelectors?: string[];
  /** Extra localStorage entries seeded on the site origin before the first navigation. */
  localStorage?: Record<string, string>;
  leadInMs?: number;
  tailMs?: number;
  format?: 'auto' | 'mp4' | 'webm';
  upload?: boolean;
  outputPath?: string;
  name?: string;
  headless?: boolean;
  stepTimeoutMs?: number;
  colorScheme?: 'dark' | 'light';
  locale?: string;
}

export interface RecordResult {
  assetId?: string;
  url?: string;
  localPath?: string;
  format: 'mp4' | 'webm';
  durationMs: number;
  width: number;
  height: number;
  stepsRun: number;
  browser: string;
  warnings: string[];
}

interface SessionData { token: string; refreshToken: string; storageKey: string; user: Record<string, unknown> }

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function siteFor(client: VividClient): string {
  return client.apiUrl.includes('vividoai') ? 'https://vividai.tv' : client.apiUrl;
}

async function loadPlaywright(): Promise<PW> {
  try {
    return await import('playwright-core');
  } catch {
    try {
      const name = 'playwright';
      return (await import(name)) as PW;
    } catch {
      throw new VividApiError(
        'Playwright is not installed. Run `npm i -g playwright-core` (uses your installed Google Chrome) or `npx playwright install chromium`, then retry.',
        500,
      );
    }
  }
}

async function launchBrowser(pw: PW, headless: boolean): Promise<{ browser: Browser; name: string }> {
  const errors: string[] = [];
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      const browser = await pw.chromium.launch({ headless, channel });
      return { browser, name: channel };
    } catch (err) { errors.push(`${channel}: ${(err as Error).message.split('\n')[0]}`); }
  }
  try {
    const browser = await pw.chromium.launch({ headless });
    return { browser, name: 'chromium' };
  } catch (err) {
    errors.push(`chromium: ${(err as Error).message.split('\n')[0]}`);
    throw new VividApiError(
      `No browser available for recording. Install Google Chrome, or run \`npx playwright install chromium\`. Details: ${errors.join(' | ')}`,
      500,
    );
  }
}

/** Fake cursor drawn in-page: Playwright's mouse fires real mousemove/mousedown events, the overlay follows them. */
const CURSOR_SCRIPT = `(() => {
  if (window.top !== window) return;
  const ID = '__vivid_cursor';
  const ARROW = '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M5.5 3.2 18.4 13.4l-5.6.6 3.2 6.2-2.4 1.2-3.2-6.2-4.1 3.9z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  function ensure() {
    let el = document.getElementById(ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ID;
    el.style.cssText = 'position:fixed;left:-100px;top:-100px;width:24px;height:24px;pointer-events:none;z-index:2147483647;';
    el.innerHTML = ARROW;
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function ripple(x, y) {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;width:28px;height:28px;border-radius:50%;background:rgba(255,120,60,.45);border:2px solid rgba(255,120,60,.9);pointer-events:none;z-index:2147483646;transform:scale(.4);opacity:1;transition:transform .35s ease-out,opacity .35s ease-out;';
    (document.body || document.documentElement).appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.3)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 400);
  }
  document.addEventListener('mousemove', (e) => { const el = ensure(); el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', (e) => ripple(e.clientX, e.clientY), true);
  document.addEventListener('DOMContentLoaded', ensure);
})();`;

function hideScript(selectors: string[]): string {
  const css = selectors.map((s) => `${s}{display:none!important}`).join('');
  return `(() => { if (window.top !== window) return; const add = () => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(st); }; if (document.head) add(); else document.addEventListener('DOMContentLoaded', add); })();`;
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null));
  });
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Convert the raw webm to an H.264 MP4 with ffmpeg (yuv420p, faststart). Returns null if ffmpeg is missing or fails. */
async function toMp4(webmPath: string, trimStartMs: number): Promise<{ path: string } | { error: string }> {
  const ffmpeg = await which('ffmpeg');
  if (!ffmpeg) return { error: 'ffmpeg not found on PATH' };
  const out = webmPath.replace(/\.webm$/i, '') + '.mp4';
  const trim = trimStartMs > 50 ? ['-ss', (trimStartMs / 1000).toFixed(3)] : [];
  const { code, stderr } = await run(ffmpeg, ['-y', '-loglevel', 'error', ...trim, '-i', webmPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out]);
  return code === 0 ? { path: out } : { error: `ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}` };
}

/** Duration and size via ffprobe when available. */
async function probe(path: string): Promise<{ durationMs?: number; width?: number; height?: number }> {
  const ffprobe = await which('ffprobe');
  if (!ffprobe) return {};
  return new Promise((resolve) => {
    const child = spawn(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve({}));
    child.on('close', () => {
      try {
        const j = JSON.parse(out) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
        const d = Number(j.format?.duration);
        resolve({ durationMs: Number.isFinite(d) ? Math.round(d * 1000) : undefined, width: j.streams?.[0]?.width, height: j.streams?.[0]?.height });
      } catch { resolve({}); }
    });
  });
}

export async function recordUi(client: VividClient, opts: RecordOptions): Promise<RecordResult> {
  const warnings: string[] = [];
  const site = (opts.site ?? siteFor(client)).replace(/\/+$/, '');
  // Playwright's screencast captures CSS pixels, so deviceScaleFactor does not
  // sharpen the video. For a crisp 2× recording we open a viewport twice as
  // large and zoom the document 2× (CSS `zoom`): layout is identical to the
  // requested viewport, the pixels are doubled.
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const scale = opts.scale ?? 2;
  const pixelViewport = { width: viewport.width * scale, height: viewport.height * scale };
  const startUrl = opts.url ? (/^https?:\/\//i.test(opts.url) ? opts.url : `${site}${opts.url.startsWith('/') ? '' : '/'}${opts.url}`) : `${site}/dashboard`;
  const stepTimeout = opts.stepTimeoutMs ?? 15_000;

  const pw = await loadPlaywright();

  // Session first: if the key is wrong we fail before opening a browser.
  let session: SessionData | null = null;
  if (opts.login !== false) {
    const { data } = await client.post<SessionData>('/api/me/session');
    session = data;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'vivid-record-'));
  const { browser, name: browserName } = await launchBrowser(pw, opts.headless ?? true);
  let page: Page | null = null;
  let stepsRun = 0;
  const startedAt = Date.now();
  let loadedAt = startedAt;
  let endedAt = startedAt;
  let webmPath: string;
  try {
    const context = await browser.newContext({
      viewport: pixelViewport,
      deviceScaleFactor: 1,
      recordVideo: { dir: workDir, size: pixelViewport },
      colorScheme: opts.colorScheme ?? 'dark',
      locale: opts.locale ?? 'it-IT',
      ignoreHTTPSErrors: true,
    });
    // Seed localStorage on the site origin: the auth session (zustand persist
    // shape) plus the cookie-notice flag so the banner never enters the frame.
    const seed: Record<string, string> = { vivid_cookie_notice_v2: '1', ...(opts.localStorage ?? {}) };
    if (session) {
      seed[session.storageKey ?? 'vivid-auth'] = JSON.stringify({ state: { token: session.token, refreshToken: session.refreshToken, user: session.user }, version: 0 });
    }
    await context.addInitScript(({ origin: o, entries }) => {
      try {
        if (location.origin !== o) return;
        for (const [k, v] of entries) if (!localStorage.getItem(k)) localStorage.setItem(k, v);
      } catch { /* storage blocked */ }
    }, { origin: new URL(site).origin, entries: Object.entries(seed) });
    if (scale !== 1) {
      await context.addInitScript((z: number) => {
        if (window.top !== window) return;
        const apply = () => { document.documentElement.style.zoom = String(z); };
        apply(); document.addEventListener('DOMContentLoaded', apply);
      }, scale);
    }
    if (opts.cursor !== false) await context.addInitScript(CURSOR_SCRIPT);
    if (opts.hideSelectors?.length) await context.addInitScript(hideScript(opts.hideSelectors));

    page = await context.newPage();
    page.setDefaultTimeout(stepTimeout);
    const video = page.video();
    if (!video) throw new VividApiError('Browser did not start video recording', 500);

    const mouse = { x: Math.round(pixelViewport.width * 0.6), y: Math.round(pixelViewport.height * 0.6) };
    const moveTo = async (x: number, y: number) => {
      const dist = Math.hypot(x - mouse.x, y - mouse.y);
      const steps = Math.max(8, Math.min(40, Math.round(dist / 18)));
      await page!.mouse.move(x, y, { steps });
      mouse.x = x; mouse.y = y;
    };
    const centerOf = async (selector: string, timeout?: number) => {
      const loc = page!.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.scrollIntoViewIfNeeded();
      await sleep(150);
      const box = await loc.boundingBox();
      if (!box) throw new Error(`element "${selector}" has no layout box`);
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    };

    await page.goto(startUrl, { waitUntil: 'networkidle' }).catch(async () => {
      warnings.push(`networkidle not reached on ${startUrl}, continued after load`);
      await page!.waitForLoadState('load');
    });
    loadedAt = Date.now();
    await page.mouse.move(mouse.x, mouse.y);
    await sleep(opts.leadInMs ?? 800);

    for (let i = 0; i < opts.steps.length; i++) {
      const s = opts.steps[i];
      const label = `step ${i + 1} (${s.action}${s.selector ? ` ${s.selector}` : ''})`;
      if (s.optional && s.selector) {
        const visible = await page.locator(s.selector).first().waitFor({ state: 'visible', timeout: s.ms ?? 3000 }).then(() => true, () => false);
        if (!visible) { warnings.push(`${label} skipped: element not visible`); continue; }
      }
      try {
        switch (s.action) {
          case 'goto': {
            if (!s.url) throw new Error('url is required');
            const target = /^https?:\/\//i.test(s.url) ? s.url : `${site}${s.url.startsWith('/') ? '' : '/'}${s.url}`;
            await page.goto(target, { waitUntil: 'networkidle' }).catch(() => page!.waitForLoadState('load'));
            break;
          }
          case 'move': {
            const p = s.selector ? await centerOf(s.selector) : { x: s.x != null ? s.x * scale : mouse.x, y: s.y != null ? s.y * scale : mouse.y };
            await moveTo(p.x, p.y);
            break;
          }
          case 'hover': {
            if (!s.selector) throw new Error('selector is required');
            const p = await centerOf(s.selector);
            await moveTo(p.x, p.y);
            break;
          }
          case 'click': {
            const p = s.selector ? await centerOf(s.selector) : { x: s.x != null ? s.x * scale : mouse.x, y: s.y != null ? s.y * scale : mouse.y };
            await moveTo(p.x, p.y);
            await sleep(180);
            await page.mouse.down(); await sleep(90); await page.mouse.up();
            break;
          }
          case 'type': {
            if (!s.selector) throw new Error('selector is required');
            const p = await centerOf(s.selector);
            await moveTo(p.x, p.y);
            await page.mouse.click(p.x, p.y);
            await sleep(150);
            await page.keyboard.type(s.text ?? '', { delay: s.delayMs ?? 45 });
            break;
          }
          case 'fill': {
            if (!s.selector) throw new Error('selector is required');
            const p = await centerOf(s.selector);
            await moveTo(p.x, p.y);
            await page.locator(s.selector).first().fill(s.text ?? '');
            break;
          }
          case 'press': {
            if (!s.key) throw new Error('key is required');
            await page.keyboard.press(s.key);
            break;
          }
          case 'scroll': {
            if (s.selector) {
              const p = await centerOf(s.selector);
              await moveTo(p.x, p.y);
            } else {
              const total = (s.deltaY ?? 500) * scale;
              const chunks = Math.max(1, Math.round(Math.abs(total) / 60));
              for (let k = 0; k < chunks; k++) { await page.mouse.wheel(0, total / chunks); await sleep(16); }
            }
            break;
          }
          case 'wait': {
            if (s.selector) await page.locator(s.selector).first().waitFor({ state: 'visible', timeout: s.ms ?? stepTimeout });
            else await sleep(s.ms ?? 1000);
            break;
          }
          case 'hide': {
            if (!s.selector) throw new Error('selector is required');
            await page.addStyleTag({ content: `${s.selector}{display:none!important}` });
            break;
          }
          case 'evaluate': {
            if (!s.script) throw new Error('script is required');
            await page.evaluate(s.script);
            break;
          }
          default:
            throw new Error(`unknown action "${String((s as RecordStep).action)}"`);
        }
        stepsRun++;
        await sleep(s.waitMs ?? (s.action === 'wait' ? 0 : 600));
      } catch (err) {
        throw new VividApiError(`${label} failed: ${(err as Error).message.split('\n')[0]}`, 400);
      }
    }

    await sleep(opts.tailMs ?? 1200);
    endedAt = Date.now();
    await context.close(); // flushes the video file
    webmPath = await video.path();
  } finally {
    await browser.close().catch(() => {});
  }

  // Container: mp4 when ffmpeg is around (plays everywhere), otherwise the raw webm.
  let finalPath = webmPath;
  let format: 'mp4' | 'webm' = 'webm';
  const wantMp4 = opts.format === 'mp4' || (opts.format ?? 'auto') === 'auto';
  if (wantMp4) {
    const conv = await toMp4(webmPath, loadedAt - startedAt);
    if ('path' in conv) { finalPath = conv.path; format = 'mp4'; }
    else if (opts.format === 'mp4') throw new VividApiError(`MP4 conversion failed: ${conv.error}`, 500);
    else warnings.push(`kept webm (${conv.error}); the editor renders webm fine, install ffmpeg for mp4`);
  }

  const probed = await probe(finalPath);
  const result: RecordResult = {
    format,
    durationMs: endedAt - (format === 'mp4' ? loadedAt : startedAt),
    width: pixelViewport.width,
    height: pixelViewport.height,
    stepsRun,
    browser: browserName,
    warnings,
  };
  if (probed.durationMs) result.durationMs = probed.durationMs;
  if (probed.width && probed.height) { result.width = probed.width; result.height = probed.height; }
  if (format === 'webm') warnings.push(`the first ${((loadedAt - startedAt) / 1000).toFixed(1)}s (page load) are blank; trim them on the timeline (sourceOffsetMs)`);

  if (opts.outputPath) {
    await mkdir(dirname(opts.outputPath), { recursive: true });
    await copyFile(finalPath, opts.outputPath);
    result.localPath = opts.outputPath;
  }

  if (opts.upload !== false) {
    const bytes = new Uint8Array(await readFile(finalPath));
    const filename = `${(opts.name ?? 'ui-recording').replace(/[^\w.-]+/g, '_')}.${format}`;
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as ArrayBufferView<ArrayBuffer>], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' }), filename);
    const { data } = await client.post<{ assetId: string }>('/api/ai/save-editor-media', form);
    result.assetId = data.assetId;
    result.url = client.url(`/api/assets/${data.assetId}/download`);
  }

  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return result;
}
