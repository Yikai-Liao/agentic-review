import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { get_encoding } from 'tiktoken';

const tokenizer = get_encoding('o200k_base');
export const countTokens = (text: string) => tokenizer.encode(text, [], []).length;

export type ReviewMaterial = {
  kind: 'request' | 'rules' | 'metadata' | 'changes' | 'discussion' | 'workspace' | 'associations';
  title: string;
  // Controls only default preload order; reference stays in the index for the agent to read as the investigation needs.
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
  const indexText = readFileSync(file, 'utf8');
  const index: ReviewInputIndex = JSON.parse(indexText);
  // The index shares the budget with other material; ordinary input delivers navigation directly, and a large index keeps its file entry.
  const materials: ReviewInputIndex['materials'] = [
    { kind: 'metadata', title: 'Review input index', use: 'context', path: file, tokens: countTokens(indexText) },
    ...index.materials,
  ];
  const totals = new Map<string, { tokens: number; count: number; candidates: number }>();
  for (const material of materials) {
    const total = totals.get(material.kind) ?? { tokens: 0, count: 0, candidates: 0 };
    total.tokens += material.tokens;
    total.count++;
    if (material.use !== 'reference') total.candidates += material.tokens;
    totals.set(material.kind, total);
  }
  const header = [
    '# Review Materials', '', `Full material index: \`${file}\`. Each entry gives category, token count, original path, and code location.`,
    'Use the delivered material below directly; start investigating from known code locations and choose other material by this round\'s scope, contracts, and suspicions.', '',
    '| Category | Materials | All tokens | Default candidate tokens |', '| --- | ---: | ---: | ---: |',
    ...[...totals].map(([kind, total]) => `| ${kind} | ${total.count} | ${total.tokens} | ${total.candidates} |`), '',
  ].join('\n');
  // Startup uses at most half the window, leaving room for maximum output and another 10% for investigation.
  const limit = Math.min(Math.floor(contextWindow / 2), contextWindow - maxTokens - Math.ceil(contextWindow / 10));
  const headerTokens = countTokens(header);
  const available = limit - countTokens(JSON.stringify(fixedContext)) - headerTokens;
  if (available < 0) throw new Error('Fixed review context exceeds the startup context budget');
  const rank = { request: 0, context: 1, changes: 1, discussion: 2, reference: 3 };
  const candidates = materials.filter(material => material.use !== 'reference')
    .sort((a, b) => rank[a.use] - rank[b.use] || a.tokens - b.tokens);
  let remaining = available;
  const selected: string[] = [];
  for (const material of candidates) {
    const title = `\n## ${JSON.stringify(material.title)}\n\nSource: \`${material.path}\`\n\n`;
    if (material.tokens + countTokens(title) > remaining) continue;
    const source = readFileSync(material.path, 'utf8');
    let fenceLength = 3;
    for (const match of source.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    const content = `${title}${fence}text\n${source}\n${fence}\n`;
    const tokens = countTokens(content);
    if (tokens <= remaining) { selected.push(content); remaining -= tokens; }
  }
  // Recheck the boundary on the actual concatenation; BPE tokenization at block joins may differ slightly from separate counts.
  while (selected.length && countTokens(header + selected.join('')) > available + headerTokens) selected.pop();
  return header + selected.join('');
}
