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
      const name = unquotePath(line.slice(4).replace(/\t$/, ''));
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

// Git 对含双引号、反斜杠或控制字符的路径使用 C 风格引号，八进制转义按字节还原。
export function unquotePath(name: string) {
  if (!name.startsWith('"')) return name;
  if (name.length < 2 || !name.endsWith('"')) throw new Error(`Invalid quoted diff path: ${name}`);
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const chunks: Buffer[] = [];
  for (const [token, escape] of name.slice(1, -1).matchAll(/\\([0-7]{3}|[abtnvfr"\\])|[^\\]+|\\/g)) {
    if (escape === undefined && token === '\\') throw new Error(`Invalid quoted diff path: ${name}`);
    chunks.push(escape === undefined ? Buffer.from(token, 'utf8')
      : Buffer.from([/^[0-7]{3}$/.test(escape) ? parseInt(escape, 8) : escapes[escape]]));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function validateCommentLines(target: string, start: string, end: string, comments: ReviewResult['comments']) {
  if (!comments.length) return;
  const git = (...args: string[]) => exec('git', ['-C', target, '-c', 'core.quotePath=false', '--no-pager', 'diff', '--no-ext-diff',
    '--no-textconv', '-M', ...args, `${start}..${end}`], { encoding: 'utf8', maxBuffer: Infinity });
  // 文件级讨论只能挂在 PR 改动的文件上，包括删除、改名和二进制文件。
  if (comments.some(comment => comment.line === null)) {
    const files = new Set((await git('--name-only', '-z')).stdout.split('\0').filter(Boolean));
    const outside = comments.find(comment => comment.line === null && !files.has(comment.path));
    if (outside) {
      throw new Error(`Review comment ${outside.path} is not changed in the PR; attach a file-level finding to the most related changed file and name the affected file in its body.`);
    }
  }
  const anchored = comments.filter(comment => comment.line !== null);
  if (!anchored.length) return;
  const ranges = commentableRanges((await git('--unified=3')).stdout);
  for (const comment of anchored) {
    const line = comment.line!;
    const first = comment.start_line ?? line;
    const file = ranges.get(comment.path);
    if (file?.some(([low, high]) => low <= first && line <= high)) continue;
    const position = `${comment.path}:${comment.start_line === null ? '' : `${comment.start_line}-`}${line}`;
    throw new Error(`Review comment ${position} is outside the PR diff. ${file?.length
      ? `Commentable line ranges in this file: ${file.map(([low, high]) => `${low}-${high}`).join(', ')}; a multi-line comment must stay within one range.`
      : 'This file has no commentable lines in the PR diff; anchor the finding to a changed line, or use line: null for a file-level finding.'}`);
  }
}
