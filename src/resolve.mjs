#!/usr/bin/env node
/**
 * Ask Runware which of the models in models.json it actually serves, and record the AIR id
 * for each one. Everything Runware does not return is routed to its native provider
 * (providers/<id>/config.json) by the runner instead.
 *
 *   node src/resolve.mjs                # resolve all
 *   node src/resolve.mjs --show          # also print every search candidate
 *   node src/resolve.mjs --models=flux-2-pro,seedream-4-5
 */
import path from 'node:path';
import { ROOT, loadEnv, readJSON, writeJSON, parseArgs, pool } from './lib/util.mjs';
import * as runware from './providers/runware.mjs';

loadEnv();
const { flags } = parseArgs();

const models = readJSON(path.join(ROOT, 'models.json'), []);
const overrides = readJSON(path.join(ROOT, 'models.override.json'), {}) || {};
const filter = flags.models ? String(flags.models).split(',') : null;
const targets = filter ? models.filter((m) => filter.includes(m.id)) : models;

/**
 * Variant markers that must match exactly in both directions: a request for the base model
 * must not resolve to the Pro/Lite/Turbo variant, and vice versa.
 */
const QUALIFIERS = [
  'pro', 'lite', 'turbo', 'dev', 'flash', 'instruct', 'plus', 'omni', 'max', 'ultra',
  'fast', 'edit', 'schnell', 'mini', 'thinking',
];

/**
 * Word-level comparison that treats '.' as a separator and splits letter/digit runs, so
 * "FLUX.2" matches "FLUX 2" and "Wan2.7 Image" matches "Wan 2.7 Image".
 */
const flat = (s) =>
  ` ${String(s)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\./g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()} `;
const hasWord = (hay, word) => flat(hay).includes(flat(word));
const words = (s) => flat(s).trim().split(' ').filter(Boolean);

/**
 * Split "Nano Banana 2 (Gemini 3.1 Flash)" into the tokens that must be present and the
 * parenthesised alias, which only breaks ties. Version numbers are ordinary required tokens,
 * so a 2.0 request can never resolve to a 3.0 model.
 */
function parseName(name) {
  const optional = [...name.matchAll(/\(([^)]*)\)/g)].flatMap((m) => words(m[1]));
  const required = words(name.replace(/\([^)]*\)/g, '')).filter((t) => t !== 'standard');
  return { required, optional, qualifiers: QUALIFIERS.filter((q) => required.includes(q)) };
}

/**
 * A candidate qualifies only if it contains every required token and carries exactly the same
 * variant markers. Among those, prefer the one with the fewest extra tokens.
 */
function rank(name, candidates) {
  const { required, optional, qualifiers } = parseName(name);
  if (!required.length) return [];
  const scored = [];
  for (const c of candidates) {
    const hay = `${c.name || ''}`;
    if (!required.every((t) => hasWord(hay, t))) continue;
    const candWords = words(hay);
    const candQualifiers = QUALIFIERS.filter((q) => candWords.includes(q));
    if (candQualifiers.length !== qualifiers.length || !qualifiers.every((q) => candQualifiers.includes(q))) {
      continue;
    }
    const extra = candWords.filter((t) => !required.includes(t)).length;
    const bonus = optional.filter((t) => hasWord(hay, t)).length;
    scored.push({ candidate: c, extra, bonus, score: bonus * 2 - extra });
  }
  return scored.sort((a, b) => b.score - a.score);
}

const resolved = {};
const rows = [];

await pool(targets, Number(flags.concurrency || 3), async (m) => {
  if (overrides[m.id]) {
    resolved[m.id] = { air: overrides[m.id], matchedName: '(manual override)', source: 'override' };
    rows.push([m.name, 'override', overrides[m.id]]);
    return;
  }
  try {
    const all = await runware.search(m.runwareSearch, { limit: 25 });
    // Keep only models that can actually take a prompt and return an image: the same search
    // term also surfaces LoRA-training and video entries.
    const candidates = all.filter((c) => {
      const caps = c.capabilities || [];
      if (caps.length && !caps.includes('io:text-to-image')) return false;
      if (m.kind === 'edit' && caps.length && !caps.includes('op:edit')) return false;
      return !/lora|training|video|upscal|controlnet/i.test(c.name || '');
    });
    if (flags.show) {
      console.log(`\n${m.name}  ← search "${m.runwareSearch}"`);
      for (const c of candidates) console.log(`    ${c.air}  ${c.name}`);
    }
    // A few models are listed on Runware under a shorter name than the vendor uses.
    const ranked = rank(m.runwareAlias || m.name, candidates);
    const hit = ranked[0];
    if (hit) {
      const ambiguous = ranked.length > 1 && ranked[1].score === hit.score;
      resolved[m.id] = {
        air: hit.candidate.air,
        matchedName: hit.candidate.name,
        source: 'modelSearch',
        matchedVia: m.runwareAlias || undefined,
        ambiguous: ambiguous || undefined,
        alternatives: ranked.slice(1, 6).map((r) => ({ air: r.candidate.air, name: r.candidate.name })),
      };
      rows.push([
        m.name,
        'runware',
        `${hit.candidate.air}  (${hit.candidate.name})${ambiguous ? '  ⚠ ambiguous' : ''}`,
      ]);
    } else {
      resolved[m.id] = {
        air: null,
        source: 'not-found',
        native: m.native,
        candidates: candidates.slice(0, 8).map((c) => ({ air: c.air, name: c.name })),
        searchedRaw: all.length,
      };
      rows.push([m.name, `native:${m.native?.provider ?? '?'}`, 'not on Runware']);
    }
  } catch (err) {
    resolved[m.id] = { air: null, source: 'error', error: err.message, native: m.native };
    rows.push([m.name, 'error', err.message.slice(0, 80)]);
  }
});

const outFile = path.join(ROOT, 'models.resolved.json');
const previous = readJSON(outFile, {}) || {};
writeJSON(outFile, { ...previous, ...resolved });

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('MODEL', 34)}${pad('ROUTE', 20)}RESOLVED`);
console.log('-'.repeat(100));
for (const [a, b, c] of rows) console.log(`${pad(a, 34)}${pad(b, 20)}${c}`);

const onRunware = Object.values(resolved).filter((r) => r.air).length;
console.log(
  `\n${onRunware}/${targets.length} on Runware, ${targets.length - onRunware} routed to native providers.`,
);
console.log(`Wrote ${path.relative(ROOT, outFile)}.`);
console.log('Fix a wrong match by adding {"<model-id>": "<air:id@1>"} to models.override.json.');
