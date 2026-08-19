import { selectExistingCheck, type ExistingCheck } from '../src/check.ts';

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'complete') await complete();
else throw new Error('usage: github-check.ts <start|complete>');

async function start(): Promise<void> {
  const repository = required('GITHUB_REPOSITORY');
  const taskId = required('REVIEW_TASK_ID');
  let checks: ExistingCheck[] = [];
  try {
    const existingResponse = await request(
      `/repos/${repository}/commits/${required('REVIEW_HEAD_SHA')}/check-runs?check_name=${encodeURIComponent('Agentic Review / audit')}&filter=all`,
      { method: 'GET' },
    );
    checks = (await existingResponse.json() as { check_runs: ExistingCheck[] }).check_runs;
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('GitHub check failed: 404'))) throw error;
  }
  const appSlug = required('REVIEW_APP_SLUG');
  const selected = selectExistingCheck(checks, appSlug, taskId);
  const output = required('GITHUB_OUTPUT');
  if (selected) {
    await appendOutputs(output, selected.id, selected.duplicate);
    return;
  }

  const response = await request(`/repos/${repository}/check-runs`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Agentic Review / audit',
      head_sha: required('REVIEW_HEAD_SHA'),
      external_id: taskId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: { title: 'Agentic Review 正在审查', summary: '中央 Review Engine 已开始处理当前 PR head。' },
    }),
  });
  const check = await response.json() as { id: number };
  await appendOutputs(output, check.id, false);
}

async function complete(): Promise<void> {
  const conclusion = required('REVIEW_CONCLUSION');
  if (conclusion !== 'success' && conclusion !== 'failure') throw new Error(`invalid conclusion: ${conclusion}`);
  await request(`/repos/${required('GITHUB_REPOSITORY')}/check-runs/${required('REVIEW_CHECK_ID')}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: conclusion === 'success' ? 'Agentic Review 已完成' : 'Agentic Review 执行失败',
        summary: conclusion === 'success'
          ? '审查已完成；未 Resolve 的 inline review thread 将继续阻止合并。'
          : '审查未能可靠完成，当前提交保持不可合并。',
      },
    }),
  });
}

async function appendOutputs(path: string, checkId: number, duplicate: boolean): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `check_id=${checkId}\nduplicate=${duplicate}\n`);
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub check failed: ${response.status} ${await response.text()}`);
  return response;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
