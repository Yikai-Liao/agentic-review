import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listTargetSkills } from '../scripts/list-target-skills.ts';

async function skill(root: string, relative: string, frontmatter: string): Promise<void> {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Skill\n`);
}

test('catalogs target project skills without exposing agentic-review', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'target-skills-'));
  const target = path.join(directory, 'target');
  const outside = path.join(directory, 'outside');
  try {
    await skill(target, '.agents/skills/agentic-review', 'name: agentic-review');
    await skill(target, '.agents/skills/domain-rules', 'name: domain-rules');
    await skill(target, '.agents/skills/invalid', 'description: missing name');
    await skill(target, '.pi/skills/quoted', "name: 'quoted-skill'");
    await skill(target, '.git/history', 'name: hidden-history');
    await mkdir(outside);
    await symlink(outside, path.join(target, '.agents/skills/escape'));
    await symlink('../../.git', path.join(target, '.agents/skills/repository'));
    await symlink('../../.agents/skills/domain-rules', path.join(target, '.pi/skills/domain-rules'));

    assert.deepEqual(await listTargetSkills(target), {
      skills: [
        { name: 'domain-rules', path: '.agents/skills/domain-rules/SKILL.md' },
        { name: 'quoted-skill', path: '.pi/skills/quoted/SKILL.md' },
      ],
      ignored: [
        { path: '.agents/skills/agentic-review/SKILL.md', reason: 'agentic-review' },
        { path: '.agents/skills/escape', reason: 'outside-skill-roots' },
        { path: '.agents/skills/invalid/SKILL.md', reason: 'invalid' },
        { path: '.agents/skills/repository', reason: 'outside-skill-roots' },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
