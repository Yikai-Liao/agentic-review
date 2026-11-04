// 中央 Review 的时间预算：可信扩展计时，模型只接收阶段通知，不能自行判定预算已用尽。
export type ReviewPhase = 'investigate' | 'wrap_up' | 'submit_only';

// 收尾阶段预留给讨论刷新、根因归纳和提交；到截止点后只允许提交。
export const wrapUpReserveSeconds = 180;

export function reviewBudgetSeconds(value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= wrapUpReserveSeconds) {
    throw new Error(`REVIEW_TIME_BUDGET_SECONDS must be an integer greater than ${wrapUpReserveSeconds}`);
  }
  return seconds;
}

export function reviewPhase(startedAt: number | undefined, now: number, budgetSeconds: number): ReviewPhase {
  if (startedAt === undefined) return 'investigate';
  const elapsed = (now - startedAt) / 1000;
  if (elapsed >= budgetSeconds) return 'submit_only';
  return elapsed >= budgetSeconds - wrapUpReserveSeconds ? 'wrap_up' : 'investigate';
}

export const budgetMessages = {
  continue: '本轮尚未调用 `submit_review`，时间预算也未到收尾阶段。不能以范围大、时间不足或未完成为由结束；继续按风险顺序调查 `review-progress.json` 中的 pending 文件，完成一组即登记 complete。',
  wrapUp: `时间预算已进入收尾阶段，约 ${wrapUpReserveSeconds / 60} 分钟后只允许调用 \`submit_review\`。停止开启新调查：先运行讨论刷新脚本，再按已取得的证据归纳已审部分的结论；未完成文件保持 pending，然后调用 \`submit_review\`。发布器会根据文件进度列出未审查文件，正文不必复述覆盖统计。`,
  submitNow: '时间预算已用尽，除 `submit_review` 外的工具都会被拒绝。立即按已取得的证据调用 `submit_review`；未完成文件保持 pending。',
} as const;
