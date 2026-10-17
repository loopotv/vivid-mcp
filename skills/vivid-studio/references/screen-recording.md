# Screen recordings of a website

`vivid_record_ui` drives a local Chromium through a scripted list of steps — navigate, move, click, type, scroll, wait — with a visible cursor, smooth mouse moves and click ripples, then uploads the video to the VIVID gallery, ready for the editor. Free.

## Where it runs

Only on the user's machine: the command line (`npx -y vivid-mcp@latest call record_ui @steps.json`) or a local MCP server. The hosted connectors (claude.ai, ChatGPT) do not have it — say so and offer the command-line route.
Requirements: Google Chrome (or `npx playwright install chromium`); `ffmpeg` on PATH for MP4 output, otherwise WebM (the editor handles both).

## Writing the script

```json
{
  "site": "https://example.com",
  "url": "/",
  "login": false,
  "viewport": { "width": 1440, "height": 900 },
  "steps": [
    { "action": "wait", "ms": 1200 },
    { "action": "move", "selector": "text=Pricing", "waitMs": 400 },
    { "action": "click", "selector": "text=Pricing", "waitMs": 1500 },
    { "action": "scroll", "deltaY": 600, "waitMs": 1200 },
    { "action": "click", "selector": "input[type=email]" },
    { "action": "type", "selector": "input[type=email]", "text": "demo@example.com", "delayMs": 60 },
    { "action": "wait", "ms": 1500 }
  ],
  "name": "pricing-walkthrough"
}
```

- `login: true` (default) signs the browser into the **VIVID** account of the API key on vividai.tv only; other sites never receive the session. Set `login: false` anyway when recording another site, to make the intent explicit.
- Selectors are Playwright selectors: CSS, `text=…`, `role=button[name='…']`, `[data-testid=…]`.
- Pace it for a viewer: `waitMs` 600–1500 after each action, `delayMs` 40–80 when typing.
- Mark one-off dialogs (cookie banners, onboarding) with `optional: true`, or hide them for the whole take with `hideSelectors`.
- `viewport {390, 844}` records a phone layout. `scale: 2` (default) gives a crisp 2× video.
- `headless: false` shows the browser while recording — useful to debug a script.
- One feature per recording: short takes are easier to edit and re-shoot.

## After recording

The reply carries the asset id and `durationMs`. Pass both to `vivid_create_editor_project` (`media: [{source: assetId, durationMs}]`) to add a voiceover, captions, zooms (`SET_ANIMATIONS` on scale/x/y) and music, then render (see editing.md).

## Rules

- Record only sites the user is entitled to show. Never type real passwords or personal data into a script: use demo accounts and placeholder values.
- Do not record pages with other people's personal data on screen.
