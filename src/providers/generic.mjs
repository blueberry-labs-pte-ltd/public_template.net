import fs from 'node:fs';
import path from 'node:path';
import { ROOT, request, template, pick, materialize, sleep } from '../lib/util.mjs';
import { resolveCredential } from '../lib/auth.mjs';

const CONFIG_DIR = path.join(ROOT, 'providers');
const cache = new Map();

export function configPath(providerId) {
  return path.join(CONFIG_DIR, providerId, 'config.json');
}

export function loadConfig(providerId) {
  if (cache.has(providerId)) return cache.get(providerId);
  const file = configPath(providerId);
  if (!fs.existsSync(file)) throw new Error(`no provider config at providers/${providerId}/config.json`);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(providerId, cfg);
  return cfg;
}

export function listConfigs() {
  if (!fs.existsSync(CONFIG_DIR)) return [];
  return fs
    .readdirSync(CONFIG_DIR)
    .filter((d) => fs.existsSync(configPath(d)))
    .map((d) => loadConfig(d));
}

function firstHit(body, paths = []) {
  for (const p of paths) {
    const hits = pick(body, p);
    if (hits.length) return hits[0];
  }
  return undefined;
}

/**
 * Config-driven REST adapter for the models that are not served by Runware.
 * Each provider owns providers/<id>/config.json plus its own API key env var, so a new
 * direct-provider key can be dropped in without touching the runner.
 *
 * endpointEnv lets any provider be repointed at a gateway or a region-specific host,
 * which is also the escape hatch for providers whose native auth needs request signing.
 */
export async function generate({ providerId, model, prompt, size, native = {} }) {
  const cfg = loadConfig(providerId);
  const endpointTpl = (cfg.endpointEnv && process.env[cfg.endpointEnv]) || cfg.endpoint;
  if (!endpointTpl) {
    throw new Error(
      `${cfg.label} has no callable endpoint — set ${cfg.endpointEnv || 'an endpoint'} to a compatible host. ${cfg.note || ''}`.trim(),
    );
  }
  const apiKey = resolveCredential(cfg);

  const aliasedSize = cfg.sizeAliases?.[prompt.aspect];
  const vars = {
    apiKey,
    model,
    prompt: prompt.positivePrompt,
    negativePrompt: prompt.negativePrompt || '',
    width: size.width,
    height: size.height,
    size: aliasedSize || `${size.width}x${size.height}`,
    sizeStar: aliasedSize?.replace('x', '*') || `${size.width}*${size.height}`,
    aspect: cfg.aspectAliases?.[prompt.aspect] || prompt.aspect,
    n: 1,
    ...cfg.defaults,
    ...native,
  };

  const res = await request(
    template(endpointTpl, vars),
    {
      method: cfg.method || 'POST',
      headers: template(cfg.headers || {}, vars),
      body: JSON.stringify(template(cfg.body || {}, vars)),
    },
    { timeout: cfg.timeoutMs ?? 300_000 },
  );

  if (!res.ok) {
    const msg = firstHit(res.body, cfg.errorPaths || ['error.message', 'message', 'msg', 'raw']);
    throw new Error(`HTTP ${res.status}: ${msg || JSON.stringify(res.body).slice(0, 300)}`);
  }

  let body = res.body;

  // Async providers: the submit call returns a task id, then we poll until it reports success.
  if (cfg.poll) {
    const taskId = firstHit(body, cfg.poll.taskIdPaths || ['id']);
    if (!taskId) throw new Error(`no task id in submit response: ${JSON.stringify(body).slice(0, 300)}`);
    const pollVars = { ...vars, taskId };
    const pollUrl = firstHit(body, cfg.poll.urlPaths || []) || template(cfg.poll.endpoint, pollVars);
    const deadline = Date.now() + (cfg.poll.timeoutMs ?? 600_000);
    for (;;) {
      if (Date.now() > deadline) throw new Error(`polling timed out for task ${taskId}`);
      await sleep(cfg.poll.intervalMs ?? 4000);
      const p = await request(pollUrl, {
        method: cfg.poll.method || 'GET',
        headers: template(cfg.poll.headers || cfg.headers || {}, pollVars),
        ...(cfg.poll.body ? { body: JSON.stringify(template(cfg.poll.body, pollVars)) } : {}),
      });
      const status = String(firstHit(p.body, cfg.poll.statusPaths || ['status']) ?? '');
      if ((cfg.poll.failureValues || ['FAILED', 'failed', 'Fail', 'Error']).includes(status)) {
        const msg = firstHit(p.body, cfg.errorPaths || ['message', 'error.message']);
        throw new Error(`task ${taskId} failed: ${msg || status}`);
      }
      if ((cfg.poll.successValues || ['SUCCEEDED', 'succeeded', 'Success', 'Ready']).includes(status)) {
        body = p.body;
        break;
      }
    }
  }

  const paths = cfg.poll?.imagePaths || cfg.imagePaths || [];
  const payload = firstHit(body, paths);
  if (!payload) {
    throw new Error(
      `no image found via imagePaths [${paths.join(', ')}] — response was ${JSON.stringify(body).slice(0, 400)}`,
    );
  }

  return {
    buffer: await materialize(payload),
    cost: null,
    seed: null,
    configVerified: cfg.verified === true,
    raw: cfg.keepRaw ? body : undefined,
  };
}
