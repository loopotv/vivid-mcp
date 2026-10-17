# Timeline editing and render

VIVID has a multi-track video editor. You drive it with **commands** — the same `{type, payload}` objects the in-app Art Director uses — applied to a saved project. The full command reference is in the description of `vivid_edit_timeline` (`vivid-mcp schema edit_timeline`); read it once before the first edit.

Editing is free. Only the media you generate for it costs credits.

## Flow

1. **Gather media**: VIVID asset ids (generated images/videos, voice, music), URLs or local files. Videos uploaded from outside VIVID need `durationMs` in `media[]`.
2. **Create the project**: `vivid_create_editor_project {name, canvasPreset, media, commands}`. Put one `ADD_CLIP {assetId}` per media item in `commands` — `assetId` is the media's local id (= its asset id unless you set `localId`). Returns the project id and the timeline with clip ids.
3. **Edit**: `vivid_edit_timeline {projectAssetId, commands}`. Read ids from the previous result (`created`) or `vivid_get_editor_project`. A batch runs in order, so a later command can use a clip created earlier in the same batch. Use `dryRun:true` to preview a risky batch.
4. **Check the result**: the reply lists `applied`, `errors` and `warnings` (e.g. motion blur on a still clip). Fix errors before moving on; mention warnings.
5. **Render**: `vivid_render_project {projectAssetId, name}` returns an `openUrl`. VIVID renders in the browser: the user opens the link while logged in on vividai.tv (on a local setup pass `openBrowser:true`). Poll `vivid_render_status {renderJobId}` until `completed`, then deliver the MP4 download URL.

## Canvas presets

`portrait-fhd` 1080×1920 (default, reels/stories) · `portrait` 720×1280 · `landscape-fhd` 1920×1080 · `landscape` 1280×720 · `square` 1080×1080 · `social` 864×1080 (4:5). Reframe an existing edit with `SET_CANVAS_PRESET`.

## Command cheat sheet

| Goal | Commands |
|---|---|
| Place, trim, split, reorder | `ADD_CLIP`, `UPDATE_CLIP {id, startMs, durationMs, sourceOffsetMs}`, `SPLIT_CLIP`, `DUPLICATE_CLIP`, `REMOVE_CLIP`, `ADD_TRACK` |
| Speed | `UPDATE_CLIP.playbackRate` (constant) · `SET_SPEED_RAMP {clipId, preset: speed-up \| slow-down \| slow-mo-hit \| punch-in \| ease-in-out}` |
| Cut to the music | `CUT_TO_BEAT {audioClipId, beatInterval, grid: beats \| peaks}` — analyses the audio itself |
| Transitions and intros | `SET_TRANSITION {clipId, edge, type: dissolve \| fade-black \| crossfade \| fade-in \| fade-out}` · `SET_CLIP_ANIMATION {clipId, phase, type: fade \| slide-up \| zoom-in \| zoom-pan \| blur-reveal …}` |
| Text | `ADD_TEXT {text, startMs, endMs, x, y, fontSize?, color?, fill?}` — `fill` gives animated gradients (presets iridescent, sunset, ocean, gold, candy) |
| Captions | `SET_SUBTITLES {cues, templateId}` with `cues` from `vivid_transcribe`; templates: outline-reveal, ugc-pop, karaoke-marker, cinematic-fade, neon-cyberpunk, playful-wiggle |
| One style across the edit | `APPLY_EFFECT_RECIPE {recipe: beat-flash \| punch-in \| whip \| handheld \| light-leak \| clear, intensity}` |
| Single effects | `ADD_EFFECT` (blur, vignette, colorGrade, grain, glitch, motionBlur, cameraShake, flash, zoomBlur, lightLeak…) · `SET_EFFECT_KEYFRAMES` to animate one value · `SET_ANIMATIONS` for position/scale/rotation keyframes |
| Look and framing | `SET_CINEMATIC_LOOK`, `UPDATE_CANVAS_OBJECT {id, x, y, w, h, rotation}`, `SET_MASK` |
| Audio | `DETACH_AUDIO`, `UPDATE_CLIP {volume}`, audio transitions on the audio clip |

## Recipes that work

**Beat-synced product reel (9:16)**
1. Media: 4–8 product images/clips + one music track.
2. `ADD_CLIP` each, `ADD_CLIP` the music.
3. `CUT_TO_BEAT {audioClipId, beatInterval: 4, grid: "beats"}` (or `"peaks"` for music without a steady tempo, raising `beatInterval` for slower cuts).
4. Then `APPLY_EFFECT_RECIPE {recipe: "punch-in"}` or `"beat-flash"` — always **after** CUT_TO_BEAT, because recipes pin keyframes to the current cut points.
5. `ADD_TEXT` for the claim at the end, `SET_TRANSITION` fade-out on the last clip and the music.

**Voiceover with captions**
1. `vivid_generate_voice` → MP3; add it as a clip.
2. `vivid_transcribe {source: <voice asset or URL>}` → `cues`.
3. `SET_SUBTITLES {cues, templateId: "ugc-pop", position: 80}`.
4. Lay visuals under it with `UPDATE_CLIP` boundaries matching the cue times.

**Landscape → vertical**: `SET_CANVAS_PRESET` to portrait-fhd, then `UPDATE_CANVAS_OBJECT` to re-centre each clip on the subject.

## Pitfalls

- Effect keyframe `t` is in ms **from the clip start**, not from the timeline start.
- Motion blur only blurs the clip's own movement (keyframes, intros, shake), not motion inside the footage.
- `ADD_CLIP` places the whole asset at the first free gap; trim it afterwards with `UPDATE_CLIP`.
- Never edit timelines by writing project JSON yourself — always go through the commands, so the project stays valid in the app.
