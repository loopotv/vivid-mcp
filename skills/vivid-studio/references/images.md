# Images: product photos, cast, retouch, QC

## Inputs to settle first

Ask only for what is missing, in one message:

- **The product**: a photo (file or URL), a saved product name, or a written description.
- **The shot**: background, surface, light, mood, props, people.
- **Format**: `1:1` listings, `4:5` social feed, `9:16` stories, `16:9` banners.
- **How many**: 1–4 variations per call.

## Generate product photos

1. `vivid_list_references {type:"product"}`: if the product is already saved, use its **name** in `products`. VIVID locks its colours and geometry, which is what keeps it faithful across shots.
2. Not saved? Either upload the photo (`vivid_upload_file`) and pass the URL in `objectImageUrls`, or — if the user will reuse it — save it first with `vivid_analyze_product` (see below).
3. `vivid_list_models {type:"image"}`: choose the model and announce the cost of the batch (price × `numImages`). For images that must carry legible text (claims, labels, posters) prefer `ideogram-4.5`. Reading the price:
   - Only `creditsPerImage` → that is the price.
   - `creditRates` keyed by resolution (`"1K"`, `"2K"`, `"4K"`) → pass `resolution` explicitly and quote that key. Without `resolution` the flat `creditsPerImage` may be charged instead, which can be higher.
   - `creditRates` keyed `"1K_low"`, `"1K_medium"`, `"2K_high"`… → the model prices by quality × resolution: pass both `resolution` and `quality` and quote `"<resolution>_<quality>"`. Default quality is medium (high for jewellery).
   - Check `aspectRatios` / `resolutions` in the entry before choosing.
4. `vivid_generate_image` with `prompt`, `model`, `aspectRatio`, `numImages`, and `products` / `testimonials` / `objectImageUrls` / `contextImageUrls`. It waits and returns asset ids and download URLs.
5. Show the images. Offer variations, a QC check, a retouch, or a video from the best one.

### Writing the prompt

State, in this order: the product, the surface it sits on, the background, the light, the camera distance, the mood.
Concrete beats generic: "matte black bottle on wet slate, overcast daylight from the left, shallow depth of field, close three-quarter view" beats "beautiful professional photo".
When the product or the person comes from a reference, describe the **scene**, not their appearance — contradicting a locked reference is what makes a logo or a face drift.

## Save a product (reusable by name)

`vivid_analyze_product {image | assetId, description?, locale}` → vision analysis (name, category, colours, material) plus a clean e-commerce render, saved to the account. 10 credits (refunded on failure), 30–90 s — announce it before the call. Report the assigned name; from then on pass it in `products`.

Product reference sheet: `vivid_product_sheet {product}` returns the current sheet and the price of a new one (free call). `vivid_create_product_sheet {product}` draws a 2×2 grid (front, two angles, worn/in use), checks every panel against the real photo and regenerates a failed one for free. Pass side/back photos in `extraPhotos` when the user has them — unseen angles are otherwise reconstructed.

## Recurring people (testimonials)

`vivid_list_references {type:"testimonial"}` first: reuse beats re-creating.
`vivid_create_testimonial` costs 50 credits — announce it and wait for a yes. Two routes:

- **From photos of a real person** (`photos` left/front/right): only with that person's explicit consent. Ask the user to confirm, then pass `consent:true`. Never set it yourself. If consent cannot be confirmed, offer the attributes route.
- **From attributes** (`attributes` with at least `gender`, `age`, `ethnicity` in English, e.g. "Female", "25-35", "Mediterranean"; optional hair, eyes, skin, expression, body type). VIVID assigns the name.

Cast them with `testimonials:["Name"]` in `vivid_generate_image`. Never build a persona that imitates a public figure.

## Fix one thing in an image (masked retouch)

`vivid_retouch {source, prompt, target | region | mask, model?}` edits only the target area; every other pixel stays byte-identical.
- `target`: plain text ("the ring on the left hand"), located automatically (~40–60 s).
- `region`: `{x,y,w,h}` as fractions of the frame, skips the locate step.
- Models: `nano-banana` (default, 6 cr, best fidelity), `seedream` (4), `grok` (3), `z-image` (2, needs region or mask).
- The prompt says what the target should **become**: material, colour, shape.

## Check fidelity against the real product (QC)

`vivid_compare_product {candidate, reference, skuDescription?, focus?}` → `match` 0–1, verdict `pass|review|fail`, differences with severity, and a `fixPrompt`. 1 credit.
Loop for SKU-critical work (jewellery, logos, hardware): generate → compare → if not `pass`, `vivid_retouch` with the `fixPrompt` → compare again. Stop after two rounds and show the user the differences.

## Pitfalls

- Do not describe the product's own colour or shape when it comes from a reference.
- Some CDNs refuse server-side downloads (`analyze_product` with a URL fails): upload the local file instead.
- A generation that times out returns job ids: poll `vivid_job_status` rather than generating again.
