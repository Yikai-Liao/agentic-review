import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewResult } from './review-result.ts';

const exec = promisify(execFile);

// New findings are published with the summary in one review, and GitHub rejects the whole review if any line
// falls outside the PR diff; submission checks lines with GitHub's three-line context and rename detection so
// the model can fix positions before publication.
export function commentableRanges(diff: string) {
  const ranges = new Map<string, Array<[number, number]>>();
  let current: Array<[number, number]> | undefined;
  // File headers appear only before hunks; an added line starting with `++ ` inside a hunk also shows as `+++ ` and is not a new file.
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

// Git C-quotes paths with double quotes, backslashes, or control characters; octal escapes decode as bytes.
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
  // File-level discussions attach only to files changed by the PR, including deleted, renamed, and binary files.
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
