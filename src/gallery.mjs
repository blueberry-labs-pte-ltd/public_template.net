#!/usr/bin/env node
/**
 * Build a single self-contained HTML page that puts every model's output for a prompt
 * side by side. Run automatically at the end of src/run.mjs, or standalone:
 *
 *   node src/gallery.mjs            # rebuild output/gallery.html from output/results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib/util.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e8eaf0;--dim:#98a0b3;--ok:#4ade80;--bad:#f87171;--accent:#7dd3fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,sans-serif}
header{padding:28px 32px;border-bottom:1px solid var(--line)}
h1{margin:0 0 6px;font-size:20px;letter-spacing:.2px}
.meta{color:var(--dim);font-size:13px}
section{padding:28px 32px;border-bottom:1px solid var(--line)}
h2{margin:0 0 4px;font-size:16px}
.prompt{color:var(--dim);font-size:12.5px;max-width:110ch;margin:0 0 18px;white-space:pre-wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;display:block;background:#0b0d11;aspect-ratio:1/1;object-fit:contain;cursor:zoom-in}
.body{padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.name{font-weight:600;font-size:13px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:11.5px}
.badge{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:10.5px;color:var(--accent)}
.err{color:var(--bad);font-size:11.5px;word-break:break-word}
.fail{min-height:120px;display:grid;place-items:center;color:var(--bad);font-size:12px;padding:16px;text-align:center;background:#0b0d11}
.tag-ok{color:var(--ok)}
dialog{border:0;background:transparent;max-width:96vw;max-height:96vh;padding:0}
dialog img{max-width:96vw;max-height:96vh}
dialog::backdrop{background:#000c}
`;

export function renderGallery({ summary, prompts, models, outDir }) {
  const byPrompt = new Map(prompts.map((p) => [p.id, []]));
  for (const r of summary.results) {
    if (!byPrompt.has(r.promptId)) byPrompt.set(r.promptId, []);
    byPrompt.get(r.promptId).push(r);
  }
  const order = new Map(models.map((m, i) => [m.id, i]));

  const sections = prompts
    .map((p) => {
      const rows = (byPrompt.get(p.id) || []).sort((a, b) => order.get(a.modelId) - order.get(b.modelId));
      const cards = rows
        .map((r) => {
          const badges = [
            `<span class="badge">${esc(r.route === 'runware' ? 'Runware' : r.provider || 'native')}</span>`,
            r.ms ? `<span>${(r.ms / 1000).toFixed(1)}s</span>` : '',
            r.cost != null ? `<span>$${r.cost}</span>` : '',
            r.cached ? '<span>cached</span>' : '',
            r.configVerified === false ? '<span title="provider request template is unverified">template</span>' : '',
          ]
            .filter(Boolean)
            .join('');
          const visual = r.ok
            ? `<img loading="lazy" src="${esc(r.file)}" alt="${esc(r.model)}" onclick="zoom(this.src)">`
            : `<div class="fail">${r.skipped ? 'skipped' : 'failed'}</div>`;
          return `<div class="card">${visual}<div class="body"><div class="name">${esc(r.model)}</div>
        <div class="row">${badges}</div>
        ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</div></div>`;
        })
        .join('\n');
      const okCount = rows.filter((r) => r.ok).length;
      return `<section><h2>${esc(p.label)} <span class="meta">— ${esc(p.aspect)} · ${okCount}/${rows.length} produced an image</span></h2>
<p class="prompt">${esc(p.positivePrompt)}</p>
<div class="grid">${cards}</div></section>`;
    })
    .join('\n');

  const t = summary.totals;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Image model comparison</title><style>${CSS}</style></head>
<body>
<header>
  <h1>Image model comparison — 5 prompts</h1>
  <div class="meta">${esc(summary.generatedAt)} · <span class="tag-ok">${t.ok} ok</span> · ${t.failed} failed · ${t.skipped} skipped · ${summary.wallClockSeconds}s${t.costUSD ? ` · $${t.costUSD} Runware spend` : ''}${summary.hires ? ' · hires' : ''}</div>
</header>
${sections}
<dialog id="lb" onclick="this.close()"><img id="lbi" alt=""></dialog>
<script>
function zoom(src){const d=document.getElementById('lb');document.getElementById('lbi').src=src;d.showModal();}
</script>
</body></html>
`;
  const file = path.join(outDir, 'gallery.html');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

// Standalone rebuild.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = path.join(ROOT, 'output');
  const summary = readJSON(path.join(outDir, 'results.json'));
  if (!summary) {
    console.error('No output/results.json — run `npm test` first.');
    process.exit(1);
  }
  const prompts = readJSON(path.join(ROOT, 'prompts.json'), []);
  const models = readJSON(path.join(ROOT, 'models.json'), []);
  console.log(renderGallery({ summary, prompts, models, outDir }));
}
