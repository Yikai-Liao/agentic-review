import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type TargetSkillCatalog = {
  skills: Array<{ name: string; path: string }>;
  ignored: Array<{ path: string; reason: 'agentic-review' | 'invalid' | 'outside-target' }>;
};

const skillRoots = ['.agents/skills', '.pi/skills'];

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function skillName(content: string): string | undefined {
  const normalized = content.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return undefined;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return undefined;
  const match = normalized.slice(4, end).match(/^name:\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*$/m);
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  return name && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
}

export async function listTargetSkills(targetPath: string): Promise<TargetSkillCatalog> {
  const target = await realpath(targetPath);
  const catalog: TargetSkillCatalog = { skills: [], ignored: [] };
  const seenDirectories = new Set<string>();
  const seenFiles = new Set<string>();

  async function walk(logicalDirectory: string): Promise<void> {
    let directory: string;
    try {
      directory = await realpath(logicalDirectory);
    } catch {
      return;
    }
    if (!inside(target, directory)) {
      catalog.ignored.push({ path: path.relative(target, logicalDirectory), reason: 'outside-target' });
      return;
    }
    if (seenDirectories.has(directory)) return;
    seenDirectories.add(directory);

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const logicalPath = path.join(logicalDirectory, entry.name);
      let info;
      try {
        info = entry.isSymbolicLink() ? await stat(logicalPath) : entry;
      } catch {
        catalog.ignored.push({ path: path.relative(target, logicalPath), reason: 'invalid' });
        continue;
      }
      if (info.isDirectory()) {
        await walk(logicalPath);
        continue;
      }
      if (!info.isFile() || entry.name !== 'SKILL.md') continue;

      const file = await realpath(logicalPath);
      const relative = path.relative(target, logicalPath).split(path.sep).join('/');
      if (!inside(target, file)) {
        catalog.ignored.push({ path: relative, reason: 'outside-target' });
        continue;
      }
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      const name = skillName(await readFile(file, 'utf8'));
      if (!name) catalog.ignored.push({ path: relative, reason: 'invalid' });
      else if (name === 'agentic-review') catalog.ignored.push({ path: relative, reason: 'agentic-review' });
      else catalog.skills.push({ name, path: relative });
    }
  }

  for (const root of skillRoots) await walk(path.join(target, root));
  catalog.skills.sort((a, b) => a.path.localeCompare(b.path));
  catalog.ignored.sort((a, b) => a.path.localeCompare(b.path));
  return catalog;
}

async function main(): Promise<void> {
  const target = process.env.REVIEW_TARGET_PATH;
  const output = process.env.REVIEW_TARGET_SKILLS_PATH;
  if (!target || !path.isAbsolute(target) || !output || !path.isAbsolute(output)) {
    throw new Error('REVIEW_TARGET_PATH and REVIEW_TARGET_SKILLS_PATH must be absolute paths');
  }
  await writeFile(output, `${JSON.stringify(await listTargetSkills(target), null, 2)}\n`, { mode: 0o600 });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
