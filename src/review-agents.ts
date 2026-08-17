import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

const configSchema = Type.Object({
  agents: Type.Array(Type.Object({
    id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
    runByDefault: Type.Boolean(),
    required: Type.Boolean(),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export type ReviewAgent = Static<typeof configSchema>['agents'][number];
const validator = Compile(configSchema);

export async function loadReviewAgents(engineRoot: string, requested?: string): Promise<ReviewAgent[]> {
  const value: unknown = JSON.parse(await readFile(path.join(engineRoot, 'review-agents.json'), 'utf8'));
  if (!validator.Check(value)) throw new Error(`Invalid review-agents.json: ${JSON.stringify(validator.Errors(value))}`);
  if (new Set(value.agents.map(({ id }) => id)).size !== value.agents.length) throw new Error('Duplicate Review Agent id');
  const ids = requested?.split(',').map((id) => id.trim()).filter(Boolean)
    ?? value.agents.filter((agent) => agent.runByDefault).map(({ id }) => id);
  const agents = ids.map((id) => value.agents.find((agent) => agent.id === id));
  if (!agents.length || agents.some((agent) => !agent)) throw new Error(`Unknown REVIEW_AGENTS: ${ids.join(', ')}`);
  return agents as ReviewAgent[];
}
