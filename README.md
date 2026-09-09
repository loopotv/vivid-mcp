# vivid-mcp

MCP server for [VIVID](https://vividai.tv) — the AI content studio for e-commerce. Connect your VIVID account to Claude Desktop, Claude Code, Cursor or any [Model Context Protocol](https://modelcontextprotocol.io) client and generate images and videos, browse your gallery and manage jobs from the chat.

## What you can do

| Tool | What it does |
|---|---|
| `vivid_whoami` | Account linked to the key: plan, credits |
| `vivid_usage` | Monthly usage vs plan limits |
| `vivid_list_models` | Image / video models with prices and capabilities |
| `vivid_generate_image` | Text-to-image (with optional product / person / context references), waits for the result |
| `vivid_generate_video` | Start a video (Seedance 2.5, Kling O3, MiniMax H3, Gemini Omni, LTX, Grok…) |
| `vivid_job_status` | Poll a job, get the asset and download URL |
| `vivid_list_jobs` | Recent generations |
| `vivid_list_assets` · `vivid_get_asset` | Browse the gallery |
| `vivid_download_asset` | Save an asset to a local folder |
| `vivid_share_asset` | Publish an asset and get a share link, toggle favorite |
| `vivid_upload_file` | Upload a local file or URL to use as reference / start frame / audio |
| `vivid_list_voices` | TTS providers and preset voices with credit cost |
| `vivid_generate_voice` | Text-to-speech: OmniVoice Voice Clone (3–10 s reference), Gemini 3.1 Flash presets, MiniMax Speech 2.8 HD (presets, cloned voices, emotions), OmniVoice voice design, Deepgram |
| `vivid_list_projects` | Your projects |
| `vivid_list_editor_projects` | Saved video-editor timelines |
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
