import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env loader — no dependency, only sets keys that aren't already in the environment. */
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export const uuid = () => randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Sizes are multiples of 64 so that diffusion backends accept them directly.
 * 16:9 at 1024x576 is the exact ratio; --hires swaps in the 2048x1152 pair.
 */
export const SIZES = {
  '16:9': { width: 1024, height: 576 },
  '16:9-hires': { width: 2048, height: 1152 },
  '1:1': { width: 1024, height: 1024 },
  '1:1-hires': { width: 1536, height: 1536 },
  '4:3': { width: 1024, height: 768 },
  '4:3-hires': { width: 1536, height: 1152 },
};

export function sizeFor(aspect, hires = false) {
  return SIZES[hires ? `${aspect}-hires` : aspect] ?? SIZES[aspect] ?? SIZES['1:1'];
}

/** Run `worker` over `items` with a fixed concurrency ceiling, preserving input order. */
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Replace {{token}} in every string of a JSON-ish structure; prune keys that resolve to nothing. */
export function template(node, vars) {
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
  }
  if (Array.isArray(node)) return node.map((n) => template(n, vars)).filter((v) => v !== undefined);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const filled = template(v, vars);
      if (filled !== undefined && filled !== '') out[k] = filled;
    }
    return out;
  }
  return node;
}

/** Read `data[].b64_json` / `output.results[0].url` style paths out of a response body. */
export function pick(body, expr) {
  let nodes = [body];
  for (const raw of expr.split('.')) {
    const seg = raw.match(/^(\w*)(\[(\d*)\])?$/);
    if (!seg) return [];
    const [, key, bracket, index] = seg;
    let next = [];
    for (const n of nodes) {
      const v = key ? n?.[key] : n;
      if (v === undefined || v === null) continue;
      if (bracket) {
        if (!Array.isArray(v)) continue;
        next.push(...(index === '' ? v : [v[Number(index)]]));
      } else next.push(v);
    }
    nodes = next.filter((n) => n !== undefined && n !== null);
  }
  return nodes;
}

/** Turn whatever the API returned (URL, data URI or raw base64) into bytes on disk. */
export async function materialize(value) {
  if (typeof value !== 'string' || !value) throw new Error('empty image payload');
  if (/^https?:\/\//.test(value)) {
    const res = await fetch(value);
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const b64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  return Buffer.from(b64, 'base64');
}

export function writeImage(dir, name, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = buffer.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : 'jpg';
  const file = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** fetch + timeout + retry on 429/5xx. */
export async function request(url, init = {}, { timeout = 300_000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 2000) };
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (attempt < retries) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
      }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error(`timeout after ${timeout}ms`) : err;
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else rest.push(arg);
  }
  return { flags, rest };
}
