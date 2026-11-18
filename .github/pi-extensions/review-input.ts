import { readFileSync } from 'node:fs';
import { reviewInputContext } from '../../scripts/write-review-input.ts';

type ExtensionAPI = {
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; description: string; parameters: unknown }>;
  on(event: 'input', handler: () => { action: 'transform'; text: string } | undefined): void;
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string; prompt?: string }, ctx: {
    model?: { contextWindow: number; maxTokens: number };
    abort(): void;
  }) => { message: { customType: string; content: string; display: boolean } }): void;
};

export default function reviewInput(pi: ExtensionAPI) {
  let promptLoaded = false;
  pi.on('input', () => {
    if (promptLoaded) return;
    const file = process.env.REVIEW_PROMPT_PATH;
    if (!file) throw new Error('Prepared review prompt path is missing');
    const text = readFileSync(file, 'utf8').trim();
    if (!text) throw new Error('Prepared review prompt is empty');
    promptLoaded = true;
    return { action: 'transform', text };
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      // Pi reports input hook errors and otherwise continues with the original text.
      if (!promptLoaded) throw new Error('Prepared review prompt was not loaded');
      const file = process.env.REVIEW_INPUT_PATH;
      if (!file || !ctx.model) throw new Error('Review input or model is unavailable');
      const active = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter(tool => active.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      const content = reviewInputContext(file, ctx.model, { system: event.systemPrompt, prompt: event.prompt, tools });
      return { message: { customType: 'review-input', content, display: false } };
    } catch (error) {
      // Pi only logs ordinary hook errors; stop the round when input preparation fails instead of reviewing on.
      ctx.abort();
      throw error;
    }
  });
}
