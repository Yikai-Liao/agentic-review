import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseReviewResult } from '../scripts/review-result.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = 'skills/agentic-review/';
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

function expandBraces(value: string): string[] {
  const match = value.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  return match ? match[2].split(',').map(part => `${match[1]}${part}${match[3]}`) : [value];
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(relative) : Promise.resolve(entry.name.endsWith('.md') ? [relative] : []);
  }));
  return nested.flat();
}

function prose(source: string): string {
  return source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function headingAnchors(source: string): Set<string> {
  return new Set([...prose(source).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1]
    .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-')));
}

test('真实中央预载与 compaction 恢复集合一致，缺规则时加载失败', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const relative of ['central', 'skills/agentic-review']) {
    await cp(path.join(root, relative), path.join(directory, 'control', relative), { recursive: true });
  }
  const workflow = await read('.github/workflows/review-execution.yml');
  const block = workflow.split('      - name: Load review prompt\n')[1].split('\n      - name:')[0];
  const script = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const output = path.join(directory, 'prompt-output');
  const options = { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output }, stdio: 'pipe' as const };
  execFileSync('bash', ['-e', '-c', script], options);
  const assembled = await readFile(output, 'utf8');
  const loaded = [...assembled.matchAll(/^## control\/(.+)$/gm)].map(match => match[1]);
  const prompt = await read('central/review-rules.md');
  const recovery = prompt.split('\n').find(line => line.startsWith('本入口已预载'))!;
  const restored = [...recovery.matchAll(/`((?:skills\/|references\/|central\/)[^`]+\.md)`/g)]
    .flatMap(match => expandBraces(match[1].startsWith('references/') ? skill + match[1] : match[1]));
  assert.deepEqual(loaded, restored);
  assert.deepEqual(loaded, [
    `${skill}SKILL.md`, ...['protocol', 'findings', 'review-state', 'evidence-access'].map(name => `${skill}references/${name}.md`),
    'central/github-context.md', 'central/review-result.md',
  ]);
  assert.ok(assembled.includes(await read('central/review-result.md')));
  assert.ok(!loaded.some(file => /references\/levels\/|evals/.test(file)));
  for (const level of ['requirements', 'architecture', 'plan', 'code']) await read(`${skill}references/levels/${level}.md`);
  for (const match of prompt.matchAll(/\breferences\/[\w/-]+\.md/g)) await read(skill + match[0]);
  await rm(path.join(directory, 'control', skill, 'references/protocol.md'));
  assert.throws(() => execFileSync('bash', ['-e', '-c', script], options));
});

test('关联记录规则由可信中央入口按需加载，分类不替代 finding 关闭条件', async () => {
  const relative = `${skill}references/known-issues.md`;
  const rules = await read(relative);
  const entry = await read(`${skill}SKILL.md`);
  const protocol = await read(`${skill}references/protocol.md`);
  assert.ok(entry.includes('(references/known-issues.md)'));
  assert.ok(protocol.includes('(known-issues.md)'));
  for (const adapter of ['central/github-context.md', 'central/lark-context.md']) {
    const source = await read(adapter);
    assert.ok(source.includes(`完整读取 \`$REVIEW_CONTROL_PATH/${relative}\``), adapter);
  }
  const categories = [...rules.matchAll(/^\| ([^|]+) \|/gm)].map(match => match[1].trim());
  assert.deepEqual(categories, ['分类', '计划中', '已确认 / 已接受', '已修复', '未解决', '状态不明']);
  assert.ok(rules.includes('(review-state.md#状态变更需要什么证据)'));
  assert.ok(rules.includes('(findings.md#输出)'));
  assert.ok(rules.includes('记录中的触发条件或状态，怎样连接到当前修改，再怎样影响数据、接口、使用方或验收结果'));
  assert.ok(rules.includes('当前变化扩大影响、使原保护或接受前提失效，或重新引入问题'));
  // 只防止加载/职责契约再次丢失；语义正反例在 C09/C10，不声称模型已通过。
});

test('中央默认测试审查仅选择 T1，T2 过约束须明确委托，项目规则可以覆盖层级', async () => {
  const prompt = await read('central/review-rules.md');
  assert.match(prompt, /level = code/);
  const focuses = [...prompt.matchAll(/^\d\. ([^：]+)：/gm)].map(match => match[1]);
  assert.deepEqual(focuses, ['行为与意图对齐', '安全边界', '可靠性与恢复', '性能与资源成本', '测试有效性']);
  const testDuty = prompt.split('5. 测试有效性：')[1].split('\n\n')[0];
  assert.ok(testDuty.includes('T1'));
  assert.ok(!testDuty.includes('T2'));
  assert.ok(prompt.includes('默认测试审查仅执行 T1 失真分支；T2 过约束仅在本轮请求明确委托时调查'));
  assert.match(prompt, /测试经济性（零边际检测、冗余比较及删除证明）不在本入口范围内/);
  assert.ok(prompt.includes('仅执行本入口选定的分支'));
  assert.ok(prompt.includes('不自动启动独立的需求、架构或计划审查'));
  assert.ok(prompt.includes('不默认追加可维护性/风格/架构偏好专项或验证充分性审计'));
  assert.ok(prompt.includes('Head `.agentic-review.md`'));
  assert.ok(prompt.includes('Head `AGENTS.md`'));
  assert.ok(prompt.includes('references/levels/<level>.md'));
  assert.ok(!/沿用原有默认|旧有默认侧重点/.test(prompt));
  // 仅校验调用契约文字，不把字符串出现当作模型行为已通过。
});

test('安装包及当前维护文档的本地链接闭合，运行包不依赖仓库外规则', async () => {
  const runtime = await markdownFiles('skills/agentic-review');
  const documents = ['README.md', 'AGENTS.md', ...runtime, ...await markdownFiles('central'), ...await markdownFiles('docs'), 'evals/README.md', 'evals/generalized-review/README.md'];
  assert.deepEqual(runtime.filter(file => file.endsWith('/SKILL.md')), [`${skill}SKILL.md`]);
  for (const file of documents) {
    const source = await read(file);
    for (const match of prose(source).replace(/`[^`\n]*`/g, '').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const url = match[1];
      if (/^[a-z][\w+.-]*:|^\/\//i.test(url)) continue;
      const [target, anchor] = url.split('#');
      const resolved = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target))) : file;
      assert.ok(!resolved.startsWith('../') && !path.isAbsolute(resolved), `${file}: ${url}`);
      if (file.startsWith(skill)) assert.ok(resolved.startsWith(skill), `运行包越界: ${file}: ${url}`);
      await stat(path.join(root, resolved));
      if (anchor && resolved.endsWith('.md')) assert.ok(headingAnchors(await read(resolved)).has(decodeURIComponent(anchor)), `失效 anchor: ${file}: ${url}`);
    }
  }
});

test('中央 JSON 示例仍通过生产 schema，表达模板只由中央适配器定义', async () => {
  const result = await read('central/review-result.md');
  const examples = [...result.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(examples.length, 4);
  const parsed = examples.map(example => parseReviewResult(example[1]));
  assert.ok(parsed.some(example => example.body.startsWith('## 自动审查') && example.comments.length > 0));
  assert.ok(result.includes('## Review 正文'));
  assert.ok(result.includes('## Finding 内容'));
  assert.ok(result.includes('恰好三段'));
  assert.ok(result.includes('中央提交要求全部 scope 内覆盖完成'));
  assert.ok(result.includes('不另建 `review.md` 索引'));
  const findings = await read(`${skill}references/findings.md`);
  assert.ok(!findings.includes('## Finding 内容'));
  assert.ok(!findings.includes('恰好三段'));
});

test('通用化案例的输入和预期分离且完整，不进入中央预载', async () => {
  const index = JSON.parse(await read('evals/generalized-review/cases.json'));
  const gold = JSON.parse(await read('evals/generalized-review/expectations.json'));
  const ids = index.cases.map((item: { id: string }) => item.id).sort();
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(ids, gold.expectations.map((item: { id: string }) => item.id).sort());
  assert.equal(gold.kind, 'evaluation_criteria_not_results');
  for (const item of index.cases) {
    assert.ok(item.input.startsWith('evals/generalized-review/inputs/'));
    const input = await read(item.input);
    assert.ok(input.length > 200);
    assert.ok(!input.includes('expectations.json'));
  }
});
