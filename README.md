# Image model bench — 5 prompts × 31 models

Runs the same five prompts through every model in [models.json](models.json) and puts the
results side by side in one HTML page.

Models that **Runware serves** are called through Runware with your single Runware key.
Models Runware **does not serve** are called on their own provider API with their own key,
and their output is kept in a separate folder tree so the two sets never get mixed up:

```
output/
  runware/<model-id>/<prompt-id>.png
  non-runware/<provider>/<model-id>/<prompt-id>.png
  results.json     full record: route, latency, cost, error per cell
  results.csv      same thing, spreadsheet-friendly
  gallery.html     all models side by side, grouped by prompt
```

No dependencies — Node 20+ only.

## Setup

```bash
cp .env.example .env      # fill in whatever keys you have; the rest get skipped
npm run resolve           # ask Runware which models it actually serves
npm run dry               # show the plan and what is still missing a key
npm test                  # generate everything
```

`npm run resolve` writes `models.resolved.json`, which is what decides Runware vs. direct
provider per model. Re-run it any time (Runware keeps adding models, so a model that fell
through to its native provider today may be on Runware next week).

If a name resolves to the wrong AIR id, pin it in `models.override.json`:

```json
{ "seedream-4-5": "bytedance:6@1" }
```

Use `npm run resolve -- --show` to print every search candidate with its AIR id.

## Running

```bash
node src/run.mjs --dry-run                        # plan only, calls nothing
node src/run.mjs --only=runware                   # just the Runware-hosted set
node src/run.mjs --only=non-runware               # just the direct-provider set
node src/run.mjs --models=flux-2-pro,seedream-4-5
node src/run.mjs --prompts=p3-relaxus-logo        # one prompt across all models
node src/run.mjs --concurrency=6                  # default 3
node src/run.mjs --hires                          # 2048x1152 / 1536x1536 instead of 1024-class
node src/run.mjs --force                          # re-generate instead of reusing existing files
node src/run.mjs --async                          # Runware async submit + poll, for slow models
node src/gallery.mjs                              # rebuild gallery.html from results.json
```

Existing images are reused, so a rerun only fills gaps — an interrupted run resumes for free,
and adding one key later regenerates only that provider's cells.

## Adding a key later

Every non-Runware provider is a folder under [providers/](providers/) holding one
`config.json` (endpoint, headers, request body, where the image lives in the response) plus
its own env var. Drop the key in `.env`, rerun `npm test`, and only that provider's cells fill
in. Nothing in `src/` needs to change.

Two flags matter when you read a failure:

- **Request format pre-filled and standard** — `openai`, `google`. These follow the documented
  public request shape.
- **Request format written from the documented shape but not exercised against a live key** —
  every other provider, marked `"verified": false` in its config with a `note` explaining what
  to check. If one of these returns a 4xx, suspect the template or the model id before
  concluding the model failed. The exact error is recorded in `results.json`.

Model ids in `models.json` (`native.model`) are the other thing worth checking against your own
account's model list — vendors rename these between regions and releases.

Three providers additionally need an endpoint, not just a key, because there is no single
shared host: `AZURE_IMAGE_ENDPOINT` (your Foundry deployment), `HUNYUAN_IMAGE_ENDPOINT`
(the native Tencent API uses TC3-HMAC request signing, which a static key can't satisfy — point
this at an OpenAI-compatible gateway), and `HIDREAM_IMAGE_ENDPOINT`. Every provider also accepts
an `*_IMAGE_ENDPOINT` override, which is the way to switch regions or route through a gateway.

Kling/Kolors needs both `KLING_ACCESS_KEY` and `KLING_SECRET_KEY` — it authenticates with a
short-lived HS256 JWT that the runner mints per request.

## Notes on the prompts

- The requested 1600×900 is not a multiple of 64, which most diffusion backends require, so
  16:9 runs at **1024×576** (exact 16:9) or **2048×1152** with `--hires`. Upscale the winner
  afterwards rather than fighting each model's size grid. Providers with a fixed size list
  (OpenAI, Azure) map 16:9 to their nearest landscape size via `sizeAliases` in their config.
- The "no text / no logos / no arrows…" part of prompt 1 is sent as a `negativePrompt` rather
  than left in the positive prompt, since naming things in a positive prompt tends to summon
  them. Most current-generation models **reject** `negativePrompt` outright rather than ignoring
  it, so the runner retries without it and records `negativePrompt not supported` on that cell —
  meaning those models never received the exclusion list. Check the `notes` column before
  concluding a model ignored an instruction.
- Models disagree about legal sizes, and the runner discovers each one's rules from its own error
  rather than from a hard-coded table: Ideogram accepts a fixed size list (min 2048²), Seedream
  5.0 Lite enforces a 3.69M-pixel *minimum*, Nano Banana and ERNIE have their own lists. Each
  cell records the size actually used, so a sharper image may just be a bigger one.
- `results.json` is merged across runs, so re-running a single model or prompt updates those
  cells without discarding the rest of the grid.
- **Step Image Edit 2** and **Qwen-Image-Edit-Plus** are image *editing* models: they expect a
  source image. Given these five text-only prompts they will likely return an error, which is
  the honest result — they aren't text-to-image models. Everything else runs as text-to-image.
- Prompt 3 (the "Relaxus" logo) is the text-rendering test and prompt 2 the instruction-following
  test — those are where models separate most.
