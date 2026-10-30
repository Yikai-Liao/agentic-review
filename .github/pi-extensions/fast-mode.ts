type StreamOptions = { fetch?: typeof fetch; [key: string]: unknown };
type Provider = { streamSimple(model: any, context: any, options?: StreamOptions): any };
type ExtensionAPI = {
  on(event: 'session_start', handler: (event: unknown, context: {
    modelRegistry: { getProvider(name: string): Provider | undefined };
  }) => void): void;
  registerProvider(name: string, config: { api: string; streamSimple: Provider['streamSimple'] }): void;
};

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

// 只在 API 明确拒绝 priority 时重发尚未开始流式输出的请求；不重放 Agent 或工具。
export function createFastModeFetch(report: (message: string) => void = console.info) {
  let priority = true;
  return (transport: typeof fetch): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.json() as Record<string, unknown>;
    const requestedPriority = priority;
    if (requestedPriority) payload.service_tier = 'priority';
    else delete payload.service_tier;
    const send = () => transport(new Request(request, { body: JSON.stringify(payload) }));
    const response = await send();
    if (!requestedPriority || (response.status !== 400 && response.status !== 422)) return response;

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (!rejectsPriority(response.status, body)) return response;
    if (priority) report('[fast-mode] API rejected priority processing; retrying without service_tier for the rest of this run.');
    priority = false;
    delete payload.service_tier;
    request.signal.throwIfAborted();
    return send();
  };
}

export default function fastMode(pi: ExtensionAPI) {
  if (process.env.REVIEW_FAST_MODE !== 'true') return;
  const withFastMode = createFastModeFetch();
  let installed = false;
  pi.on('session_start', (_event, context) => {
    if (installed) return;
    // 保留 Pi 已解析的模型、认证和流式实现，仅为 Responses 请求增加服务层协商。
    const provider = context.modelRegistry.getProvider('openai');
    if (!provider) throw new Error('OpenAI provider is unavailable for Review fast mode');
    pi.registerProvider('openai', {
      api: 'openai-responses',
      streamSimple: (model, transcript, options) => provider.streamSimple(model, transcript, {
        ...options, fetch: withFastMode(options?.fetch ?? globalThis.fetch),
      }),
    });
    installed = true;
    console.info('[fast-mode] Priority processing enabled; unsupported APIs fall back to their default service tier.');
  });
}
