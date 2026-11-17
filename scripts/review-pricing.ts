export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown[] };
export type CatalogModel = { provider: string; id: string; cost: ModelCost };

// Explicitly registered gateway models are not in Pi's catalog, so the SDK prices them at 0; take prices from the catalog here.
// Exact ID first; otherwise the highest version with the same family and tier name, e.g. gpt-6.1-terra → gpt-5.6-terra.
// The latter is an estimate, not the model's real price; when nothing matches, return undefined so the caller marks cost unknown instead of 0.
export function findCatalogCost(id: string, catalog: readonly CatalogModel[]): ModelCost | undefined {
  // The same model is priced differently across providers; prefer the official openai catalog.
  const rank = (provider: string) => provider === 'openai' ? 0 : provider === 'openai-codex' ? 1 : 2;
  const priced = catalog.filter(model => model.cost.input > 0 || model.cost.output > 0)
    .sort((a, b) => rank(a.provider) - rank(b.provider));
  const exact = priced.find(model => model.id === id);
  if (exact) return exact.cost;
  const parse = (value: string) => /^([a-z][a-z0-9]*)-(\d+(?:\.\d+)*)-([a-z][a-z0-9]*)$/.exec(value);
  const wanted = parse(id);
  if (wanted) {
    const version = (value: string) => parse(value)![2].split('.').map(Number);
    const similar = priced.filter(model => { const match = parse(model.id); return match && match[1] === wanted[1] && match[3] === wanted[3]; })
      .sort((a, b) => {
        const left = version(a.id), right = version(b.id);
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
          const delta = (right[index] ?? 0) - (left[index] ?? 0);
          if (delta) return delta;
        }
        return 0;
      });
    if (similar.length) return similar[0].cost;
  }
}
