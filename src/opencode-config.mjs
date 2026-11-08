const DEFAULT_PROVIDER = 'opencode-go';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/v1';
const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY';

function cleanBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_BASE_URL).trim());
  if (url.protocol !== 'https:') throw new Error('OpenCode base URL must use HTTPS');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (url.origin !== 'https://opencode.ai' || url.pathname !== '/inference/go/v1') {
    throw new Error('OpenCode Go base URL must be https://opencode.ai/inference/go/v1');
  }
  return url.toString().replace(/\/+$/u, '');
}

function cleanModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u.test(model)) throw new Error('OpenCode model ID is invalid');
  return model;
}

function cleanKeyEnv(value) {
  const name = String(value || DEFAULT_API_KEY_ENV).trim();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(name)) throw new Error('OpenCode API key environment variable name is invalid');
  return name;
}

/** Resolve the one provider used by the center's DSH-backed model work. */
export function resolveOpenCodeConfig(config = {}, env = process.env) {
  const provider = String(config.modelProvider || env.OPENCODE_PROVIDER || DEFAULT_PROVIDER).trim();
  if (provider !== DEFAULT_PROVIDER) throw new Error(`Only ${DEFAULT_PROVIDER} is enabled; refusing provider ${provider}`);
  const keyEnv = cleanKeyEnv(config.modelApiKeyEnv || env.OPENCODE_API_KEY_ENV || DEFAULT_API_KEY_ENV);
  const baseUrl = cleanBaseUrl(config.modelBaseUrl || env.OPENCODE_BASE_URL || DEFAULT_BASE_URL);
  const model = cleanModel(config.modelName || env.OPENCODE_MODEL || DEFAULT_MODEL);
  return Object.freeze({ provider, model, baseUrl, apiKeyEnv: keyEnv });
}

export function openCodeHeaders(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('OpenCode API key is not configured');
  return { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' };
}

export const OPENCODE_DEFAULTS = Object.freeze({
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL,
  apiKeyEnv: DEFAULT_API_KEY_ENV,
});
