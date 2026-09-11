import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Variant = 'baseline' | 'candidate';
type Choice = 'X' | 'Y' | 'tie';
type Case = { id: string; kind: 'summary' | 'finding' | 'evidence'; input: string; expected: string };
type Config = {
  baseline: string; hypothesis: string; model: string; reasoning: string;
  vary: string[]; shared: string[]; cases: string; rubric: string;
  repetitions: number; maxPromptChars: number;
};
type Lock = { config: Config; hashes: Record<string, string>; promptChars: Record<Variant, number> };
type Mapping = { candidate: 'X' | 'Y'; packetSha256: string; fileSha256: string; outputs: Record<string, string> };
const variants: Variant[] = ['baseline', 'candidate'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const chars = (text: string) => [...text].length;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function local(root: string, relative: string) {
  requireValue(text(relative) && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), '路径必须位于仓库或实验目录内');
  return path.join(root, relative);
}
async function read(root: string, relative: string) { return readFile(local(root, relative), 'utf8'); }
async function json(root: string, relative: string): Promise<unknown> { return JSON.parse(await read(root, relative)); }
async function save(root: string, relative: string, content: string) {
  const file = local(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { flag: 'wx' });
}
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function configOf(value: unknown): Config {
  requireValue(object(value), '实验配置必须为对象');
  for (const field of ['baseline', 'hypothesis', 'model', 'reasoning', 'cases', 'rubric']) requireValue(text(value[field]), `缺少 ${field}`);
  requireValue(/^[a-f0-9]{40}$/.test(value.baseline as string), 'baseline 必须为完整 commit SHA');
  for (const field of ['vary', 'shared']) requireValue(Array.isArray(value[field]) && value[field].every(text), `${field} 必须为路径数组`);
  const rules = [...value.vary as string[], ...value.shared as string[]];
  requireValue((value.vary as string[]).length > 0 && new Set(rules).size === rules.length, '可变规则不能为空，规则路径不能重复');
  for (const field of ['repetitions', 'maxPromptChars']) requireValue(Number.isSafeInteger(value[field]) && Number(value[field]) > 0, `${field} 必须为正整数`);
  return value as unknown as Config;
}
function casesOf(value: unknown): Case[] {
  requireValue(Array.isArray(value) && value.length > 0, '用例不能为空');
  for (const item of value) {
    requireValue(object(item) && text(item.id) && /^[A-Za-z0-9_-]+$/.test(item.id), '用例 ID 无效');
    requireValue(['summary', 'finding', 'evidence'].includes(String(item.kind)) && text(item.input) && text(item.expected), `用例 ${item.id} 缺少类型、事实或验收标准`);
  }
  requireValue(new Set(value.map(item => item.id)).size === value.length, '用例 ID 重复');
  return value as Case[];
}
function directory(root: string, id: string) {
  requireValue(/^[A-Za-z0-9_-]+$/.test(id), '实验 ID 只允许字母、数字、下划线和连字符');
  return local(root, `evals/experiments/${id}`);
}
function jobs(config: Config, cases: Case[]) {
  return Array.from({ length: config.repetitions }, (_, i) => cases.map(item => ({
    id: `${item.id}/${i + 1}`, item, repeat: i + 1,
    output: (variant: Variant) => `outputs/${variant}/r${i + 1}/${item.id}.md`,
  }))).flat();
}

export async function prepare(root: string, id: string) {
  const dir = directory(root, id);
  const config = configOf(await json(dir, 'experiment.json'));
  const cases = casesOf(await json(root, config.cases));
  const inputAudit = await read(dir, 'input-audit.md');
  requireValue(text(inputAudit), '准备前需记录输入充分性审计，不能只检查 Prompt');
  const files: Record<string, string> = { 'cases.json': pretty(cases), 'rubric.md': await read(root, config.rubric) };
  const promptChars: Record<Variant, number> = { baseline: 0, candidate: 0 };
  for (const file of [...config.vary, ...config.shared]) {
    local(root, file);
    const candidate = await read(root, file);
    const baseline = config.vary.includes(file)
      ? execFileSync('git', ['show', `${config.baseline}:${file}`], { cwd: root, encoding: 'utf8' }) : candidate;
    for (const variant of variants) {
      const content = variant === 'baseline' ? baseline : candidate;
      files[`rules/${variant}/${file}`] = content;
      promptChars[variant] += chars(content);
    }
  }
  requireValue(promptChars.candidate <= config.maxPromptChars, `候选 Prompt 超预算：${promptChars.candidate} > ${config.maxPromptChars}`);
  for (const [name, content] of Object.entries(files)) await save(dir, name, content);
  const taskNames: string[] = [];
  for (const variant of variants) for (let repeat = 1; repeat <= config.repetitions; repeat++) {
    const task = `tasks/${variant}-${repeat}.md`;
    taskNames.push(task);
    const rules = [...config.vary, ...config.shared].map(file => `evals/experiments/${id}/rules/${variant}/${file}`);
    const inputs = cases.map(item => `## ${item.id}（${item.kind}）\n\n${item.input}\n\n输出文件：evals/experiments/${id}/outputs/${variant}/r${repeat}/${item.id}.md\n`).join('\n');
    const content = `# 固定事实文本生成\n\n模型：${config.model}；思考级别：${config.reasoning}。每个任务使用全新上下文。\n\n只读取以下生效输出规则，不读取其他实验材料：\n\n${rules.map(file => `- ${file}`).join('\n')}\n\n按规则表达下列独立案例的固定审查判断。summary 只生成总评 Markdown，finding 生成单条 finding，evidence 生成后续状态说明。不要重新审查代码、运行目标代码、访问链接、调用提交/发布工具或生成 JSON。不要读取其他生成器的输出、评判或期望答案，也不要调用其他 Agent。使用 apply_patch 写指定文件。\n\n${inputs}`;
    await save(dir, task, content);
    files[task] = content;
  }
  const generation = `# 生成任务\n\n每项派发给一个全新上下文的 ${config.model} / ${config.reasoning} Agent，仅传该任务文件。不得跨版本复用上下文。\n\n${taskNames.map(file => `- [${file}](${file})`).join('\n')}\n`;
  await save(dir, 'generation.md', generation);
  files['generation.md'] = generation;
  files['input-audit.md'] = inputAudit;
  const lock: Lock = { config, hashes: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha(content)])), promptChars };
  await save(dir, 'lock.json', pretty(lock));
  return { directory: dir, promptChars, tasks: taskNames };
}

async function frozen(root: string, id: string) {
  const dir = directory(root, id);
  const lock = await json(dir, 'lock.json') as Lock;
  const config = configOf(lock.config);
  requireValue(object(lock.hashes), '实验 lock 无效');
  requireValue(JSON.stringify(configOf(await json(dir, 'experiment.json'))) === JSON.stringify(config), '实验配置已漂移，请新开一轮');
  for (const [file, hash] of Object.entries(lock.hashes)) requireValue(sha(await read(dir, file)) === hash, `冻结输入发生漂移：${file}`);
  const cases = casesOf(await json(dir, 'cases.json'));
  let candidateChars = 0;
  for (const file of [...config.vary, ...config.shared]) candidateChars += chars(await read(dir, `rules/candidate/${file}`));
  requireValue(candidateChars <= config.maxPromptChars, '候选规则超出预算');
  return { dir, config, cases, lock };
}

export async function blind(root: string, id: string) {
  const { dir, config, cases } = await frozen(root, id);
  const outputs: Record<string, string> = {};
  for (const job of jobs(config, cases)) for (const variant of variants) {
    const file = job.output(variant);
    outputs[file] = await read(dir, file);
    requireValue(text(outputs[file]), `输出为空：${file}`);
  }
  const mappings: Record<string, Mapping> = {};
  for (let judge = 1; judge <= 3; judge++) {
    const candidate = judge % 2 === 1 ? 'X' : 'Y';
    const pairs = jobs(config, cases).map(job => ({
      id: job.id, kind: job.item.kind, input: job.item.input, expected: job.item.expected,
      X: outputs[job.output(candidate === 'X' ? 'candidate' : 'baseline')],
      Y: outputs[job.output(candidate === 'Y' ? 'candidate' : 'baseline')],
    }));
    const material = `# 匿名成对评判\n\n只评表达，不审查代码。下列 X/Y 标签不表示新旧顺序；同一份材料内标签一致。只读本文件，不读取版本映射、其他评委或源 Prompt。逐对判断是否满足要求，并给出偏好 X/Y/tie；保留具体异议，勿用冗长等同完整。\n\n${await read(dir, 'rubric.md')}\n\n## 固定事实与原始输出\n\n${pretty(pairs)}\n`;
    const packetSha256 = sha(material);
    const schema = { packetSha256, overall: 'X', cases: pairs.map(pair => ({ id: pair.id, xPass: true, yPass: false, preference: 'X', margin: 'clear', reason: '具体比较依据', concerns: [] })) };
    const packet = `${material}\n## 提交评价\n\n用 apply_patch 写 evals/experiments/${id}/judges/${judge}.json，严格使用以下 JSON 结构。示例值是占位符，不是预期评价；overall 是整组偏好。\n\n${pretty(schema)}`;
    await save(dir, `judges/${judge}.md`, packet);
    mappings[String(judge)] = { candidate, packetSha256, fileSha256: sha(packet), outputs: Object.fromEntries(Object.entries(outputs).map(([file, content]) => [file, sha(content)])) };
  }
  await save(dir, 'judges/mapping.json', pretty(mappings));
  return { judges: [1, 2, 3].map(judge => local(dir, `judges/${judge}.md`)) };
}

export async function check(root: string, id: string) {
  const { dir, config, cases, lock } = await frozen(root, id);
  const mappings = await json(dir, 'judges/mapping.json') as Record<string, Mapping>;
  const expected = jobs(config, cases).map(job => job.id);
  const tally = Object.fromEntries(expected.map(key => [key, { candidatePass: 0, candidatePreferred: 0, baselinePreferred: 0 }]));
  const votes = { candidate: 0, baseline: 0, tie: 0 };
  const concerns: { judge: number; case: string; text: string }[] = [];
  const choice = (value: unknown): value is Choice => ['X', 'Y', 'tie'].includes(String(value));
  for (let judge = 1; judge <= 3; judge++) {
    const mapping = mappings[String(judge)];
    requireValue(mapping && ['X', 'Y'].includes(mapping.candidate), `缺少评委 ${judge} 的映射`);
    for (const [file, hash] of Object.entries(mapping.outputs)) requireValue(sha(await read(dir, file)) === hash, `生成输出在评判后发生漂移：${file}`);
    const packet = await read(dir, `judges/${judge}.md`);
    requireValue(sha(packet) === mapping.fileSha256, `评判材料 ${judge} 已漂移`);
    const result = await json(dir, `judges/${judge}.json`);
    requireValue(object(result) && result.packetSha256 === mapping.packetSha256 && choice(result.overall), `评委 ${judge} 版本或偏好无效`);
    requireValue(Array.isArray(result.cases) && result.cases.length === expected.length, `评委 ${judge} 用例不完整`);
    const seen = new Set<string>();
    for (const item of result.cases) {
      requireValue(object(item) && text(item.id) && expected.includes(item.id) && !seen.has(item.id), `评委 ${judge} 用例缺失或重复`);
      seen.add(item.id);
      requireValue(typeof item.xPass === 'boolean' && typeof item.yPass === 'boolean' && choice(item.preference) && ['clear', 'slight'].includes(String(item.margin)) && text(item.reason) && Array.isArray(item.concerns) && item.concerns.every(text), `评委 ${judge} 的 ${item.id} 评价格式无效`);
      const counts = tally[item.id];
      counts.candidatePass += Number(mapping.candidate === 'X' ? item.xPass : item.yPass);
      if (item.preference === mapping.candidate) counts.candidatePreferred++;
      else if (item.preference !== 'tie') counts.baselinePreferred++;
      for (const concern of item.concerns) concerns.push({ judge, case: item.id, text: concern });
    }
    if (result.overall === 'tie') votes.tie++;
    else if (result.overall === mapping.candidate) votes.candidate++;
    else votes.baseline++;
  }
  const keep = votes.candidate >= 2 && Object.values(tally).every(item => item.candidatePass >= 2);
  return { recommendationPolicy: 'all-pass-overall-better', recommendation: keep ? 'keep' : 'revise', votes, cases: tally, concerns, promptChars: lock.promptChars };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, id, ...extra] = process.argv.slice(2);
    requireValue(id && extra.length === 0 && ['prepare', 'blind', 'check'].includes(command), '用法：evaluate.ts prepare|blind|check <experiment-id>');
    const result = command === 'prepare' ? await prepare(process.cwd(), id) : command === 'blind' ? await blind(process.cwd(), id) : await check(process.cwd(), id);
    process.stdout.write(pretty(result));
    if ('recommendation' in result && result.recommendation !== 'keep') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
