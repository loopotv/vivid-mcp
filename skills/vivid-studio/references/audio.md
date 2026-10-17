# Audio: voiceover, music, transcription, beat analysis

## Voiceover (text-to-speech)

1. `vivid_list_voices` for providers, preset voices and prices.
2. `vivid_generate_voice {text, provider, voice?, locale, …}` → public MP3 URL (7-day temp). Max 3000 characters per call: split long scripts at sentence boundaries and keep the same voice.

| Provider | Use it for | Cost |
|---|---|---|
| `gemini` (default) | Rich prosody, presets like Kore, Puck, Zephyr, Charon, Aoede | 1 cr / clip |
| `minimax` | HD presets or the account's cloned voices, with `emotion` | 1 cr / clip |
| `omnivoice-clone` | Clone a voice from a 3–10 s `referenceAudio` (+ `referenceText`) — a consistent presenter | 0.5 cr / clip |
| `omnivoice` | A voice designed from an English description in `voice` | 0.5 cr / clip |
| `deepgram` | Aura-2 presets, quick drafts | free |

Clone only a voice the user owns or has permission to use. Never speed up a recorded human voice to fit a cut — trim the script instead.

## Music

1. `vivid_list_music_providers` for the price (MiniMax Music 3.0, about 14 credits, charged only when the track is ready).
2. `vivid_generate_music {prompt, durationSec, instrumental, lyrics?}`. The prompt is an English brief: genre, mood, instruments, tempo, what it accompanies.
3. Rendering takes 1–3 minutes. If it returns `status:"processing"` with a `taskId`, poll `vivid_music_status {taskId}`.
- There is **no exact length control**: `durationSec` is a hint and a 30 s request may return ~2 min. Trim in the editor.
- With vocals: `instrumental:false` and optional `lyrics` with `[Verse]` / `[Chorus]` tags.
- Tracks are royalty-free and unique.

## Transcription and subtitles

`vivid_transcribe {source, language, format?, granularity?, outputPath?}` — free, Deepgram Nova-3, `it` / `en` / `es`, max 100 MB, asset id / URL / local file.
- `format:"json"` → `words[]` (raw per-word timing), `cues[]` (3–8 words, readable) and `transcript`. Pass `cues` to the editor's `SET_SUBTITLES`.
- `format:"srt"|"vtt"` → a ready subtitle file, optionally written to `outputPath`.

## Tempo and peaks (for cutting to music)

`vivid_analyze_audio {source, mode, bpmHint?, minGapMs?, sensitivity?}` — free, MP3 or WAV only (convert others with `ffmpeg -i in.m4a -c:a libmp3lame out.mp3`).
Returns `bpm`, `beats[]`, `downbeats[]` and `peaks[]` (`{ms, strength}`).
- `beats` → metronomic cuts. `peaks` → cuts on what the ear hears (drops, accents, speech).
- Raise `minGapMs` (600–1500) for fewer, bigger accents.
- You rarely need it directly: `CUT_TO_BEAT` and the `beat-flash` recipe in the editor analyse the music on their own (see editing.md).
