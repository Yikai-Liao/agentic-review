import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';
import inputExtension from '../.github/pi-extensions/review-input.ts';
import { countTokens, reviewInputContext, writeReviewInput, type ReviewInputIndex, type ReviewMaterial } from '../scripts/write-review-input.ts';

function fixture(t: TestContext, materials: ReviewMaterial[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-input-context-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  writeReviewInput(file, materials);
  return { file, index: JSON.parse(readFileSync(file, 'utf8')) as ReviewInputIndex };
}
const model = { contextWindow: 8000, maxTokens: 1000 };
const fixed = { system: '可信系统规则', tools: [{ name: 'read', parameters: { path: 'string' } }] };
const patch: ReviewMaterial = { kind: 'changes', title: 'src/auth.ts', use: 'changes', location: 'src/auth.ts', content: 'SMALL_PATCH\n-allowAll()\n+authorizeOwner()' };

test('GPT 标准 Token 计数与原文索引保留中文、emoji 和特殊 token 字面量', t => {
  assert.equal(countTokens('hello world'), 2);
  const source = '明确决定：保持原范围。🙂\r\n<|endoftext|>'.repeat(6000);
  const { index } = fixture(t, [{ kind: 'discussion', title: '评论 123', use: 'discussion', content: source }]);
  assert.equal(index.tokenizer, 'o200k_base');
  assert.equal(index.materials[0].tokens, countTokens(source));
  assert.equal(readFileSync(index.materials[0].path, 'utf8'), source);
});

test('大评论保留路径与统计，小 patch 和项目规则独立预载', t => {
  const big = 'BIG_COMMENT 明确决定与大量背景。🙂'.repeat(6000);
  const { file, index } = fixture(t, [
    { kind: 'discussion', title: '大评论', use: 'discussion', content: big }, patch,
    { kind: 'rules', title: '项目规则', use: 'request', content: 'PROJECT_RULE: 校验资源归属。' },
  ]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes('PROJECT_RULE'));
  assert.ok(!context.includes('BIG_COMMENT'));
  assert.ok(context.includes(file));
  assert.equal(index.materials.find(item => item.title === '大评论')!.tokens, countTokens(big));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('大 diff 不挤掉小评论，同类材料按可用 context 独立选择', t => {
  const { file } = fixture(t, [
    { ...patch, title: '大 patch', content: 'BIG_PATCH const changed = true;\n'.repeat(5000) },
    { kind: 'discussion', title: '当前确认', use: 'discussion', content: 'CURRENT_DECISION: 本轮明确接受已说明的风险。' },
    patch,
  ]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes('CURRENT_DECISION'));
  assert.ok(!context.includes('BIG_PATCH'));
});

test('预载原文保持为引用材料，内部 Markdown fence 不提前结束引用', t => {
  const source = '文档原文\n````md\n内部示例\n````\n结束。';
  const { file } = fixture(t, [{ kind: 'rules', title: '含\n换行的标题', use: 'request', content: source }]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('## "含\\n换行的标题"'));
  assert.ok(context.includes(`\`\`\`\`\`text\n${source}\n\`\`\`\`\``));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('历史参考只给索引，预算随窗口、输出和既有上下文调整', t => {
  const { file, index } = fixture(t, [patch,
    { kind: 'discussion', title: '未变化的历史', use: 'reference', content: 'HISTORICAL_RECORD: 旧确认原文。' },
  ]);
  const context = reviewInputContext(file, { contextWindow: 4000, maxTokens: 2400 }, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(!context.includes('HISTORICAL_RECORD'));
  assert.ok(context.includes('"title": "未变化的历史"'));
  assert.equal(readFileSync(index.materials[1].path, 'utf8'), 'HISTORICAL_RECORD: 旧确认原文。');
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) + 2400 + 400 <= 4000);
  assert.throws(() => reviewInputContext(file, model, { system: 'huge fixed context '.repeat(6000) }), /startup context budget/);
});

test('索引本身超出预算时仍交付小 patch，并保留完整索引文件入口', t => {
  const { file, index } = fixture(t, [patch, ...Array.from({ length: 200 }, (_, n) => ({
    kind: 'discussion' as const, title: `HISTORY_ITEM_${n}`, use: 'reference' as const, content: '历史原文。',
  }))]);
  assert.ok(countTokens(JSON.stringify(index)) > model.contextWindow / 2);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes(file));
  assert.ok(!context.includes('HISTORY_ITEM_199'));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('运行时只注入材料上下文，不增加读取工具或游标；输入失败明确中止', t => {
  const { file } = fixture(t, [patch]);
  const original = process.env.REVIEW_INPUT_PATH;
  t.after(() => { if (original === undefined) delete process.env.REVIEW_INPUT_PATH; else process.env.REVIEW_INPUT_PATH = original; });
  process.env.REVIEW_INPUT_PATH = file;
  let handler: any;
  inputExtension({
    on: (_event, fn) => { handler = fn; }, getActiveTools: () => ['read'],
    getAllTools: () => [{ name: 'read', description: 'Read source', parameters: { type: 'object' } }],
  });
  let aborted = false;
  const ctx = { model, abort: () => { aborted = true; } };
  const result = handler({ systemPrompt: '控制面规则', prompt: '审查当前 PR' }, ctx);
  assert.equal(result.message.customType, 'review-input');
  assert.ok(result.message.content.includes('SMALL_PATCH'));
  assert.equal(aborted, false);
  process.env.REVIEW_INPUT_PATH = path.join(path.dirname(file), 'missing.json');
  assert.throws(() => handler({ systemPrompt: '控制面规则', prompt: '审查当前 PR' }, ctx), /ENOENT/);
  assert.equal(aborted, true);
});


test('Tokenizer 依赖按可信 lockfile 缓存，并在 Agent 启动前完成保存', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.review.steps as Array<{ name: string; uses?: string; with?: Record<string, string>; run?: string; 'working-directory'?: string }>;
  const restore = steps.findIndex(step => step.name === 'Restore trusted tokenizer dependencies');
  const install = steps.findIndex(step => step.name === 'Install trusted tokenizer dependencies');
  const save = steps.findIndex(step => step.name === 'Save trusted tokenizer dependencies');
  const prepare = steps.findIndex(step => step.name === 'Prepare review context');
  const agent = steps.findIndex(step => step.name === 'Run Pi review');
  assert.ok(restore < install && install < save && save < prepare && prepare < agent);
  assert.equal(steps[restore].with?.path, 'control/node_modules');
  assert.ok(steps[restore].with?.key.includes('control/pnpm-lock.yaml'));
  // Corepack 必须在可信 package.json 所在目录启动，不能由 pnpm 的 --dir 代替。
  assert.equal(steps[install]['working-directory'], 'control');
  assert.match(steps[install].run!, /^corepack pnpm install --prod --frozen-lockfile --ignore-scripts$/);
  assert.equal(steps.filter(step => step.uses?.startsWith('actions/cache/save@')).length, 1);
});
