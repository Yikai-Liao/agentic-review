import { reviewInputContext } from '../../scripts/write-review-input.ts';

type ExtensionAPI = {
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; description: string; parameters: unknown }>;
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string; prompt?: string }, ctx: {
    model?: { contextWindow: number; maxTokens: number };
    abort(): void;
  }) => { message: { customType: string; content: string; display: boolean } }): void;
};

export default function reviewInput(pi: ExtensionAPI) {
  pi.on('before_agent_start', (event, ctx) => {
    try {
      const file = process.env.REVIEW_INPUT_PATH;
      if (!file || !ctx.model) throw new Error('Review input or model is unavailable');
      const active = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter(tool => active.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      const content = reviewInputContext(file, ctx.model, { system: event.systemPrompt, prompt: event.prompt, tools });
      return { message: { customType: 'review-input', content, display: false } };
    } catch (error) {
      // Pi 的普通 hook 异常只会记日志；输入准备失败时停止本轮，避免继续审查。
      ctx.abort();
      throw error;
    }
  });
}
