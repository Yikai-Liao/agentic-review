import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { parse } from 'yaml';

const agentId = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' });
const reservedPromptIds = new Set(['aggregator', 'benchmark-judge']);
const configurationSchema = Type.Object({
  overviewAgent: agentId,
  reviewAgents: Type.Array(Type.Object({
    id: agentId,
    required: Type.Boolean(),
    instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
}, { additionalProperties: false });

export type ReviewConfiguration = Static<typeof configurationSchema>;
export type ReviewAgent = ReviewConfiguration['reviewAgents'][number];
const validator = Compile(configurationSchema);

export async function loadReviewAgents(
  engineRoot: string,
  repositoryConfigPath?: string,
  defaultConfigPath = path.join(engineRoot, '.agentic-review.yml'),
): Promise<ReviewConfiguration> {
  const repositoryConfiguration = repositoryConfigPath
    ? await loadConfiguration(repositoryConfigPath, true)
    : undefined;
  const configuration = repositoryConfiguration ?? await loadConfiguration(defaultConfigPath);
  if (!configuration) throw new Error('Missing trusted default .agentic-review.yml');
  const ids = configuration.reviewAgents.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Review Agent id in .agentic-review.yml');
  const overviewAgent = configuration.reviewAgents.find(({ id }) => id === configuration.overviewAgent);
  if (!overviewAgent) throw new Error('overviewAgent must be selected in reviewAgents');
  if (!overviewAgent.required) throw new Error('overviewAgent must be required');
  await Promise.all(ids.map(async (id) => {
    try {
      if (reservedPromptIds.has(id) || !(await lstat(path.join(engineRoot, 'prompts', `${id}.md`))).isFile()) throw new Error();
    } catch {
      throw new Error(`Unknown Review Agent: ${id}`);
    }
  }));
  return configuration;
}

async function loadConfiguration(file: string, optional = false): Promise<ReviewConfiguration | undefined> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = parse(source);
  if (!validator.Check(value)) {
    throw new Error(`Invalid .agentic-review.yml: ${JSON.stringify(validator.Errors(value))}`);
  }
  return value;
}
