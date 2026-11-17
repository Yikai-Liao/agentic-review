import { readFile, writeFile } from 'node:fs/promises';

function rejectsPriority(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 422) return false;
  const error = (body as { error?: { param?: string; code?: string; message?: string } } | null)?.error;
  if (!error) return false;
  if (error.param && error.param !== 'service_tier') return false;
  if (/quota|billing|rate_limit|authentication|permission|insufficient_credits/i.test(error.code ?? '')) return false;
  if (error.param === 'service_tier'
    && ['unsupported_parameter', 'unsupported_value', 'unknown_parameter', 'invalid_value'].includes(error.code ?? '')) return true;
  const message = error.message ?? '';
  return (error.param === 'service_tier' || /\bservice[_ ]tier\b|\bpriority processing\b|\bfast mode\b/i.test(message))
    && /unsupported|not supported|does not support|unrecognized|unknown parameter|not available|not enabled|not allowed|invalid (?:value|service_tier)|only supports|allowed values|must be one of/i.test(message);
}

export async function configureReviewFastMode(options: {
  enabled: string;
  model: string;
  baseUrl: string;
  token: string;
  modelsPath: string;
  fetchImpl?: typeof fetch;
}) {
  if (options.enabled === '' || options.enabled === 'false') return;
  if (options.enabled !== 'true') throw new Error('REVIEW_FAST_MODE must be true or false');
  if (!options.model || !options.baseUrl || !options.token) throw new Error('Fast mode probe requires the Review model, base URL and API key');

  // Probe once per round at startup; never wrap fetch or reread request bodies in real model requests.
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model, input: 'Reply with OK.', max_output_tokens: 16, store: false, service_tier: 'priority' }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null) as { service_tier?: string; status?: string; error?: unknown } | null;
  if (!response.ok) {
    if (!rejectsPriority(response.status, body)) throw new Error(`Fast mode probe failed (HTTP ${response.status})`);
    console.info('[fast-mode] API rejected priority processing; using the API default service tier for this run.');
    return;
  }
  if (!body || body.error || body.status === 'failed' || body.status === 'cancelled') throw new Error('Fast mode probe did not return a successful response');
  if (body.service_tier !== 'priority' && body.service_tier !== 'fast') {
    console.info('[fast-mode] API did not confirm priority processing; using the API default service tier for this run.');
    return;
  }

  const models = JSON.parse(await readFile(options.modelsPath, 'utf8'));
  const model = models.providers.openai.models.find((model: { id: string }) => model.id === options.model);
  // Write Pi's native parameter into this round's registered model instead of adding a request wrapper.
  model.samplingParams = { ...model.samplingParams, service_tier: 'priority' };
  await writeFile(options.modelsPath, `${JSON.stringify(models, null, 2)}\n`);
  console.info('[fast-mode] Priority processing confirmed and enabled for this run.');
}

export async function main() {
  const model = process.env.REVIEW_AGENT_MODEL;
  const baseUrl = process.env.REVIEW_AGENT_BASE_URL;
  const modelsPath = process.env.PI_MODELS_PATH;
  if (!model || !baseUrl || !modelsPath) throw new Error('Review model, base URL and models path are required');
  const config = JSON.parse(await readFile(modelsPath, 'utf8'));
  const settings = config.providers.openai.modelOverrides[model];
  // modelOverrides cannot create models outside the catalog; register the Responses model explicitly before the action looks it up.
  config.providers.openai = { baseUrl, models: [{ ...settings, id: model, name: model, api: 'openai-responses' }] };
  await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  await configureReviewFastMode({
    enabled: process.env.REVIEW_FAST_MODE ?? '', model,
    baseUrl, token: process.env.REVIEW_AGENT_API_KEY ?? '', modelsPath,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error); process.exitCode = 1; });
