import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './schema.ts';

export function collectRightSideLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let file: string | undefined;
  let rightLine = 0;
  let inHunk = false;

  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && text.startsWith('+++ b/')) {
      file = text.slice(6);
      if (!lines.has(file)) lines.set(file, new Set());
      continue;
    }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (file && hunk) {
      rightLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk || text.startsWith('\\ No newline')) continue;
    if (text.startsWith('+')) {
      lines.get(file)?.add(rightLine++);
    } else if (text.startsWith(' ')) {
      lines.get(file)?.add(rightLine++);
    } else if (!text.startsWith('-')) {
      inHunk = false;
    }
  }
  return lines;
}

export async function validateFindingLocations(contextRoot: string, findings: Finding[]): Promise<void> {
  const changedFiles = new Set((await readFile(`${contextRoot}/changed-files.txt`, 'utf8')).split('\n').filter(Boolean));
  const rightSideLines = collectRightSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8'));
  for (const finding of findings) {
    assertRightSideRange(changedFiles, rightSideLines, finding.path, finding.startLine, finding.endLine);
  }
}

export function assertRightSideRange(
  changedFiles: Set<string>,
  rightSideLines: Map<string, Set<number>>,
  file: string,
  startLine: number,
  endLine: number,
): void {
  const normalized = path.posix.normalize(file);
  if (normalized !== file || path.posix.isAbsolute(normalized) || normalized.startsWith('../') || !changedFiles.has(normalized)) {
    throw new Error(`path is not in the current diff: ${file}`);
  }
  if (startLine > endLine) throw new Error('startLine must not exceed endLine');
  const validLines = rightSideLines.get(normalized);
  for (let line = startLine; line <= endLine; line += 1) {
    if (!validLines?.has(line)) throw new Error(`line is not on the RIGHT side of the diff: ${normalized}:${line}`);
  }
}
