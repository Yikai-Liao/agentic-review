import { reviewText, type ReviewLanguage } from './review-language.ts';

export type PublicationOperation = {
  id: string;
  status: 'succeeded' | 'failed' | 'blocked';
  dependencies: string[];
  error?: string;
};
type OperationResult<T> = PublicationOperation & { value?: T };

// Failures stop at operation boundaries; callers declare only the prerequisites they truly need.
// A failed write may still have taken effect remotely, so this round never retries automatically.
export function createPublication(language: ReviewLanguage = 'zh-CN') {
  const operations: PublicationOperation[] = [];
  return {
    language,
    operations,
    async run<T>(id: string, dependencies: OperationResult<unknown>[], action: () => Promise<T>): Promise<OperationResult<T>> {
      const blocked = dependencies.filter(item => item.status !== 'succeeded');
      const operation: PublicationOperation = {
        id, dependencies: dependencies.map(item => item.id), status: 'blocked',
      };
      if (blocked.length) {
        operation.error = reviewText(language, '前置操作未成功：', 'Prerequisite operations did not succeed: ') + blocked.map(item => item.id).join(', ');
        operations.push(operation);
        return operation;
      }
      try {
        const value = await action();
        operation.status = 'succeeded';
        operations.push(operation);
        return { ...operation, value };
      } catch (error) {
        operation.status = 'failed';
        operation.error = error instanceof Error ? error.message : String(error);
        operations.push(operation);
        return operation;
      }
    },
  };
}

export async function finishPublication(publication: ReturnType<typeof createPublication>, outlets: {
  saveReport: () => Promise<void>;
  writeSummary?: () => Promise<void>;
  writeCheckText?: () => Promise<void>;
  saveCoverage?: (complete: boolean) => Promise<void>;
}) {
  const language = publication.language;
  if (outlets.writeSummary) await publication.run(reviewText(language, '写入 Actions 摘要', 'Write Actions summary'), [], outlets.writeSummary);
  if (outlets.saveCoverage) {
    const complete = publication.operations.every(item => item.status === 'succeeded');
    await publication.run(reviewText(language, '保存覆盖状态', 'Save coverage status'), [], () => outlets.saveCoverage!(complete));
  }
  let rolledBack = false;
  const rollback = async () => {
    if (!outlets.saveCoverage || rolledBack) return;
    rolledBack = true;
    await publication.run(reviewText(language, '撤回覆盖完成状态', 'Revoke coverage completion'), [], () => outlets.saveCoverage!(false));
  };
  // The report includes the actual summary and coverage results; its own storage result goes to the process log and Check details.
  const report = await publication.run(reviewText(language, '保存发布报告', 'Save publication report'), [], outlets.saveReport);
  if (report.status !== 'succeeded') await rollback();
  // Check details are the long-lived record, written last to list every earlier operation, including report storage and coverage revocation; their own failure goes to the process log.
  if (outlets.writeCheckText) {
    const check = await publication.run(reviewText(language, '写入 Check 详情', 'Write Check details'), [], outlets.writeCheckText);
    if (check.status !== 'succeeded') await rollback();
  }
}

export function publicationSummary(operations: PublicationOperation[], subject = '发布', language: ReviewLanguage = 'zh-CN') {
  const labels = language === 'en' ? { succeeded: 'Succeeded', failed: 'Failed', blocked: 'Blocked' }
    : { succeeded: '成功', failed: '失败', blocked: '前置失败，未执行' };
  const complete = operations.every(item => item.status === 'succeeded');
  return [
    reviewText(language, `## ${subject}${complete ? '已完成' : '未全部完成'}`, `## ${subject}: ${complete ? 'completed' : 'incomplete'}`),
    '',
    reviewText(language, '写请求失败可能表示远端结果未知；重跑前通过 GitHub 发布标记核对，不能据此断言没有写入。', 'A failed write may have an unknown remote outcome. Check the GitHub publication markers before rerunning; failure does not prove that nothing was written.'),
    '',
    ...operations.flatMap(item => [
      `- ${labels[item.status]}${reviewText(language, '：', ': ')}${item.id}`,
      ...(item.error ? ['', `    ${item.error.replaceAll('\n', '\n    ')}`] : []),
    ]),
    '',
  ].join('\n');
}
