import { mkdir, writeFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export async function createReviewModel(contextRoot: string) {
  const modelId = required('REVIEW_AGENT_MODEL');
  const agentDir = `${contextRoot}/pi`;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    `${agentDir}/models.json`,
    `${JSON.stringify({
      providers: {
        review: {
          baseUrl: process.env.REVIEW_AGENT_BASE_URL,
          apiKey: '$REVIEW_AGENT_API_KEY',
          api: 'openai-responses',
          models: [{
            id: modelId,
            name: modelId,
            reasoning: true,
            input: ['text'],
            contextWindow: 272000,
            maxTokens: 128000,
            thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
            compat: { supportsStrictMode: true },
          }],
        },
      },
    }, null, 2)}\n`,
  );
  const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
  const model = runtime.getModel('review', modelId);
  if (!model) throw new Error(`review model not found: ${modelId}`);
  return { runtime, model };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
