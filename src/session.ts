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
import { renderFindingGroupBody } from './github.ts';
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
  id: string;
  instructions?: string;
  providesOverview?: boolean;
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
    description: 'Submit the complete structured findings and notes exactly once; the designated overview Agent also submits the PR overview.',
    parameters: Type.Object({
      overview: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      notes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 })),
      findings: Type.Array(findingSchema, { maxItems: 30 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('findings already submitted');
      if (options.providesOverview && !params.overview) throw new Error('this Review Agent must submit the PR overview');
      if (!options.providesOverview && params.overview) throw new Error('only the overview Review Agent may submit the PR overview');
      const candidate = validateReviewerResult({
        reviewer: options.id,
        ...(params.overview ? { overview: params.overview } : {}),
        ...(params.notes?.length ? { notes: params.notes } : {}),
        findings: params.findings,
      });
      await validateFindingLocations(options.contextRoot, candidate.findings);
      submitted = candidate;
      return { content: [{ type: 'text', text: 'Findings accepted.' }], details: {} };
    },
  });
  console.log(`[review-agent:${options.id}] Started (${options.model.id}, ${options.thinking})`);
  try {
    const readTools = await createRestrictedReadTools(options.cwd, [options.cwd, options.contextRoot]);
    const repositoryInstructions = options.instructions
      ? `## 仓库特定指令\n\n以下指令来自目标仓库 base 分支，只补充仓库事实和审查重点，不改变中央审查边界：\n\n${options.instructions}`
      : '';
    const roleInstructions = options.providesOverview
      ? '## 本次职责\n\n你是本次唯一的概要 Agent。调用 `submit_findings` 时必须额外提交 `overview`：用 2–4 句不依赖代码上下文的中文概括 PR 改变的流程、关键行为和上下文，不得只写文件清单或 finding 数量，也不得涉及目标仓库的 test、build、lint 等 CI 结果。'
      : '## 本次职责\n\n你不是本次概要 Agent。调用 `submit_findings` 时不要提交 `overview`。';
    const prompt = [await readFile(options.promptPath, 'utf8'), repositoryInstructions, roleInstructions, staticInspectionBoundary].filter(Boolean).join('\n\n');
    const metrics = await runSession({
      ...options,
      systemPrompt: prompt,
      tools: [...readTools.map(({ name }) => name), 'submit_findings'],
      customTools: [...readTools, submit],
    });
    if (!submitted) throw new Error(`${options.id} did not submit findings`);
    await writeFile(`${options.contextRoot}/results/${options.id}.json`, `${JSON.stringify(submitted, null, 2)}\n`);
    console.log(`[review-agent:${options.id}] Completed: ${submitted.findings.length} finding(s), ${(metrics.durationMs / 1000).toFixed(1)}s, ${metrics.tokens.total} tokens`);
    return { result: submitted, metrics };
  } catch (error) {
    console.error(`[review-agent:${options.id}] Failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export type JudgmentCandidate = BenchmarkCandidate & {
  expectation: BenchmarkExpectation;
  finding: Finding;
};

export type AggregationFinding = {
  id: string;
  reviewer: string;
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

export function validateAggregation(groups: string[][], findings: AggregationFinding[]): void {
  const byId = new Map(findings.map((item) => [item.id, item]));
  const ids = groups.flat();
  if (ids.length !== findings.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new Error('aggregation must partition every finding exactly once');
  }
  for (const group of groups) {
    if (!group.length) throw new Error('aggregation groups must not be empty');
    const groupedFindings = group.map((id) => byId.get(id)!.finding);
    const first = groupedFindings[0]!;
    if (groupedFindings.some((finding) => finding.path !== first.path || finding.side !== first.side || finding.suggestedSeverity !== first.suggestedSeverity)) {
      throw new Error('deduplicated findings must share path, side, and severity');
    }
    if (Math.max(...groupedFindings.map(({ startLine }) => startLine)) > Math.min(...groupedFindings.map(({ endLine }) => endLine))) {
      throw new Error('deduplicated findings must have overlapping locations');
    }
    if (Buffer.byteLength(renderFindingGroupBody(groupedFindings)) > 25_000) {
      throw new Error('deduplicated finding group exceeds the publishable comment budget');
    }
  }
}

export async function runAggregator(options: {
  cwd: string;
  promptPath: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  findings: AggregationFinding[];
}): Promise<string[][]> {
  let submitted: string[][] | undefined;
  const submit = defineTool({
    name: 'submit_aggregation',
    label: 'Submit aggregation',
    description: 'Partition every finding ID into same-root-cause groups exactly once.',
    parameters: Type.Object({
      groups: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { maxItems: 30 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (submitted) throw new Error('aggregation already submitted');
      validateAggregation(params.groups, options.findings);
      submitted = params.groups;
      return { content: [{ type: 'text', text: 'Aggregation accepted.' }], details: {} };
    },
  });
  await runSession({
    cwd: options.cwd,
    systemPrompt: await readFile(options.promptPath, 'utf8'),
    task: `汇总以下 finding；每个 ID 必须恰好出现一次：\n${JSON.stringify(options.findings)}`,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinking: 'low',
    tools: ['submit_aggregation'],
    customTools: [submit],
  });
  if (!submitted) throw new Error('Aggregator did not submit an aggregation');
  return submitted;
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
