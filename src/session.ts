import { readFile, writeFile } from 'node:fs/promises';
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import type { BenchmarkCandidate, BenchmarkExpectation } from './benchmark.ts';
import { validateFindingLocations } from './diff.ts';
import { createRestrictedReadTools } from './restricted-tools.ts';
import { findingSchema, validateReviewerResult, type Finding, type ReviewerResult } from './schema.ts';

type Thinking = 'low' | 'medium' | 'high' | 'xhigh';

const staticInspectionBoundary = `## 静态检查边界

只能使用受限的只读工具读取和搜索工作区及指定 Review context。不得运行测试、构建、lint、依赖安装、项目代码或网络请求，也不得修改文件或读取允许目录之外的路径。`;

export type SessionMetrics = {
  durationMs: number;
  model: string;
  responseModel?: string;
  thinking: Thinking;
  reasoningTokens: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

type ReviewerOptions = {
  cwd: string;
  id: ReviewerResult['reviewer'];
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: Thinking;
  contextRoot: string;
};

export async function runReviewer(options: ReviewerOptions): Promise<ReviewerResult> {
  return (await runReviewerWithMetrics(options)).result;
}

export async function runReviewerWithMetrics(options: ReviewerOptions): Promise<{ result: ReviewerResult; metrics: SessionMetrics }> {
  let submitted: ReviewerResult | undefined;
  const submit = defineTool({
    name: 'submit_findings',
    label: 'Submit findings',
    description: 'Submit the complete structured finding set exactly once.',
    parameters: Type.Object({ findings: Type.Array(findingSchema, { maxItems: 50 }) }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('findings already submitted');
      const candidate = validateReviewerResult({ reviewer: options.id, findings: params.findings });
      await validateFindingLocations(options.contextRoot, candidate.findings);
      submitted = candidate;
      return { content: [{ type: 'text', text: 'Findings accepted.' }], details: {} };
    },
  });
  const readTools = await createRestrictedReadTools(options.cwd, [options.cwd, options.contextRoot]);
  const prompt = `${await readFile(options.promptPath, 'utf8')}\n\n${staticInspectionBoundary}`;
  const metrics = await runSession({
    ...options,
    systemPrompt: prompt,
    tools: [...readTools.map(({ name }) => name), 'submit_findings'],
    customTools: [...readTools, submit],
  });
  if (!submitted) throw new Error(`${options.id} did not submit findings`);
  await writeFile(`${options.contextRoot}/results/${options.id}.json`, `${JSON.stringify(submitted, null, 2)}\n`);
  return { result: submitted, metrics };
}

export type JudgmentCandidate = BenchmarkCandidate & {
  expectation: BenchmarkExpectation;
  finding: Finding;
};

export type BenchmarkJudgment = BenchmarkCandidate & { rationale: string };

export async function runBenchmarkJudge(options: {
  cwd: string;
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  candidates: JudgmentCandidate[];
}): Promise<{ judgments: BenchmarkJudgment[]; metrics: SessionMetrics }> {
  let submitted: BenchmarkJudgment[] | undefined;
  const submit = defineTool({
    name: 'submit_judgments',
    label: 'Submit judgments',
    description: 'Submit every semantically accepted expectation/finding pair exactly once.',
    parameters: Type.Object({
      matches: Type.Array(Type.Object({
        expectationIndex: Type.Integer({ minimum: 0 }),
        findingIndex: Type.Integer({ minimum: 0 }),
        rationale: Type.String({ minLength: 1, maxLength: 1000 }),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('judgments already submitted');
      const allowed = new Set(options.candidates.map(({ expectationIndex, findingIndex }) => `${expectationIndex}:${findingIndex}`));
      for (const match of params.matches) {
        if (!allowed.has(`${match.expectationIndex}:${match.findingIndex}`)) throw new Error('judgment is not a candidate pair');
      }
      submitted = params.matches;
      return { content: [{ type: 'text', text: 'Judgments accepted.' }], details: {} };
    },
  });
  const metrics = await runSession({
    cwd: options.cwd,
    systemPrompt: await readFile(options.promptPath, 'utf8'),
    task: `判断以下 expectation/finding 候选对是否描述同一根因和可观察影响：\n${JSON.stringify(options.candidates)}`,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinking: 'low',
    tools: ['submit_judgments'],
    customTools: [submit],
  });
  if (!submitted) throw new Error('benchmark judge did not submit judgments');
  return { judgments: submitted, metrics };
}

export async function runAggregator(options: {
  cwd: string;
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: Thinking;
  results: ReviewerResult[];
  failures: Array<{ reviewer: string; error: string }>;
  githubTool: ReturnType<typeof defineTool>;
}): Promise<void> {
  const findingCount = options.results.reduce((total, result) => total + result.findings.length, 0);
  if (findingCount === 0) {
    if (options.failures.length) throw new Error('reviewers failed without publishable findings');
    return;
  }
  const prompt = await readFile(options.promptPath, 'utf8');
  await runSession({
    ...options,
    systemPrompt: prompt,
    task: `聚合并发布以下 Reviewer 输出：\n${JSON.stringify({ results: options.results, failures: options.failures })}`,
    tools: ['create_pull_request_review'],
    customTools: [options.githubTool],
    requiredTool: 'create_pull_request_review',
  });
}

async function runSession(options: {
  cwd: string;
  systemPrompt: string;
  task?: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinking: Thinking;
  tools: string[];
  customTools: ToolDefinition<any, any>[];
  contextRoot?: string;
  requiredTool?: string;
}): Promise<SessionMetrics> {
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
  const startedAt = performance.now();
  try {
    await session.prompt(options.task ?? '执行系统指令中的完整审查任务。');
    const assistants = session.messages.filter((message) => message.role === 'assistant');
    const finalAssistant = assistants.at(-1);
    if (!finalAssistant || finalAssistant.stopReason === 'error' || finalAssistant.stopReason === 'aborted') {
      throw new Error(finalAssistant?.errorMessage ?? 'session ended without a successful assistant message');
    }
    if (options.requiredTool && !session.messages.some((message) => (
      message.role === 'toolResult' && message.toolName === options.requiredTool && !message.isError
    ))) {
      throw new Error(`required tool did not succeed: ${options.requiredTool}`);
    }
    const stats = session.getSessionStats();
    return {
      durationMs: Math.round(performance.now() - startedAt),
      model: finalAssistant.model,
      ...(finalAssistant.responseModel ? { responseModel: finalAssistant.responseModel } : {}),
      thinking: session.thinkingLevel as Thinking,
      reasoningTokens: session.sessionManager.getEntries().reduce((total, entry) => {
        if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) return total + (entry.usage.reasoning ?? 0);
        if (entry.type !== 'message') return total;
        const message = entry.message;
        if (message.role === 'assistant') return total + (message.usage.reasoning ?? 0);
        if (message.role === 'toolResult') return total + (message.usage?.reasoning ?? 0);
        return total;
      }, 0),
      tokens: stats.tokens,
    };
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
