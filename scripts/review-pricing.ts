export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown[] };
export type CatalogModel = { provider: string; id: string; cost: ModelCost };

// 显式注册的网关模型不在 Pi 目录中，SDK 会把它的费用算成 0；这里从目录取价。
// 精确 ID 优先；否则取同系列、同档位名中版本最高的型号，例如 gpt-6.1-terra → gpt-5.6-terra。
// 后者是估价，不是该模型的真实价格；找不到时直接失败，不按 0 计价。
export function findCatalogCost(id: string, catalog: readonly CatalogModel[]): ModelCost {
  // 同名模型在各 provider 的价格不同，官方 openai 目录优先。
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
  throw new Error(`No Pi catalog price for review model ${id}`);
}
