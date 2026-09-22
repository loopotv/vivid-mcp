import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { VividClient, VividApiError } from './client.js';
import type { LocalIo } from './tools.js';
import { recordUi, siteFor, type RecordStep } from './recorder.js';

/**
 * Everything that needs the user's machine: Node file system, the default
 * browser, a local Chromium for vivid_record_ui. Only the stdio server
 * (index.ts) imports this module; the remote Worker (worker.ts) never does,
 * so nothing here may leak into tools.ts.
 */

export const nodeIo: LocalIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  writeFile: (path, data) => writeFile(path, data),
  join: (...parts) => join(...parts),
  openInBrowser(url) {
    try {
      const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch { return false; }
  },
};

export const readLocalFile = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

const json = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try { return await fn(args); }
    catch (e) {
      if (e instanceof VividApiError) return fail(`VIVID API error ${e.status}${e.code ? ` (${e.code})` : ''}: ${e.message}`);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

export function registerLocalTools(server: McpServer, client: VividClient): void {
  // ── UI recording (Playwright, local) ─────────────────────────────────────

  const recordStepSchema = z.object({
    action: z.enum(['goto', 'click', 'hover', 'move', 'type', 'fill', 'press', 'scroll', 'wait', 'hide', 'evaluate'])
      .describe('goto(url) · click/hover/move(selector or x,y) · type(selector, text, delayMs — keystroke by keystroke) · fill(selector, text — instant) · press(key, e.g. "Enter") · scroll(deltaY in px, or selector to scroll into view) · wait(ms, or selector until visible) · hide(selector) · evaluate(script).'),
    url: z.string().optional().describe('goto: absolute URL or a path on the site (e.g. "/create").'),
    selector: z.string().optional().describe('Playwright selector: CSS, "text=Genera", "[data-testid=onboarding-skip]", "role=button[name=\'Crea\']".'),
    text: z.string().optional(),
    key: z.string().optional(),
    x: z.number().optional().describe('CSS px inside the viewport (click/move without selector).'),
    y: z.number().optional(),
    deltaY: z.number().optional().describe('scroll: pixels, negative scrolls up (default 500).'),
    ms: z.number().int().min(0).max(60_000).optional().describe('wait: pause in ms (default 1000) or timeout for the selector.'),
    delayMs: z.number().int().min(0).max(1000).optional().describe('type: delay between keystrokes (default 45).'),
    script: z.string().optional().describe('evaluate: JavaScript run in the page.'),
    waitMs: z.number().int().min(0).max(60_000).optional().describe('Pause after the action (default 600).'),
    optional: z.boolean().optional().describe('Skip this step (warning) instead of failing when its selector is not visible within ms (default 3000) — e.g. a one-time onboarding dialog.'),
  });

  server.registerTool('vivid_record_ui', {
    title: 'Record a UI walkthrough (screen recording)',
    description: `Record a screen-capture video of vividai.tv (or any site) by driving a local Chromium with Playwright: a scripted list of steps (navigate, move, click, type, scroll, wait) is executed with a visible cursor, smooth mouse moves and click ripples, and the result is uploaded to VIVID as a video asset ready for vivid_create_editor_project / vivid_edit_timeline (pass the returned durationMs as media[].durationMs). The browser is logged into the account of VIVID_API_KEY automatically (login=true), so app pages open directly. Runs on THIS machine: needs Google Chrome (or \`npx playwright install chromium\`) and, for mp4 output, ffmpeg (otherwise webm, which the editor handles). Default site: ${siteFor(client)}. Tips: onboarding on /create can be skipped with click "[data-testid=onboarding-skip]"; keep clips short (one feature per recording) and slow the pace with waitMs. Costs no credits.`,
    inputSchema: {
      steps: z.array(recordStepSchema).min(1).max(80),
      url: z.string().optional().describe('Start URL or site path (default "/dashboard").'),
      site: z.string().optional().describe('Site origin to record and log into (default vividai.tv; use https://stage.vividai.tv for staging).'),
      login: z.boolean().default(true).describe('Seed the browser with a session of the API-key account before opening the site.'),
      viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).optional().describe('CSS viewport (default 1440×900). Use 390×844 for a phone.'),
      scale: z.number().int().min(1).max(3).default(2).describe('Device scale factor: 2 records 1440×900 as a crisp 2880×1800.'),
      cursor: z.boolean().default(true).describe('Draw a cursor with click ripples.'),
      hideSelectors: z.array(z.string()).optional().describe('CSS selectors hidden for the whole recording (banners, chat widgets).'),
      leadInMs: z.number().int().min(0).max(10_000).default(800).describe('Still time after the first page loads.'),
      tailMs: z.number().int().min(0).max(10_000).default(1200).describe('Still time before stopping.'),
      format: z.enum(['auto', 'mp4', 'webm']).default('auto').describe('auto = mp4 when ffmpeg is installed, else webm.'),
      colorScheme: z.enum(['dark', 'light']).default('dark'),
      locale: z.string().default('it-IT'),
      headless: z.boolean().default(true).describe('false shows the browser window while recording.'),
      stepTimeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
      upload: z.boolean().default(true).describe('Upload to VIVID as a permanent video asset.'),
      outputPath: z.string().optional().describe('Also save the video to this absolute local path.'),
      name: z.string().optional().describe('Asset file name (without extension).'),
    },
    // drives a local browser and writes a video file; may overwrite outputPath
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, guarded(async (a) => {
    const result = await recordUi(client, { ...a, steps: a.steps as RecordStep[] });
    return json(result);
  }));
}
