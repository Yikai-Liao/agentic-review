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

export function publicationSummary(operations: PublicationOperation[]) {
  const labels = { succeeded: '成功', failed: '失败', blocked: '前置失败，未执行' };
  return [
    operations.every(item => item.status === 'succeeded') ? '## 发布已完成' : '## 发布未全部完成',
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
