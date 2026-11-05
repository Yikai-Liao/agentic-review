import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewResult } from './review-result.ts';

const exec = promisify(execFile);

// 新问题随总评在一次 Review 中发布，任一行号落在 PR diff 之外都会让整条 Review 被 GitHub 拒绝；
// 提交时按与 GitHub 相同的三行上下文和改名识别核对，让模型在发布前修正位置。
export function commentableRanges(diff: string) {
  const ranges = new Map<string, Array<[number, number]>>();
  let current: Array<[number, number]> | undefined;
  // 文件头只出现在 hunk 之前；hunk 内以 `++ ` 开头的新增内容同样显示为 `+++ `，不能当作新文件。
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { current = undefined; inHunk = false; }
    else if (!inHunk && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '').replace(/^"(.*)"$/, '$1');
      current = name === '/dev/null' ? undefined : [];
      if (current) ranges.set(name.replace(/^b\//, ''), current);
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
      if (!current) continue;
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new Error(`Invalid diff hunk: ${line}`);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count > 0) current.push([start, start + count - 1]);
    }
  }
  return ranges;
}

export async function validateCommentLines(target: string, start: string, end: string, comments: ReviewResult['comments']) {
  const anchored = comments.filter(comment => comment.line !== null);
  if (!anchored.length) return;
  const { stdout } = await exec('git', ['-C', target, '-c', 'core.quotePath=false', '--no-pager', 'diff', '--no-ext-diff',
    '--no-textconv', '-M', '--unified=3', `${start}..${end}`], { encoding: 'utf8', maxBuffer: Infinity });
  const ranges = commentableRanges(stdout);
  for (const comment of anchored) {
    const line = comment.line!;
    const first = comment.start_line ?? line;
    const file = ranges.get(comment.path);
    if (file?.some(([low, high]) => low <= first && line <= high)) continue;
    const position = `${comment.path}:${comment.start_line === null ? '' : `${comment.start_line}-`}${line}`;
    throw new Error(`Review comment ${position} is outside the PR diff. ${file?.length
      ? `Commentable line ranges in this file: ${file.map(([low, high]) => `${low}-${high}`).join(', ')}; a multi-line comment must stay within one range.`
      : 'This file has no commentable lines in the PR diff; anchor the finding to a changed line, or use line: null to place it in the summary.'}`);
  }
}
