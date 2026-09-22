# vivid-mcp

MCP server for [VIVID](https://vividai.tv) — the AI content studio for e-commerce. Connect your VIVID account to Claude Desktop, Claude Code, Cursor or any [Model Context Protocol](https://modelcontextprotocol.io) client and generate images and videos, browse your gallery and manage jobs from the chat.

## What you can do

| Tool | What it does |
|---|---|
| `vivid_whoami` | Account linked to the key: plan, credits |
| `vivid_usage` | Monthly usage vs plan limits |
| `vivid_list_models` | Image / video / LLM models with prices and capabilities |
| `vivid_generate_image` | Text-to-image (with optional product / person / context references), waits for the result |
| `vivid_generate_video` | Start a video (Seedance 2.5, Kling O3, MiniMax H3, Gemini Omni, LTX, Grok…) |
| `vivid_job_status` | Poll a job, get the asset and download URL |
| `vivid_list_jobs` | Recent generations |
| `vivid_list_assets` · `vivid_get_asset` | Browse the gallery |
| `vivid_download_asset` | Save an asset to a local folder |
| `vivid_share_asset` | Publish an asset and get a share link, toggle favorite |
| `vivid_upload_file` | Upload a local file or URL to use as reference / start frame / audio |
| `vivid_list_references` | Saved products (Analizza prodotto) and testimonials / characters with names and ids — use the names in `vivid_generate_image` `products` / `testimonials`, like #Product / @Testimonial in the app |
| `vivid_analyze_product` · `vivid_create_testimonial` | Save a product from a photo (free, plan quota) or create a reusable testimonial from three photos or attributes (50 credits) — both then usable by name |
| `vivid_list_voices` | TTS providers and preset voices with credit cost |
| `vivid_chat` | One chat completion on VIVID's LLM routing — Grok, Claude, OpenAI GPT, Kimi (Wavespeed)  |
| `vivid_generate_music` · `vivid_list_music_providers` | Unique track from a brief — MiniMax Music 3.0 (14 credits, vocals optional; length is a hint, trim in the editor) |
| `vivid_analyze_audio` | Tempo (BPM, beat grid) and transient peaks of a music/voice file, computed server-side (free): the cut points for a dynamic montage, also used automatically by `CUT_TO_BEAT` (grid `beats` \| `peaks`) |
| `vivid_transcribe` | Speech-to-text (Deepgram Nova-3, free): per-word timestamps, readable cues, SRT/VTT export — from an asset, URL or local file |
| `vivid_retouch` | Edit ONE object of an image (text target, region or mask), rest byte-identical — 2–6 credits |
| `vivid_compare_product` | Visual QC of a render vs the SKU photo: match score, verdict, differences, fixPrompt — 1 credit |
| `vivid_generate_voice` | Text-to-speech: OmniVoice Voice Clone (3–10 s reference), Gemini 3.1 Flash presets, MiniMax Speech 2.8 HD (presets, cloned voices, emotions), OmniVoice voice design, Deepgram |
| `vivid_list_projects` | Your projects |
| `vivid_list_editor_projects` | Saved video-editor timelines |
| `vivid_create_editor_project` · `vivid_get_editor_project` · `vivid_edit_timeline` | Build and edit video-editor timelines headless (clips, trims, speed, transitions, 16:9↔9:16, texts, masks, keyframes) with the same engine as the web editor — see *Timeline editing* |
| `vivid_render_project` · `vivid_render_status` | Queue an MP4 render of an editor project and poll it (see *Rendering* below) |
| `vivid_record_ui` | Screen-record a scripted walkthrough of vividai.tv (or any site) with a local Chromium — cursor, smooth moves, click ripples — and upload it as a video asset (see *UI recording* below) |

## Setup

1. Get an API key: sign in on [vividai.tv](https://vividai.tv) → **Settings** → **API key**.
2. Connect your client. Three ways, pick one:

| | How | Needs Node? | Local-only tools (`vivid_download_asset`, `vivid_record_ui`, local paths) |
|---|---|---|---|
| **Remote** | `https://mcp.vividai.tv/mcp` + `Authorization: Bearer vk_…` | no | no |
| **Connector (ChatGPT, Claude.ai)** | `https://mcp.vividai.tv/mcp` with OAuth — no key to paste | no | no |
| **Claude Desktop extension** | download [`vivid-mcp.mcpb`](https://vividai.tv/downloads/vivid-mcp.mcpb), double-click, paste the key | no (bundled runtime) | yes |
| **Local (npx)** | `npx -y vivid-mcp` with `VIVID_API_KEY` | Node.js 20+ | yes |

### Remote (nothing to install)

The same server runs as a Cloudflare Worker at `https://mcp.vividai.tv/mcp` (Streamable HTTP, stateless). Send your API key on every request:

```bash
# Claude Code
claude mcp add --transport http vivid https://mcp.vividai.tv/mcp --header "Authorization: Bearer vk_xxx"
```

```json
// Cursor and other clients that take a URL + headers
{ "mcpServers": { "vivid": { "url": "https://mcp.vividai.tv/mcp", "headers": { "Authorization": "Bearer vk_xxx" } } } }
```

`GET https://mcp.vividai.tv/` answers with the version and the endpoint. Files must be public URLs (`vivid_upload_file` accepts a URL); `outputDir` / `outputPath` are ignored.

### Connectors: ChatGPT, Claude.ai (OAuth)

Clients that cannot send a header authenticate with OAuth 2.1 instead. Add a connector with the URL `https://mcp.vividai.tv/mcp` and pick **OAuth** (ChatGPT → Settings → Connectors → Create; Claude.ai → Settings → Connectors → Add custom connector). The client discovers `/.well-known/oauth-protected-resource`, registers itself (dynamic client registration) and sends you to `vividai.tv/oauth/consent`, where you sign in and click **Authorize**. Each connector gets its own credential (`vc_…`, never your API key) that acts on your assets and credits but cannot change the password, rotate the API key or delete the account; revoke it any time from **Settings → Connected apps**.

### Claude Desktop (one-click extension)

Download [vivid-mcp.mcpb](https://vividai.tv/downloads/vivid-mcp.mcpb) and open it with Claude Desktop: it installs the server with its own Node runtime and asks for your API key (stored by Claude as a secret). Built with `npm run build && npx @anthropic-ai/mcpb pack` from `manifest.json`.

### Local (npx, Node.js 20+)

### Claude Code

```bash
claude mcp add vivid -e VIVID_API_KEY=vk_xxx -- npx -y vivid-mcp
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vivid": {
      "command": "npx",
      "args": ["-y", "vivid-mcp"],
      "env": { "VIVID_API_KEY": "vk_xxx" }
    }
  }
}
```

### Cursor / other clients

Same command: `npx -y vivid-mcp` with `VIVID_API_KEY` in the environment.

### Environment

| Variable | Required | Default |
|---|---|---|
| `VIVID_API_KEY` | yes | — |
| `VIVID_API_URL` | no | `https://vivid-api.vividoai.workers.dev` |

## Example prompts

- "Which video models do I have on VIVID and what do they cost?"
- "Generate 2 images of a leather handbag on a marble counter, 4:5, with nano-banana-2."
- "Upload ~/Desktop/bag.jpg and make a 10 s 9:16 video with Seedance 2.5 using it as the product reference. Tell me when it's done."
- "Download my last video to ~/Downloads and give me a public link."
- "Make a ~90 s upbeat instrumental for a product film with MiniMax and save it to ./music."
- "Transcribe ./voiceover.mp3 in Italian and write word-level SRT to ./subs.srt."
- "Create a 9:16 editor project from my last two videos, cut each to 4 s with a dissolve between them, add the title 'New drop' for the first 3 s, then render it."
- "In my last generated image, make the ring on the ring finger a plain yellow gold band, then compare it with ./sku/ring-01.jpg and tell me if it passes."

## Timeline editing

`vivid_create_editor_project` / `vivid_edit_timeline` run the VIVID editor headless ([vivid-editor-core](https://www.npmjs.com/package/vivid-editor-core), the same store and AI-command orchestrator the web editor uses) and save the project to your account, so anything you build here opens in `vividai.tv/tools/editor` and renders with `vivid_render_project`. Commands are `{ type, payload }` objects (ADD_CLIP, UPDATE_CLIP, SPLIT_CLIP, SET_TRANSITION, SET_CANVAS_PRESET, ADD_TEXT, SET_ANIMATIONS, ADD_EFFECT, SET_MASK…) — the tool descriptions list them. Media is imported by VIVID asset id, URL or local path.

## UI recording

`vivid_record_ui` drives a local Chromium through [Playwright](https://playwright.dev) and records the session: you pass a list of steps (`goto`, `click`, `hover`, `type`, `fill`, `press`, `scroll`, `wait`, `hide`, `evaluate`, with Playwright selectors) and get back a crisp 2× video (2880×1800 for the default 1440×900 viewport) uploaded to your gallery, ready for `vivid_create_editor_project` / `vivid_edit_timeline`. The browser is logged into the account of `VIVID_API_KEY` automatically (the key is exchanged for a short-lived session through `POST /api/me/session`), a cursor with click ripples is drawn in-page, and the page-load lead is trimmed. Steps can be `optional` (skipped when their element is missing, e.g. a one-time onboarding dialog). No credits are charged.

Requirements on the machine running the MCP server: Google Chrome (or `npx playwright install chromium`) and, for MP4 output, `ffmpeg` on PATH (otherwise the raw webm is uploaded, which the editor renders fine). `playwright-core` is an optional dependency, loaded only when the tool is used.

## Rendering

VIVID's video editor renders in the browser (Canvas2D + WebCodecs), so `vivid_render_project` does not produce the file by itself: it queues a **render job** and returns an `openUrl`. Open that URL in a browser where you are logged into vividai.tv (or pass `openBrowser: true` to open it on this machine) — the editor loads the project, exports it and uploads the MP4 to your gallery. `vivid_render_status` reports progress and the final asset; `vivid_download_asset` fetches it.

## Credits

Every generation is charged in VIVID credits according to the model (per image, or credits/second × duration for video). `vivid_list_models` shows the exact prices; `vivid_whoami` shows your balance. Videos are pre-charged when the job starts.

## Development

```bash
npm install
npm run typecheck
npm test
npm run inspect   # opens the MCP Inspector against the built server
```

`npm run build` compiles to `dist/`; the `prepare` script runs it automatically when the package is installed from GitHub.

## License

MIT
