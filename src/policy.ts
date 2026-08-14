import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function materializeBasePolicy(contextRoot: string, policyRoot: string): Promise<void> {
  const normalized = path.posix.normalize(policyRoot);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('policy root must stay inside the repository');
  }
  const source = path.join(contextRoot, 'base', normalized);
  try {
    if (!(await stat(source)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const destination = path.join(contextRoot, 'policy');
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
}
