import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const fixed = { system: 'Trusted system rules', tools: [{ name: 'read', parameters: { path: 'string' } }] };
const patch: ReviewMaterial = { kind: 'changes', title: 'src/auth.ts', use: 'changes', location: 'src/auth.ts', content: 'SMALL_PATCH\n-allowAll()\n+authorizeOwner()' };

test('GPT standard token counting and the raw index keep Chinese, emoji, and special-token literals', t => {
  assert.equal(countTokens('hello world'), 2);
  const source = '明确决定：保持原范围。🙂\r\n<|endoftext|>'.repeat(6000);
  const { index } = fixture(t, [{ kind: 'discussion', title: 'Comment 123', use: 'discussion', content: source }]);
  assert.equal(index.tokenizer, 'o200k_base');
  assert.equal(index.materials[0].tokens, countTokens(source));
  assert.equal(readFileSync(index.materials[0].path, 'utf8'), source);
});

test('A large comment keeps its path and stats while a small patch and project rules preload independently', t => {
  const big = 'BIG_COMMENT explicit decision with lots of background. 🙂'.repeat(6000);
  const { file, index } = fixture(t, [
    { kind: 'discussion', title: 'Large comment', use: 'discussion', content: big }, patch,
    { kind: 'rules', title: 'Project rules', use: 'request', content: 'PROJECT_RULE: verify resource ownership.' },
  ]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes('PROJECT_RULE'));
  assert.ok(!context.includes('BIG_COMMENT'));
  assert.ok(context.includes(file));
  assert.equal(index.materials.find(item => item.title === 'Large comment')!.tokens, countTokens(big));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('A large diff does not crowd out small comments; each material kind is selected independently by available context', t => {
  const { file } = fixture(t, [
    { ...patch, title: 'Large patch', content: 'BIG_PATCH const changed = true;\n'.repeat(5000) },
    { kind: 'discussion', title: 'Current confirmation', use: 'discussion', content: 'CURRENT_DECISION: this round explicitly accepts the stated risk.' },
    patch,
  ]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes('CURRENT_DECISION'));
  assert.ok(!context.includes('BIG_PATCH'));
});

test('Preloaded text stays quoted material, and inner Markdown fences do not end the quote early', t => {
  const source = 'Document text\n````md\nInner example\n````\nEnd.';
  const { file } = fixture(t, [{ kind: 'rules', title: 'Title with\na newline', use: 'request', content: source }]);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('## "Title with\\na newline"'));
  assert.ok(context.includes(`\`\`\`\`\`text\n${source}\n\`\`\`\`\``));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('Earlier references get only an index, and the budget adapts to window, output, and existing context', t => {
  const { file, index } = fixture(t, [patch,
    { kind: 'discussion', title: 'Unchanged history', use: 'reference', content: 'HISTORICAL_RECORD: earlier confirmation text.' },
  ]);
  const context = reviewInputContext(file, { contextWindow: 4000, maxTokens: 2400 }, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(!context.includes('HISTORICAL_RECORD'));
  assert.ok(context.includes('"title": "Unchanged history"'));
  assert.equal(readFileSync(index.materials[1].path, 'utf8'), 'HISTORICAL_RECORD: earlier confirmation text.');
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) + 2400 + 400 <= 4000);
  assert.throws(() => reviewInputContext(file, model, { system: 'huge fixed context '.repeat(6000) }), /startup context budget/);
});

test('When the index itself exceeds the budget, small patches are still delivered with the full index file entry kept', t => {
  const { file, index } = fixture(t, [patch, ...Array.from({ length: 200 }, (_, n) => ({
    kind: 'discussion' as const, title: `HISTORY_ITEM_${n}`, use: 'reference' as const, content: 'Earlier text.',
  }))]);
  assert.ok(countTokens(JSON.stringify(index)) > model.contextWindow / 2);
  const context = reviewInputContext(file, model, fixed);
  assert.ok(context.includes('SMALL_PATCH'));
  assert.ok(context.includes(file));
  assert.ok(!context.includes('HISTORY_ITEM_199'));
  assert.ok(countTokens(context) + countTokens(JSON.stringify(fixed)) <= model.contextWindow / 2);
});

test('The runtime loads trusted rules into the first user message and aborts when initial input is unavailable', t => {
  const { file } = fixture(t, [patch]);
  const promptPath = path.join(path.dirname(file), 'review-prompt.md');
  const prompt = 'Trusted review rules.';
  writeFileSync(promptPath, prompt);
  for (const key of ['REVIEW_INPUT_PATH', 'REVIEW_PROMPT_PATH']) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  process.env.REVIEW_INPUT_PATH = file;
  process.env.REVIEW_PROMPT_PATH = path.join(path.dirname(file), 'missing.md');
  const handlers = new Map<string, (...args: any[]) => any>();
  inputExtension({
    on: (event, fn) => { handlers.set(event, fn); }, getActiveTools: () => ['read'],
    getAllTools: () => [{ name: 'read', description: 'Read source', parameters: { type: 'object' } }],
  });
  let aborted = false;
  const ctx = { model, abort: () => { aborted = true; } };
  const input = handlers.get('input')!;
  const beforeStart = handlers.get('before_agent_start')!;
  assert.throws(input, /ENOENT/);
  assert.throws(() => beforeStart({ systemPrompt: fixed.system, prompt: 'Review the prepared pull request.' }, ctx),
    /Prepared review prompt was not loaded/);
  assert.equal(aborted, true);
  aborted = false;
  process.env.REVIEW_PROMPT_PATH = promptPath;
  assert.deepEqual(input(), { action: 'transform', text: prompt });
  assert.equal(input(), undefined);
  const result = beforeStart({ systemPrompt: fixed.system, prompt }, ctx);
  assert.equal(result.message.customType, 'review-input');
  assert.ok(result.message.content.includes('SMALL_PATCH'));
  assert.equal(aborted, false);
  process.env.REVIEW_INPUT_PATH = path.join(path.dirname(file), 'missing.json');
  assert.throws(() => beforeStart({ systemPrompt: fixed.system, prompt }, ctx), /ENOENT/);
  assert.equal(aborted, true);
});


test('Tokenizer dependencies are cached by the trusted lockfile and saved before the agent starts', () => {
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
  // Corepack must start in the trusted package.json directory; pnpm's --dir cannot replace that.
  assert.equal(steps[install]['working-directory'], 'control');
  assert.match(steps[install].run!, /^corepack pnpm install --prod --frozen-lockfile --ignore-scripts$/);
  assert.ok(steps.every((step, index) => !step.uses?.startsWith('actions/cache/save@') || index < agent));
});
