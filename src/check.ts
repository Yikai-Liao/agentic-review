export type ExistingCheck = {
  id: number;
  app: { slug: string };
  status: string;
  conclusion: string | null;
  external_id: string;
};

export function selectExistingCheck(
  checks: ExistingCheck[],
  appSlug: string,
  taskId: string,
): { id: number; duplicate: boolean } | undefined {
  const existing = checks
    .filter((check) => check.app.slug === appSlug && check.external_id === taskId)
    .sort((left, right) => right.id - left.id)[0];
  if (!existing || (existing.status === 'completed' && existing.conclusion !== 'success')) return undefined;
  return { id: existing.id, duplicate: existing.status === 'completed' };
}
