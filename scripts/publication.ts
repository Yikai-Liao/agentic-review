export type PublicationOperation = {
  id: string;
  status: 'succeeded' | 'failed' | 'blocked';
  dependencies: string[];
  error?: string;
};
type OperationResult<T> = PublicationOperation & { value?: T };

// 失败停留在操作边界；调用方只声明真正需要的前置结果。
// 写请求失败也可能已经在远端生效，本轮不自动重试。
export function createPublication() {
  const operations: PublicationOperation[] = [];
  return {
    operations,
    async run<T>(id: string, dependencies: OperationResult<unknown>[], action: () => Promise<T>): Promise<OperationResult<T>> {
      const blocked = dependencies.filter(item => item.status !== 'succeeded');
      const operation: PublicationOperation = {
        id, dependencies: dependencies.map(item => item.id), status: 'blocked',
      };
      if (blocked.length) {
        operation.error = `前置操作未成功：${blocked.map(item => item.id).join(', ')}`;
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
  saveCoverage?: (complete: boolean) => Promise<void>;
}) {
  if (outlets.writeSummary) await publication.run('写入 Actions 摘要', [], outlets.writeSummary);
  if (outlets.saveCoverage) {
    const complete = publication.operations.every(item => item.status === 'succeeded');
    await publication.run('保存覆盖状态', [], () => outlets.saveCoverage!(complete));
  }
  // 最后才序列化报告，纳入摘要和覆盖状态的实际结果。报告自身的存储结果由进程日志记录。
  const report = await publication.run('保存发布报告', [], outlets.saveReport);
  if (report.status !== 'succeeded' && outlets.saveCoverage) {
    await publication.run('撤回覆盖完成状态', [], () => outlets.saveCoverage!(false));
  }
}

export function publicationSummary(operations: PublicationOperation[], subject = '发布') {
  const labels = { succeeded: '成功', failed: '失败', blocked: '前置失败，未执行' };
  return [
    `## ${subject}${operations.every(item => item.status === 'succeeded') ? '已完成' : '未全部完成'}`,
    '',
    '写请求失败可能表示远端结果未知；重跑前通过 GitHub 发布标记核对，不能据此断言没有写入。',
    '',
    ...operations.flatMap(item => [
      `- ${labels[item.status]}：${item.id}`,
      ...(item.error ? ['', `    ${item.error.replaceAll('\n', '\n    ')}`] : []),
    ]),
    '',
  ].join('\n');
}
