#!/usr/bin/env node
/**
 * Run every prompt in prompts.json against every model in models.json.
 *
 * Models that Runware serves go through the Runware API with one key. Everything else is
 * called on its own provider API with its own key, and its output lands under
 * output/non-runware/<provider>/ so the two sets never get mixed up.
 *
 *   node src/run.mjs --dry-run                 # show the plan, call nothing
 *   node src/run.mjs                           # run everything that has a key
 *   node src/run.mjs --only=runware            # Runware-hosted models only
 *   node src/run.mjs --only=non-runware        # direct-provider models only
 *   node src/run.mjs --models=flux-2-pro,seedream-4-5 --prompts=p3-relaxus-logo
 *   node src/run.mjs --hires --concurrency=4 --force
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadEnv, readJSON, writeJSON, parseArgs, pool, sizeFor, writeImage,
} from './lib/util.mjs';
import * as runware from './providers/runware.mjs';
import * as generic from './providers/generic.mjs';
import { renderGallery } from './gallery.mjs';

loadEnv();
const { flags } = parseArgs();

const OUT = path.resolve(ROOT, flags.out ? String(flags.out) : 'output');
const prompts = readJSON(path.join(ROOT, 'prompts.json'), []);
const models = readJSON(path.join(ROOT, 'models.json'), []);
const resolved = readJSON(path.join(ROOT, 'models.resolved.json'), null);

if (!resolved && !flags['no-runware']) {
  console.error(
    'No models.resolved.json yet — run `npm run resolve` first so Runware-hosted models can be\n' +
      'told apart from the ones that need their own provider key (or pass --no-runware to route all\n' +
      'models to their native providers).',
  );
  process.exit(1);
}

/** Decide, per model, which API actually gets called. */
function route(m) {
  const air = flags['no-runware'] ? null : resolved?.[m.id]?.air ?? null;
  if (air) return { kind: 'runware', air, provider: 'runware' };
  return { kind: 'non-runware', air: null, provider: m.native?.provider ?? null };
}

function keyReady(r) {
  if (r.kind === 'runware') return Boolean(process.env.RUNWARE_API_KEY);
  if (!r.provider) return false;
  try {
    const cfg = generic.loadConfig(r.provider);
    if (!process.env[cfg.apiKeyEnv]) return false;
    if (cfg.authMode === 'kling-jwt' && !process.env[cfg.secretKeyEnv]) return false;
    return Boolean((cfg.endpointEnv && process.env[cfg.endpointEnv]) || cfg.endpoint);
  } catch {
    return false;
  }
}

const modelFilter = flags.models ? String(flags.models).split(',') : null;
const promptFilter = flags.prompts ? String(flags.prompts).split(',') : null;

let selectedModels = models.filter((m) => !modelFilter || modelFilter.includes(m.id));
const selectedPrompts = prompts.filter((p) => !promptFilter || promptFilter.includes(p.id));
if (flags.only) selectedModels = selectedModels.filter((m) => route(m).kind === flags.only);
if (flags.limit) selectedModels = selectedModels.slice(0, Number(flags.limit));

const jobs = [];
const skipped = [];
for (const m of selectedModels) {
  const r = route(m);
  const ready = keyReady(r);
  for (const p of selectedPrompts) {
    const dir =
      r.kind === 'runware'
        ? path.join(OUT, 'runware', m.id)
        : path.join(OUT, 'non-runware', r.provider || 'unknown-provider', m.id);
    const job = { model: m, prompt: p, route: r, dir };
    if (!ready) skipped.push({ ...job, reason: 'missing API key or endpoint' });
    else jobs.push(job);
  }
}

const pad = (s, n) => String(s).padEnd(n);
/** Show repo-relative paths when the output dir is inside the repo, absolute when it isn't. */
const rel = (p) => (p.startsWith(ROOT + path.sep) ? path.relative(ROOT, p) : p);
console.log(`${pad('MODEL', 34)}${pad('ROUTE', 36)}STATUS`);
console.log('-'.repeat(102));
for (const m of selectedModels) {
  const r = route(m);
  const label = r.kind === 'runware' ? `runware ${r.air}` : `non-runware/${r.provider ?? '?'}`;
  console.log(`${pad(m.name, 34)}${pad(label, 36)}${keyReady(r) ? 'ready' : 'SKIP (no key)'}`);
}
console.log(
  `\n${selectedModels.length} models x ${selectedPrompts.length} prompts` +
    ` => ${jobs.length} images to generate, ${skipped.length} skipped.`,
);

if (flags['dry-run']) {
  const missing = [...new Set(skipped.map((s) => s.route.provider))].filter(Boolean);
  if (missing.length) {
    console.log('\nProviders still needing credentials in .env:');
    for (const id of missing) {
      try {
        const cfg = generic.loadConfig(id);
        const extra = cfg.secretKeyEnv ? ` + ${cfg.secretKeyEnv}` : '';
        const ep = cfg.endpoint ? '' : ` + ${cfg.endpointEnv}`;
        console.log(`  ${pad(cfg.label, 48)}${cfg.apiKeyEnv}${extra}${ep}`);
      } catch {
        console.log(`  ${id}: no providers/${id}/config.json`);
      }
    }
  }
  process.exit(0);
}

const started = Date.now();
const results = [];

await pool(jobs, Number(flags.concurrency || 3), async (job) => {
  const { model, prompt, route: r, dir } = job;
  const size = sizeFor(prompt.aspect, Boolean(flags.hires));
  const existing = ['png', 'jpg'].map((e) => path.join(dir, `${prompt.id}.${e}`)).find(fs.existsSync);
  if (existing && !flags.force) {
    console.log(`· skip  ${model.name} / ${prompt.id} (already generated)`);
    results.push({
      modelId: model.id, model: model.name, route: r.kind, provider: r.provider, air: r.air,
      promptId: prompt.id, promptLabel: prompt.label, ok: true, cached: true,
      file: path.relative(OUT, existing), ms: 0, cost: null,
    });
    return;
  }

  const t0 = Date.now();
  try {
    const out =
      r.kind === 'runware'
        ? await runware.generate({
            model: r.air, prompt, size, asyncMode: Boolean(flags.async),
          })
        : await generic.generate({
            providerId: r.provider, model: model.native.model, prompt, size, native: model.native,
          });
    const file = writeImage(dir, prompt.id, out.buffer);
    const ms = Date.now() - t0;
    console.log(
      `✓ ${model.name} / ${prompt.id}  ${(ms / 1000).toFixed(1)}s` +
        `${out.cost != null ? `  $${out.cost}` : ''}  → ${rel(file)}` +
        `${out.notes ? `\n    ↳ ${out.notes.join('; ')}` : ''}`,
    );
    results.push({
      modelId: model.id, model: model.name, route: r.kind, provider: r.provider, air: r.air,
      promptId: prompt.id, promptLabel: prompt.label, ok: true,
      file: path.relative(OUT, file), bytes: out.buffer.length, ms, cost: out.cost ?? null,
      seed: out.seed ?? null, configVerified: out.configVerified, notes: out.notes,
    });
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`✗ ${model.name} / ${prompt.id}  ${(ms / 1000).toFixed(1)}s  ${err.message}`);
    results.push({
      modelId: model.id, model: model.name, route: r.kind, provider: r.provider, air: r.air,
      promptId: prompt.id, promptLabel: prompt.label, ok: false, ms, error: err.message,
    });
  }
});

for (const s of skipped) {
  results.push({
    modelId: s.model.id, model: s.model.name, route: s.route.kind, provider: s.route.provider,
    promptId: s.prompt.id, promptLabel: s.prompt.label, ok: false, skipped: true, error: s.reason,
  });
}

/**
 * Merge into any existing results.json instead of replacing it. A filtered run (one model, one
 * prompt) must not wipe the record of every other cell — re-running a single failure would
 * otherwise destroy the summary for the whole grid.
 */
const resultsFile = path.join(OUT, 'results.json');
const previous = readJSON(resultsFile, null);
const cellKey = (r) => `${r.modelId}|${r.promptId}`;
const merged = new Map((previous?.results ?? []).map((r) => [cellKey(r), r]));
const thisRun = { ok: 0, failed: 0 };
for (const r of results) {
  merged.set(cellKey(r), r);
  if (r.ok) thisRun.ok++;
  else if (!r.skipped) thisRun.failed++;
}

const order = new Map(models.map((m, i) => [m.id, i]));
const allResults = [...merged.values()].sort(
  (a, b) => (order.get(a.modelId) ?? 99) - (order.get(b.modelId) ?? 99) || a.promptId.localeCompare(b.promptId),
);

const summary = {
  generatedAt: new Date().toISOString(),
  wallClockSeconds: Math.round((Date.now() - started) / 10) / 100,
  hires: Boolean(flags.hires),
  thisRun: { attempted: jobs.length, ...thisRun, skipped: skipped.length },
  totals: {
    cells: allResults.length,
    ok: allResults.filter((r) => r.ok).length,
    failed: allResults.filter((r) => !r.ok && !r.skipped).length,
    skipped: allResults.filter((r) => r.skipped).length,
    costUSD: Number(allResults.reduce((s, r) => s + (r.cost || 0), 0).toFixed(5)),
  },
  results: allResults,
};

writeJSON(resultsFile, summary);

const csv = [
  'model,route,provider,prompt,ok,seconds,cost_usd,size,notes,file,error',
  ...allResults.map((r) =>
    [
      r.model, r.route, r.provider ?? '', r.promptId, r.ok, ((r.ms || 0) / 1000).toFixed(1),
      r.cost ?? '', r.size ? `${r.size.width}x${r.size.height}` : '', (r.notes ?? []).join('; '),
      r.file ?? '', (r.error ?? '').replace(/[",\n]/g, ' '),
    ]
      .map((v) => `"${String(v)}"`)
      .join(','),
  ),
].join('\n');
fs.writeFileSync(path.join(OUT, 'results.csv'), `${csv}\n`);

// Render every prompt that has results, not just the ones this run touched.
const galleryPrompts = prompts.filter((p) => allResults.some((r) => r.promptId === p.id));
const galleryFile = renderGallery({ summary, prompts: galleryPrompts, models, outDir: OUT });

console.log(
  `\nthis run: ${thisRun.ok} ok · ${thisRun.failed} failed · ${skipped.length} skipped` +
    ` · ${summary.wallClockSeconds}s` +
    `\noverall:  ${summary.totals.ok} ok · ${summary.totals.failed} failed of ${summary.totals.cells} cells` +
    (summary.totals.costUSD ? ` · $${summary.totals.costUSD} recorded` : ''),
);
console.log(`results.json / results.csv in ${rel(OUT)}`);
console.log(`gallery: ${galleryFile}`);
