# Video generation

Video is the most expensive thing on VIVID: state the cost and get an explicit yes before every generation.

## Inputs to settle first

- **The shot**: subject, action, camera move, light.
- **Starting point**: a photo to animate (becomes the first frame), reference images (keep the subject, invent the shot), a reference video (copy its motion or rhythm), or nothing.
- **Format**: aspect ratio (`9:16` social, `16:9`, `1:1`) and duration in seconds.
- **Sound**: native audio, when the model supports it. For a voiceover or music track, generate them separately (see audio.md) and combine in the editor.

## Steps

1. `vivid_whoami` for the balance.
2. `vivid_list_models {type:"video"}`. Filter the entries, in this order:
   - `supports` contains what the shot needs: `startFrame` to animate a photo, `reference` for reference images, `videoReference`, `audio` for native sound. Exclude models with `talkingHead` unless the user wants a speaking portrait — they need a voice file and have no fixed durations.
   - `durations` contains the exact length asked (durations are uneven: 4/8/12, 5/10/15, 6/10/15…). If none matches, propose the nearest available length.
   - `aspectRatios` / `resolutions` contain the format asked.
   Then pick the cheapest of the survivors and name it.
3. Compute the cost from the entry:
   - `pricingPerSecond` keyed by resolution (`"480p"`, `"720p"`), mode (`"std"`, `"pro"`) or with `"+audio"` → rate × duration. Use the key matching the `resolution` / `mode` / `generateAudio` you will pass.
   - `creditsPerSecond` alone is the headline rate at the model's **default** resolution (usually 720p) — not the cheapest.
   - `creditsByResolutionAndDuration` (e.g. gemini-omni) → a flat total per clip, read it directly.
   - Reference videos add `creditsPerSecondWithReferenceVideo` / `creditsWithSourceVideo`: billed on input seconds + output seconds.
   Always pass `resolution` explicitly: leaving it out gives the default, often 1.5–2× the 480p price. Announce the total, wait for yes.
4. Inputs must be public URLs: `vivid_upload_file` for local files. `startFrameUrl` animates that exact photo; `referenceImageUrls` keeps the subject; `referenceVideoUrls` only on models whose entry has `referenceVideos` (Seedance bills the uploaded seconds too — include them in the cost; Seedance 2.5 wants 480p or 720p clips).
5. `vivid_generate_video {prompt, model, duration, aspectRatio, resolution, generateAudio?, …}` with the default `wait:false`. It returns a `jobId`. Always pass `aspectRatio`: the default is `16:9`, not the vertical format social clips need.
6. Poll `vivid_job_status {jobId}` every 20–30 s (it also advances the provider). Videos take 1–5 minutes. Tell the user it is running; do not start a second generation meanwhile unless they asked for a batch.
7. When `completed`, deliver the download URL; `vivid_share_asset {public:true}` for a link to send.

## Writing the prompt

- Camera movement and subject movement in **separate sentences** — mixing them is the most common cause of warped results.
- Describe light and material explicitly ("brushed steel catching a hard key light from the right").
- One action per clip. A second action inside four seconds reads as a glitch.
- With a start frame, describe what **changes**, not what is already in the photo.

## Pitfalls

- Use only durations and resolutions the model lists; do not round.
- Start/end frame and reference images can be mutually exclusive: the backend picks one and returns a `warning` — repeat it to the user.
- If the response asks for confirmation (`requiresConfirmation`), show the options it returned and let the user choose.
- On failure, report the provider error, then check `vivid_whoami` to tell the user whether credits were refunded rather than guessing.
- Talking-head models take a portrait as start frame plus a voice file in `audioFileUrls`: generate the voice first with `vivid_generate_voice`.
