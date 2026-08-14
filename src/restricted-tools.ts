import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

type ReviewTool = ToolDefinition<any, any>;

export async function createRestrictedReadTools(cwd: string, allowedRoots: string[]): Promise<ReviewTool[]> {
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));

  async function allowedPath(requested: unknown): Promise<string> {
    if (typeof requested !== 'string') throw new Error('tool path must be a string');
    const target = await realpath(path.resolve(cwd, normalizeToolPath(requested)));
    if (!roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) {
      throw new Error(`tool path is outside the review sandbox: ${requested}`);
    }
    return target;
  }

  function assertSafeGlob(pattern: unknown): void {
    if (typeof pattern !== 'string' || path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
      throw new Error('tool glob must stay inside the review sandbox');
    }
  }

  return [
    restrict(createReadTool(cwd), 'review_read', async (params) => {
      params.path = await allowedPath(params.path);
    }),
    restrict(createGrepTool(cwd), 'review_grep', async (params) => {
      params.path = await allowedPath(params.path ?? '.');
      if (params.glob !== undefined) assertSafeGlob(params.glob);
    }),
    restrict(createFindTool(cwd), 'review_find', async (params) => {
      params.path = await allowedPath(params.path ?? '.');
      assertSafeGlob(params.pattern);
    }),
    restrict(createLsTool(cwd), 'review_ls', async (params) => {
      params.path = await allowedPath(params.path ?? '.');
    }),
  ];
}

function normalizeToolPath(input: string): string {
  let normalized = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/')) return path.join(homedir(), normalized.slice(2));
  if (normalized.startsWith('file://')) return fileURLToPath(normalized);
  return normalized;
}

function restrict(tool: ReviewTool, name: string, validate: (params: Record<string, unknown>) => Promise<void>): ReviewTool {
  const execute: ReviewTool['execute'] = async (id, params, signal, onUpdate, context) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('tool parameters must be an object');
    await validate(params as Record<string, unknown>);
    return tool.execute(id, params, signal, onUpdate, context);
  };
  return { ...tool, name, execute };
}
