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
