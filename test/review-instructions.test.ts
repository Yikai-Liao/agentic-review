import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseReviewResult } from '../scripts/review-result.ts';
import { loadReviewPrompt } from '../scripts/load-review-prompt.ts';

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

test('preload matches compaction recovery, default code methods are preloaded, and missing rules fail loading', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const relative of ['central', 'skills/agentic-review']) {
    await cp(path.join(root, relative), path.join(directory, 'control', relative), { recursive: true });
  }
  const assembled = await loadReviewPrompt(path.join(directory, 'control'));
  const loaded = [...assembled.matchAll(/^## control\/(.+)$/gm)].map(match => match[1]);
  const prompt = await read('central/review-rules.md');
  const recovery = prompt.split('\n').find(line => line.startsWith('This entry preloads'))!;
  const restored = [...recovery.matchAll(/`((?:skills\/|references\/|central\/)[^`]+\.md)`/g)]
    .flatMap(match => expandBraces(match[1].startsWith('references/') ? skill + match[1] : match[1]));
  assert.deepEqual(loaded.slice(0, restored.length), restored);
  assert.deepEqual(restored, [
    `${skill}SKILL.md`, ...['protocol', 'findings', 'review-state', 'evidence-access', 'reporting'].map(name => `${skill}references/${name}.md`),
    'central/github-context.md', 'central/review-result.md',
  ]);
  assert.ok(assembled.includes(await read('central/review-result.md')));
  assert.deepEqual(loaded.slice(restored.length), [
    `${skill}references/levels/code.md`,
    ...['alignment', 'security', 'reliability', 'performance'].map(name => `${skill}references/focuses/${name}.md`),
    ...['behavior', 'test-contracts'].map(name => `${skill}references/levels/code/${name}.md`),
  ]);
  assert.ok(!loaded.some(file => /references\/levels\/(requirements|architecture|plan)\.md|report-examples/.test(file)));
  for (const level of ['requirements', 'architecture', 'plan', 'code']) await read(`${skill}references/levels/${level}.md`);
  for (const match of prompt.matchAll(/\breferences\/[\w/-]+\.md/g)) await read(skill + match[0]);
  await rm(path.join(directory, 'control', skill, 'references/protocol.md'));
  await assert.rejects(loadReviewPrompt(path.join(directory, 'control')), /ENOENT/);
});

test('central adapters load the known-issue rules, whose classes do not replace finding closing conditions', async () => {
  const relative = `${skill}references/known-issues.md`;
  const rules = await read(relative);
  assert.ok((await read(`${skill}SKILL.md`)).includes('(references/known-issues.md)'));
  assert.ok((await read(`${skill}references/protocol.md`)).includes('(known-issues.md)'));
  for (const adapter of ['central/github-context.md', 'central/lark-context.md']) {
    assert.ok((await read(adapter)).includes(`read \`$REVIEW_CONTROL_PATH/${relative}\` in full`), adapter);
  }
  const classes = [...rules.matchAll(/^\| ([^|]+) \|/gm)].map(match => match[1].trim());
  assert.deepEqual(classes, ['Class', 'Planned', 'Confirmed / accepted', 'Fixed', 'Unresolved', 'Unknown']);
  assert.ok(rules.includes('(review-state.md#evidence-for-status-changes)'));
  assert.ok(rules.includes('(findings.md#output)'));
  // Guards only the loading and responsibility contract, not model behavior.
});

test('the code level keeps the default duties and central keeps the level entry and test branches', async () => {
  const prompt = await read('central/review-rules.md');
  const code = await read(`${skill}references/levels/code.md`);
  const duties = [...code.matchAll(/^\| ([^|-][^|]*) \| .+ \| .+ \|$/gm)].map(match => match[1].trim());
  assert.deepEqual(duties.slice(0, 6), ['Duty', 'Behavior and intent', 'Security boundaries',
    'Reliability and recovery', 'Performance and resource cost', 'Test validity']);
  assert.ok(code.includes('Choosing code alone does not start an independent requirements, architecture, or plan review'));
  assert.match(prompt, /The default level is code/);
  const testReview = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map(match => JSON.parse(match[1])).find(config => config.test_review)?.test_review;
  assert.deepEqual(testReview, { default: ['T1'], explicit_request_only: ['T2'], excluded: ['test_economics'] });
  assert.ok(prompt.includes('run only the branches selected here'));
  assert.ok(prompt.includes('Head `.agentic-review.md`'));
  assert.ok(prompt.includes('Head `AGENTS.md`'));
  assert.ok(prompt.includes('references/levels/<level>.md'));
});

test('local links in the skill package and maintained docs resolve, and the package stays self-contained', async () => {
  const runtime = await markdownFiles('skills/agentic-review');
  const documents = ['README.md', 'AGENTS.md', '.agentic-review.md', 'worker/README.md', ...runtime,
    ...await markdownFiles('central'), ...await markdownFiles('docs')];
  assert.deepEqual(runtime.filter(file => file.endsWith('/SKILL.md')), [`${skill}SKILL.md`]);
  for (const file of documents) {
    const source = await read(file);
    for (const match of prose(source).replace(/`[^`\n]*`/g, '').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const url = match[1];
      if (/^[a-z][\w+.-]*:|^\/\//i.test(url)) continue;
      const [target, anchor] = url.split('#');
      const resolved = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target))) : file;
      assert.ok(!resolved.startsWith('../') && !path.isAbsolute(resolved), `${file}: ${url}`);
      if (file.startsWith(skill)) assert.ok(resolved.startsWith(skill), `link leaves the package: ${file}: ${url}`);
      await stat(path.join(root, resolved));
      if (anchor && resolved.endsWith('.md')) assert.ok(headingAnchors(await read(resolved)).has(decodeURIComponent(anchor)), `broken anchor: ${file}: ${url}`);
    }
  }
});

test('central JSON examples pass the production schema and report wording lives in the skill', async () => {
  const result = await read('central/review-result.md');
  const parsed = [...result.matchAll(/```json\n([\s\S]*?)\n```/g)].map(example => parseReviewResult(example[1]));
  assert.ok(parsed.some(example => example.request_reply !== null), 'has a thread reply example');
  assert.ok(parsed.some(example => example.request_reply === null && example.comments.length === 0), 'has a body-only example');
  assert.ok(parsed.some(example => example.thread_updates.length > 0), 'has a thread update example');
  assert.ok(parsed.some(example => example.comments.length > 0));
  // The publisher generates the title and index, so example bodies start with the verdict.
  assert.ok(parsed.every(example => !example.body.startsWith('#')));
  assert.ok(result.includes('Before the wrap-up notice, `submit_review` requires all in-scope coverage to be complete'));
  assert.ok(result.includes('Do not create a separate `review.md` index'));
  const reporting = await read(`${skill}references/reporting.md`);
  for (const heading of ['## Summary', '## Findings', '## Status Reasons for Earlier Findings', '## Final Self-Check']) {
    assert.ok(reporting.includes(heading), heading);
  }
});
