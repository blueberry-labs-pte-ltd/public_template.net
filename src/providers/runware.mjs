import { request, uuid, materialize, sleep } from '../lib/util.mjs';

const ENDPOINT = process.env.RUNWARE_ENDPOINT || 'https://api.runware.ai/v1';

function key() {
  const k = process.env.RUNWARE_API_KEY;
  if (!k) throw new Error('RUNWARE_API_KEY is not set (see .env.example)');
  return k;
}

async function send(tasks) {
  const res = await request(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(tasks),
  });
  const { body } = res;
  if (body?.errors?.length) {
    const e = body.errors[0];
    throw new Error(`${e.code || 'error'}: ${e.message || JSON.stringify(e)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body?.data ?? [];
}

/** modelSearch — used by resolve.mjs to map human model names to AIR identifiers. */
export async function search(term, { limit = 20, category = 'checkpoint' } = {}) {
  const data = await send([
    { taskType: 'modelSearch', taskUUID: uuid(), search: term, limit, category },
  ]);
  return data[0]?.results ?? [];
}

/** Pull the "'2048x2048', '2880x1440', ..." list out of an unsupportedDimensions error. */
function parseSupportedSizes(message) {
  return [...message.matchAll(/'(\d+)\s*x\s*(\d+)'/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
}

/**
 * Of the sizes a model allows, take the closest aspect ratio, then the resolution nearest the
 * one we asked for. Picking the smallest option instead would leave models that offer both
 * 688x384 and 1376x768 rendering at a quarter of everyone else's pixels, which reads as a
 * quality difference in the comparison when it is only a size difference.
 */
function closestSize(list, want) {
  const target = want.width / want.height;
  const wantArea = want.width * want.height;
  const aspectGap = (s) => Math.abs(Math.log(s.width / s.height / target));
  const areaGap = (s) => Math.abs(Math.log((s.width * s.height) / wantArea));
  return list.slice().sort((a, b) => aspectGap(a) - aspectGap(b) || areaGap(a) - areaGap(b))[0];
}

/** Pull the pixel budget out of an invalidPixels error ("must be between X and Y"). */
function parsePixelBounds(message) {
  const m = message.match(/between\s+(\d+)\s+and\s+(\d+)/i);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

/** Scale a size to fit inside a model's pixel budget while holding its aspect ratio. */
function fitPixels(size, bounds) {
  const area = size.width * size.height;
  const round = (v) => Math.max(16, Math.round(v / 16) * 16);
  const ratio = size.width / size.height;
  let scale = 1;
  if (area < bounds.min) scale = Math.sqrt((bounds.min * 1.04) / area);
  else if (area > bounds.max) scale = Math.sqrt((bounds.max * 0.96) / area);
  let width = round(size.width * scale);
  let height = round(width / ratio);
  for (let i = 0; i < 40 && width * height < bounds.min; i++) {
    width += 16;
    height = round(width / ratio);
  }
  for (let i = 0; i < 40 && width * height > bounds.max; i++) {
    width -= 16;
    height = round(width / ratio);
  }
  return { width, height };
}

/**
 * One image from one Runware model, adapting to the model's own constraints.
 *
 * Models differ in ways that are only discoverable by asking: most current-generation models
 * reject negativePrompt outright, Ideogram accepts a fixed size list, Seedream 5 Lite enforces
 * a minimum pixel count, and a few need async delivery to finish at all. Rather than hard-code
 * a table that goes stale, each failure is read and answered once, and every adaptation is
 * recorded in `notes` so the results say what actually got sent.
 */
export async function generate({ model, prompt, size, options = {}, asyncMode = false }) {
  const notes = [];

  async function attempt(state) {
    const taskUUID = uuid();
    const task = {
      taskType: 'imageInference',
      taskUUID,
      positivePrompt: prompt.positivePrompt,
      model,
      width: state.size.width,
      height: state.size.height,
      numberResults: 1,
      outputType: 'URL',
      outputFormat: 'PNG',
      includeCost: true,
      ...(state.withNegative && prompt.negativePrompt
        ? { negativePrompt: prompt.negativePrompt }
        : {}),
      ...(state.useAsync ? { deliveryMethod: 'async' } : {}),
      ...(options.extra || {}),
    };

    let result = (await send([task]))[0];

    // Async delivery returns before the image exists; poll getResponse until it lands.
    if (state.useAsync) {
      const windowMs = options.pollTimeout ?? 1_800_000;
      const deadline = Date.now() + windowMs;
      while (!result?.imageURL && !result?.imageBase64Data && Date.now() < deadline) {
        await sleep(5000);
        const data = await send([{ taskType: 'getResponse', taskUUID }]);
        result = data[0] ?? result;
      }
      if (!result?.imageURL && !result?.imageBase64Data) {
        throw new Error(
          `still "${result?.status ?? 'unknown'}" after ${Math.round(windowMs / 1000)}s of polling`,
        );
      }
    }

    const payload = result?.imageURL || result?.imageBase64Data || result?.imageDataURI;
    if (!payload) throw new Error(`no image in response: ${JSON.stringify(result).slice(0, 300)}`);
    return { result, payload };
  }

  /** Decide how to answer a specific failure, or return null to give up and report it. */
  function adapt(message, state, tried) {
    if (/negativeprompt/i.test(message) && state.withNegative && !tried.has('negative')) {
      return {
        key: 'negative',
        note: 'negativePrompt not supported — retried without it',
        state: { withNegative: false },
      };
    }
    if (/unsupporteddimensions/i.test(message) && !tried.has('dims')) {
      const allowed = parseSupportedSizes(message);
      if (allowed.length) {
        const picked = closestSize(allowed, state.size);
        return {
          key: 'dims',
          note: `model accepts fixed sizes only — used ${picked.width}x${picked.height}`,
          state: { size: picked },
        };
      }
    }
    if (/invalidpixels|invalid image pixels/i.test(message) && !tried.has('pixels')) {
      const bounds = parsePixelBounds(message);
      if (bounds) {
        const picked = fitPixels(state.size, bounds);
        return {
          key: 'pixels',
          note: `pixel budget ${bounds.min}-${bounds.max} — used ${picked.width}x${picked.height}`,
          state: { size: picked },
        };
      }
    }
    if (/timeout/i.test(message) && !state.useAsync && !tried.has('async')) {
      return {
        key: 'async',
        note: 'sync request timed out — retried with async delivery',
        state: { useAsync: true },
      };
    }
    return null;
  }

  let state = { withNegative: options.useNegative !== false, useAsync: asyncMode, size };
  const tried = new Set();
  let out;
  for (let i = 0; ; i++) {
    try {
      out = await attempt(state);
      break;
    } catch (err) {
      const next = i < 4 ? adapt(err.message, state, tried) : null;
      if (!next) throw err;
      tried.add(next.key);
      notes.push(next.note);
      state = { ...state, ...next.state };
    }
  }

  return {
    buffer: await materialize(out.payload),
    cost: out.result.cost ?? null,
    seed: out.result.seed ?? null,
    size: state.size,
    notes: notes.length ? notes : undefined,
    raw: out.result,
  };
}

export const meta = { id: 'runware', label: 'Runware', apiKeyEnv: 'RUNWARE_API_KEY' };
