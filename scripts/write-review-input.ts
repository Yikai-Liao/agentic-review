import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { get_encoding } from 'tiktoken';

const tokenizer = get_encoding('o200k_base');
export const countTokens = (text: string) => tokenizer.encode(text, [], []).length;

export type ReviewMaterial = {
  kind: 'request' | 'rules' | 'metadata' | 'changes' | 'discussion' | 'workspace' | 'associations';
  title: string;
  // 只控制默认预载顺序；reference 保留在索引中，由 Agent 按调查需要读取。
  use: 'request' | 'context' | 'changes' | 'discussion' | 'reference';
  content: string;
  location?: string;
};
export type ReviewInputIndex = {
  tokenizer: 'o200k_base';
  materials: Array<Omit<ReviewMaterial, 'content'> & { path: string; tokens: number }>;
};

export function writeReviewInput(file: string, materials: ReviewMaterial[]) {
  const directory = `${file}.materials`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index: ReviewInputIndex = { tokenizer: 'o200k_base', materials: materials.map(({ content, ...material }, position) => {
    const source = path.join(directory, `${position + 1}.md`);
    writeFileSync(source, content, { mode: 0o600 });
    return { ...material, path: source, tokens: countTokens(content) };
  }) };
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

export function reviewInputContext(file: string, model: { contextWindow: number; maxTokens: number }, fixedContext: unknown) {
  const { contextWindow, maxTokens } = model;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('Invalid review model limits');
  }
  const index: ReviewInputIndex = JSON.parse(readFileSync(file, 'utf8'));
  const totals = new Map<string, { tokens: number; count: number; candidates: number }>();
  for (const material of index.materials) {
    const total = totals.get(material.kind) ?? { tokens: 0, count: 0, candidates: 0 };
    total.tokens += material.tokens;
    total.count++;
    if (material.use !== 'reference') total.candidates += material.tokens;
    totals.set(material.kind, total);
  }
  const header = [
    '# 审查材料', '', `完整材料索引：\`${file}\`。各条目提供类别、Token 数、原文路径和代码位置。`,
    '下列原文已预载；其余材料按本轮范围、契约和疑点从索引选择。', '',
    '| 类别 | 材料数 | 全部 Token | 默认候选 Token |', '| --- | ---: | ---: | ---: |',
    ...[...totals].map(([kind, total]) => `| ${kind} | ${total.count} | ${total.tokens} | ${total.candidates} |`), '',
  ].join('\n');
  // 启动最多使用半个窗口，同时为最大输出与额外 10% 的调查空间留位。
  const limit = Math.min(Math.floor(contextWindow / 2), contextWindow - maxTokens - Math.ceil(contextWindow / 10));
  const headerTokens = countTokens(header);
  const available = limit - countTokens(JSON.stringify(fixedContext)) - headerTokens;
  if (available < 0) throw new Error('Fixed review context exceeds the startup context budget');
  const rank = { request: 0, context: 1, changes: 1, discussion: 2, reference: 3 };
  const candidates = index.materials.filter(material => material.use !== 'reference')
    .sort((a, b) => rank[a.use] - rank[b.use] || a.tokens - b.tokens);
  let remaining = available;
  const selected: string[] = [];
  for (const material of candidates) {
    const title = `\n## ${JSON.stringify(material.title)}\n\n原文：\`${material.path}\`\n\n`;
    if (material.tokens + countTokens(title) > remaining) continue;
    const source = readFileSync(material.path, 'utf8');
    let fenceLength = 3;
    for (const match of source.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    const content = `${title}${fence}text\n${source}\n${fence}\n`;
    const tokens = countTokens(content);
    if (tokens <= remaining) { selected.push(content); remaining -= tokens; }
  }
  // 按实际拼接结果复核边界；不同块连接处的 BPE 分词可能与独立计数略有差异。
  while (selected.length && countTokens(header + selected.join('')) > available + headerTokens) selected.pop();
  return header + selected.join('');
}
