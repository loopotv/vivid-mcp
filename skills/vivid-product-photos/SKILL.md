---
name: vivid-product-photos
description: Produce e-commerce product photos with VIVID — hero shots, white-background listings, lifestyle scenes and variations — starting from a photo of the product or from its description. Trigger when the user asks for product images, packshots, listing photos, ads creatives or "more shots of this product". Do not trigger for video (use vivid-product-video), for editing an existing image the user uploaded outside VIVID, or when no VIVID account is connected.
---

# Product photos with VIVID

Turn a product photo or description into finished images in the user's VIVID gallery.
Every generation spends the user's credits, so confirm the plan before the first paid call.

## Inputs to settle first

Ask only for what is missing, in one message:

- **The product** — a photo (file or URL), or a saved product name, or a written description.
- **The shot** — what it should look like: background, surface, lighting, mood, props.
- **Format** — aspect ratio (`1:1` listings, `4:5` social, `16:9` banners, `9:16` stories).
- **How many** — 1 to 4 variations per call.

## Steps

1. **Check the account.** Call `vivid_whoami` for the credit balance. If it is below ~20 credits, say so before generating.
2. **Reuse what is saved.** Call `vivid_list_references` (`type: "product"`). If the product is already saved, pass its **name** in `products` — VIVID locks its look and geometry, which is what keeps colours and shape faithful across shots.
3. **Otherwise use the photo.** Upload it with `vivid_upload_file` and pass the returned URL in `objectImageUrls`. If the user wants the product saved for later reuse, run `vivid_analyze_product` instead: it saves the product by name and returns a clean e-commerce render.
4. **Choose the model with `vivid_list_models`** (`type: "image"`). Never invent a slug. Read `creditsPerUse` and report the cost of the batch before generating. Prefer the model the user already used in this conversation.
5. **Generate** with `vivid_generate_image`: `prompt`, `model`, `aspectRatio`, `numImages`, and `products` or `objectImageUrls`. Write the prompt in English even when the conversation is in another language.
6. **Deliver.** The call returns asset ids and download URLs. Show the images. If the user wants a link to send to someone, call `vivid_share_asset` with `public: true` and give the public URL.

## Writing the prompt

State, in this order: the product, the surface it sits on, the background, the light, the camera distance, the mood.
Keep it concrete — "matte black bottle on wet slate, overcast daylight from the left, shallow depth of field, close three-quarter view" beats "beautiful professional photo".
Do not describe the product's own colour or shape when it comes from a reference: the reference already carries it, and contradicting it produces drift.

## Rules

- Never claim an image is a real photograph of the physical product: it is generated.
- Quote costs from `vivid_list_models`, never from memory.
- One concept per call; iterate with a new call rather than asking for many unrelated shots at once.
- If a generation fails, report the error text as-is and suggest a different model rather than silently retrying more than once.
