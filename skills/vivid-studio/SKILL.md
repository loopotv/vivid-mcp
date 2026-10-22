---
name: vivid-studio
description: Run a full AI content studio for products and brands through VIVID (vividai.tv) — product photos and packshots, SKU-faithful scenes with saved products and recurring AI models, masked retouching and visual QC, product videos, voiceover, music, transcription and subtitles, beat-synced timeline editing with effects, MP4 render, and scripted screen recordings of any website. Trigger when the user asks to generate, edit or deliver images, videos, reels, ads, voiceovers, soundtracks, captions, product sheets or UI walkthrough videos, or mentions VIVID. Works through the VIVID MCP tools when connected, otherwise through the `vivid-mcp` command line with a VIVID API key.
license: MIT
metadata:
  author: VIVID
  homepage: https://vividai.tv
  version: 1.0.0
---

# VIVID Studio

VIVID is an AI content studio for e-commerce. Everything it does — images, video, audio, editing, rendering, screen recording — is exposed as 34 tools named `vivid_*`. This skill tells you how to reach them and how to chain them into finished deliverables.

## 1. Reach the tools

**Option A — MCP tools are present** (any tool whose name ends in `vivid_whoami`, e.g. `mcp__vivid__vivid_whoami`): call them directly. Skip to section 2.

**Option B — no MCP, but a shell with Node.js 20+**: run the same tools from the command line. Same names, same arguments, same results.

```bash
export VIVID_API_KEY=vk_...            # from https://vividai.tv/settings → API key
npx -y vivid-mcp@latest call whoami    # check the connection
npx -y vivid-mcp@latest tools          # list every tool
npx -y vivid-mcp@latest schema generate_image   # description + JSON schema of the arguments
npx -y vivid-mcp@latest call generate_image '{"prompt":"…","model":"nano-banana-2"}'
npx -y vivid-mcp@latest call edit_timeline @args.json   # long or quoted arguments: write a JSON file
```

- The `vivid_` prefix is optional on the command line. Output is the tool's JSON on stdout; exit code 1 means the tool reported an error — show its text to the user.
- Argument names are camelCase exactly as in `schema` (`aspectRatio`, not `aspect_ratio`). Unknown names are silently ignored and the default applies, so check the schema before the first call of each tool.
- Needs vivid-mcp 0.30.1 or later (`npx -y vivid-mcp@latest --version`).
- Write arguments to a temporary `.json` file and pass `@file` whenever they contain quotes, newlines or more than a few fields. Shell-quoting JSON by hand is the most common failure.
- If `VIVID_API_KEY` is not set, ask the user for it (they create it on vividai.tv → Settings). Never print the key back, never write it into project files.
- Option B runs on the user's machine, so local file paths work wherever a tool accepts a "local path".

If neither option is available, tell the user they need either the VIVID connector (https://vividai.tv/mcp) or Node.js plus an API key, and stop.

## 2. Before you spend credits

Most tools spend the user's VIVID credits. These rules apply to every workflow:

1. Call `vivid_whoami` once per session: plan and credit balance.
2. Read prices from the tools (`vivid_list_models`, `vivid_list_voices`, `vivid_list_music_providers`, `vivid_product_sheet`), never from memory.
3. Announce the total cost of a paid step and wait for a clear yes before the first paid call. Video always needs a yes; a single cheap image may follow directly from an explicit "generate it".
4. Never pick a model slug, voice or duration you have not seen in a listing.
5. When a call fails, report the error text as-is. Retry once at most, then propose an alternative (another model, a shorter duration).
6. Out of credits: tell the user and follow what the error message says; finished jobs are kept, so the same call can be retried once the balance has changed. Never ask for card details. If the error says auto top-up just charged, retry right away.

Free tools: `whoami`, `usage`, all `list_*`, `get_*`, `job_status`, `render_status`, `music_status`, `transcribe`, `analyze_audio`, `product_sheet`, `upload_file`, `share_asset`, `download_asset`, `create_editor_project`, `edit_timeline`, `render_project`, `record_ui`.
Show credits rounded to two decimals. `analyze_product` is not free: 10 credits.

## 3. Pick the workflow

Read the reference file for the area before acting — each holds the steps, prompt rules and pitfalls.

| The user wants… | Read | Main tools |
|---|---|---|
| Product photos, packshots, lifestyle scenes, ads stills, the same product or person across shots, a product reference sheet, a local fix on an image, a QC check against the real SKU | [references/images.md](references/images.md) | `generate_image`, `list_references`, `analyze_product`, `create_testimonial`, `product_sheet`, `create_product_sheet`, `retouch`, `compare_product` |
| A clip, reel, UGC shot or animated product photo | [references/video.md](references/video.md) | `list_models`, `generate_video`, `job_status` |
| Voiceover, music, transcription, subtitles, BPM / beat analysis | [references/audio.md](references/audio.md) | `generate_voice`, `generate_music`, `transcribe`, `analyze_audio` |
| A finished edit: cut clips to music, add text, captions, transitions, effects, reframe 16:9 ↔ 9:16, export MP4 | [references/editing.md](references/editing.md) | `create_editor_project`, `edit_timeline`, `render_project` |
| A screen recording / walkthrough video of a website or web app | [references/screen-recording.md](references/screen-recording.md) | `record_ui` |

A full campaign usually chains them: images → video clips → voice + music → edit → render. Plan the chain with the user first, give the total cost, then run it step by step and show intermediate results.

## 4. Files in and out

- **In:** generation tools take public URLs. Turn a local file or a third-party URL into one with `vivid_upload_file` (temporary, 7 days). Tools whose argument says "asset id, URL or local path" accept all three directly.
- **Out:** results land in the user's VIVID gallery with an asset id and a download URL. `vivid_download_asset` saves a file locally (Option B, or a local MCP server). `vivid_share_asset {public:true}` returns a public link; relay the `disclosure.notice` it returns.
- **Find past work:** `vivid_list_assets`, `vivid_list_jobs`, `vivid_list_editor_projects` (newest first), `vivid_list_references`.
- Model descriptions in the listings are short summaries: choose models on `supports`, `durations`, `resolutions` and prices, not on the description.

## 5. Rules that always apply

- Generated people and products are AI-made: never present them as real photographs, real customers or genuine endorsements.
- Never recreate a real, identifiable person without their consent, and never set `consent: true` on the user's behalf.
- Write generation prompts in English, even when the conversation is in another language; reply to the user in their language.
- One concept per generation call. Iterate with new calls instead of packing unrelated shots into one.
