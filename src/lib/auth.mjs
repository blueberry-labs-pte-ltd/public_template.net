import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Kling / Kolors use a short-lived HS256 JWT signed with the account access key + secret
 * instead of a static bearer token.
 */
export function klingJwt(accessKey, secretKey, ttlSeconds = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 }));
  const sig = crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Resolve the credential a provider config asks for into the string used in its headers. */
export function resolveCredential(cfg) {
  if (cfg.authMode === 'kling-jwt') {
    const ak = process.env[cfg.apiKeyEnv];
    const sk = process.env[cfg.secretKeyEnv];
    if (!ak || !sk) {
      throw new Error(`${cfg.apiKeyEnv} and ${cfg.secretKeyEnv} are both required for ${cfg.label}`);
    }
    return klingJwt(ak, sk);
  }
  const k = process.env[cfg.apiKeyEnv];
  if (!k) throw new Error(`${cfg.apiKeyEnv} is not set — needed for ${cfg.label}`);
  return k;
}
