import { readFile, writeFile } from 'node:fs/promises';
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { findingSchema, validateReviewerResult, type ReviewerResult } from './schema.ts';

export async function runReviewer(options: {
  cwd: string;
  id: ReviewerResult['reviewer'];
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
  contextRoot: string;
}): Promise<ReviewerResult> {
  let submitted: ReviewerResult | undefined;
  const submit = defineTool({
    name: 'submit_findings',
    label: 'Submit findings',
    description: 'Submit the complete structured finding set exactly once.',
    parameters: Type.Object({ findings: Type.Array(findingSchema, { maxItems: 50 }) }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('findings already submitted');
      submitted = validateReviewerResult({ reviewer: options.id, findings: params.findings });
      return { content: [{ type: 'text', text: 'Findings accepted.' }], details: {} };
    },
  });
  const prompt = await readFile(options.promptPath, 'utf8');
  await runSession({ ...options, systemPrompt: prompt, tools: ['read', 'grep', 'find', 'ls', 'submit_findings'], customTools: [submit] });
  if (!submitted) throw new Error(`${options.id} did not submit findings`);
  await writeFile(`${options.contextRoot}/results/${options.id}.json`, `${JSON.stringify(submitted, null, 2)}\n`);
  return submitted;
}

export async function runAggregator(options: {
  cwd: string;
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
  results: ReviewerResult[];
  failures: Array<{ reviewer: string; error: string }>;
  githubTool: ReturnType<typeof defineTool>;
}): Promise<void> {
  const prompt = await readFile(options.promptPath, 'utf8');
  await runSession({
    ...options,
    systemPrompt: prompt,
    task: `聚合并发布以下 Reviewer 输出：\n${JSON.stringify({ results: options.results, failures: options.failures })}`,
    tools: ['create_pull_request_review'],
    customTools: [options.githubTool],
  });
}

async function runSession(options: {
  cwd: string;
  systemPrompt: string;
  task?: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
  tools: string[];
  customTools: ReturnType<typeof defineTool>[];
  contextRoot?: string;
}): Promise<void> {
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const systemPrompt = options.contextRoot
    ? `${options.systemPrompt}\n\nReview context 绝对路径：${options.contextRoot}`
    : options.systemPrompt;
  const loader = isolatedLoader(systemPrompt);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinking,
    tools: options.tools,
    customTools: options.customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: settings,
  });
  try {
    await session.prompt(options.task ?? '执行系统指令中的完整审查任务。');
  } finally {
    session.dispose();
  }
}

function isolatedLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
