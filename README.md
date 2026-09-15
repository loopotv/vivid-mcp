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
| `vivid_list_voices` | TTS providers and preset voices with credit cost |
| `vivid_chat` | One chat completion on VIVID's LLM routing — Grok, Claude, OpenAI GPT, Kimi (Wavespeed)  |
| `vivid_generate_music` · `vivid_list_music_providers` | Unique track from a brief — MiniMax Music 3.0 (14 credits, vocals optional) or Stable Audio 3 (25 credits, exact length, wav) |
| `vivid_transcribe` | Speech-to-text (Deepgram Nova-3, free): per-word timestamps, readable cues, SRT/VTT export — from an asset, URL or local file |
| `vivid_retouch` | Edit ONE object of an image (text target, region or mask), rest byte-identical — 2–6 credits |
| `vivid_compare_product` | Visual QC of a render vs the SKU photo: match score, verdict, differences, fixPrompt — 1 credit |
| `vivid_generate_voice` | Text-to-speech: OmniVoice Voice Clone (3–10 s reference), Gemini 3.1 Flash presets, MiniMax Speech 2.8 HD (presets, cloned voices, emotions), OmniVoice voice design, Deepgram |
| `vivid_list_projects` | Your projects |
| `vivid_list_editor_projects` | Saved video-editor timelines |
| `vivid_create_editor_project` · `vivid_get_editor_project` · `vivid_edit_timeline` | Build and edit video-editor timelines headless (clips, trims, speed, transitions, 16:9↔9:16, texts, masks, keyframes) with the same engine as the web editor — see *Timeline editing* |
| `vivid_render_project` · `vivid_render_status` | Queue an MP4 render of an editor project and poll it (see *Rendering* below) |

## Setup

1. Get an API key: sign in on [vividai.tv](https://vividai.tv) → **Settings** → **API key**.
2. Add the server to your MCP client. Node.js 20+ is required.

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
