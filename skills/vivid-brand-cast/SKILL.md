---
name: vivid-brand-cast
description: Set up and reuse a brand's cast on VIVID — save a product from its photo, create a recurring AI testimonial (a consistent person), then feature them by name so look and identity stay identical across every image. Trigger when the user wants the same product or the same person to appear consistently across shots, asks to "save this product", "always use this model", or asks who is already saved in their account. Do not trigger for one-off generations with no reuse, and never to recreate a real, identifiable person the user has no consent for.
---

# Brand cast on VIVID

VIVID keeps two kinds of reusable references on an account:

- **Products** — saved from a real photo, with their colours, material and geometry locked.
- **Testimonials** — a consistent person, either composed from three photos of a real, consenting person, or designed from attributes.

Once saved, both are used by **name**, which is what makes a series of images look like one campaign instead of eight strangers.

## See what already exists

Call `vivid_list_references` before anything else and show the user the names. Most requests are answered by reusing something already saved. Names are how they are referenced later, so read them back exactly.

## Save a product

1. Get the photo: a local file or a public URL. One clear shot of the product, no clutter.
2. Call `vivid_analyze_product` with an optional short `description` ("silver bracelet with blue pearls") and the user's language in `locale`.
3. It returns the analysis (name, category, colours, material) and a clean e-commerce render, and saves the product to the account. Report the assigned name — the user can rename it in the app.
4. From then on, pass that name in `vivid_generate_image` `products`.

This is free, and it counts against the plan's monthly analysis quota.

## Create a testimonial

Two routes, both costing 50 credits — announce the cost and wait for a yes.

- **From photos of a real person**: three views (left profile, front, right profile) via `vivid_create_testimonial` `photos`. Only with that person's explicit consent, which the account records. If the user cannot confirm consent, stop and offer the attributes route instead.
- **From attributes**: `vivid_create_testimonial` `attributes` with at least `gender`, `age`, `ethnicity` (values in English, e.g. "Female", "25-35", "Mediterranean"), plus any of hair, eyes, skin, expression, body type. VIVID assigns the name.

## Use the cast

In `vivid_generate_image`, pass `products: ["Name"]` and `testimonials: ["Name"]`. Identity and geometry are locked, so write the prompt about the **scene** — place, light, action, wardrobe — and leave the product's and the person's appearance alone. Contradicting a locked reference is what makes a face or a logo drift.

## Rules

- Never build a testimonial that imitates a public figure or any identifiable person the user does not have consent for; say plainly that you will not, and offer an attributes-based persona.
- People generated this way are not real: never present them as a genuine customer or a real endorsement, and suggest the user labels them as AI where their market requires it.
- Report credit costs before the paid step, from the tool responses.
