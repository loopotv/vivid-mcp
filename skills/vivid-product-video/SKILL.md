---
name: vivid-product-video
description: Produce a short product or social video with VIVID — a clip from a still product photo, a UGC-style shot, a looping ad — and follow it until it is ready. Trigger when the user asks for a video, a reel, a clip, an animated version of a product image, or "make this move". Do not trigger for still images (use vivid-product-photos), for editing or rendering an existing VIVID timeline, or when no VIVID account is connected.
---

# Product video with VIVID

Start a video generation, keep the user informed while it runs, deliver the file.
Video is the most expensive thing on VIVID: always state the cost and get a yes before starting.

## Inputs to settle first

- **The shot** — what happens in the clip: subject, action, camera move, light.
- **The starting point** — a product photo to animate (becomes the first frame), reference images, or nothing at all.
- **Format** — aspect ratio (`9:16` social, `16:9` landscape, `1:1`) and duration in seconds.
- **Sound** — whether the model should generate native audio, when it supports it.

## Steps

1. **Check the balance** with `vivid_whoami`.
2. **List the models** with `vivid_list_models` (`type: "video"`). Each entry carries the allowed durations, resolutions, aspect ratios, whether it accepts a start frame or reference images, and its credits per second. Pick the cheapest model that supports what the user asked for, and name it in your reply.
3. **Compute and announce the cost**: credits per second × duration. Wait for confirmation before the paid call.
4. **Prepare the inputs.** A local photo must go through `vivid_upload_file` first; pass the returned URL as `startFrameUrl` (animate this exact photo) or in `referenceImageUrls` (keep the subject, invent the shot). Some models accept one or the other, not both — if the response carries a warning, repeat it to the user.
5. **Start it** with `vivid_generate_video` and `wait: false`. Videos take one to five minutes; blocking the whole time is worse than polling.
6. **Poll** with `vivid_job_status` every 20–30 seconds. Tell the user it is running and roughly how long is left. Do not start a second generation while the first is pending.
7. **Deliver** the download URL when the status is `completed`. For a link someone else can open, `vivid_share_asset` with `public: true`.

## Writing the prompt

Put camera movement and subject movement in **separate sentences** — mixing them is the most common cause of warped results.
Describe light and material explicitly ("brushed steel catching a hard key light from the right").
Keep it to one action per clip: a second action inside four seconds reads as a glitch.

## Rules

- Never start a paid generation without an explicit go-ahead in the conversation.
- Use only durations and resolutions the model lists; do not round them.
- If the backend answers `requiresConfirmation`, show the options it returned and let the user choose.
- If a job fails, report the provider error and the credits position from the next `vivid_whoami`, rather than guessing whether it was charged.
