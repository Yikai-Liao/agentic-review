import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './schema.ts';

export type DiffSide = 'LEFT' | 'RIGHT';
export type DiffSideLines = Record<DiffSide, Map<string, Set<number>>>;

export function collectDiffSideLines(diff: string): DiffSideLines {
  const lines: DiffSideLines = { LEFT: new Map(), RIGHT: new Map() };
  let oldFile: string | undefined;
  let file: string | undefined;
  let leftLine = 0;
  let rightLine = 0;
  let inHunk = false;

  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      oldFile = undefined;
      file = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && text.startsWith('--- a/')) {
      oldFile = text.slice(6);
      continue;
    }
    if (!inHunk && text.startsWith('+++ ')) {
      file = text.startsWith('+++ b/') ? text.slice(6) : oldFile;
      if (file) {
        if (!lines.LEFT.has(file)) lines.LEFT.set(file, new Set());
        if (!lines.RIGHT.has(file)) lines.RIGHT.set(file, new Set());
      }
      continue;
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (file && hunk) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk || text.startsWith('\\ No newline')) continue;
    if (text.startsWith('+')) {
      lines.RIGHT.get(file)?.add(rightLine++);
    } else if (text.startsWith('-')) {
      lines.LEFT.get(file)?.add(leftLine++);
    } else if (text.startsWith(' ')) {
      lines.RIGHT.get(file)?.add(rightLine);
      leftLine++;
      rightLine++;
    } else {
      inHunk = false;
    }
  }
  return lines;
}

export function collectRightSideLines(diff: string): Map<string, Set<number>> {
  return collectDiffSideLines(diff).RIGHT;
}

export async function validateFindingLocations(contextRoot: string, findings: Finding[]): Promise<void> {
  const changedFiles = new Set((await readFile(`${contextRoot}/changed-files.txt`, 'utf8')).split('\n').filter(Boolean));
  const sideLines = collectDiffSideLines(await readFile(`${contextRoot}/pr.diff`, 'utf8'));
  for (const finding of findings) {
    assertDiffRange(changedFiles, sideLines, finding.path, finding.side, finding.startLine, finding.endLine);
  }
}

export function assertDiffRange(
  changedFiles: Set<string>,
  sideLines: DiffSideLines,
  file: string,
  side: DiffSide,
  startLine: number,
  endLine: number,
): void {
  const normalized = path.posix.normalize(file);
  if (normalized !== file || path.posix.isAbsolute(normalized) || normalized.startsWith('../') || !changedFiles.has(normalized)) {
    throw new Error(`path is not in the current diff: ${file}`);
  }
  if (startLine > endLine) throw new Error('startLine must not exceed endLine');
  const validLines = sideLines[side].get(normalized);
  for (let line = startLine; line <= endLine; line += 1) {
    if (!validLines?.has(line)) throw new Error(`line is not on the ${side} side of the diff: ${normalized}:${line}`);
  }
}
