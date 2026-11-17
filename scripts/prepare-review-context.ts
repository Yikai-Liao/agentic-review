import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { main as attributeSources } from './attribute-review-sources.ts';
import { main as findCheckpoint } from './find-review-checkpoint.ts';
import { findLatestReviewWorkspace } from './find-review-request.ts';
import { main as prepareAssociations } from './list-review-associations.ts';
import { prepareReviewInput } from './prepare-review-input.ts';
import { checkoutReviewTarget, fetchReviewCommits, prepareReviewBase } from './prepare-review-sources.ts';
import { parseReviewCoverage, validateAuditCheckpoint, validateCoverageCompletion, inventoryDigest } from './review-coverage.ts';
import { main as persistRequest } from './review-request.ts';
import { readDiscussion } from './refresh-review-discussion.ts';
import { validateReviewTrigger } from './validate-review-trigger.ts';
import { loadReviewPrompt } from './load-review-prompt.ts';
import { parseReviewLanguage } from './review-language.ts';
import type { ReviewSnapshot } from './resolve-review-snapshot.ts';

const exec = promisify(execFile);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export async function archiveReviewPublisher(control: string) {
  // 直接读取可信准备阶段的工作树，不能让部分克隆为打包触发额外 Git 下载。
  const { stdout } = await exec('tar', ['-czf', '-', '-C', control, 'scripts', 'package.json'], { encoding: 'buffer' });
  return stdout.toString('base64');
}

async function downloadWorkspace(run: string, name: string, directory: string) {
  // GitHub CLI 负责下载和安全解包；中央制品读取使用 workflow token，目标读取 token 仍保持原范围。
  await exec('gh', ['run', 'download', run, '--repo', required('GITHUB_REPOSITORY'), '--name', name, '--dir', directory], {
    env: { ...process.env, GH_TOKEN: required('CONTROL_TOKEN') },
  });
}

async function restoreRequestedWorkspace(repositoryId: string, pull: string, directory: string) {
  if (process.env.REVIEW_TRIGGER_SOURCE !== 'pr_comment') return null;
  const previous = await findLatestReviewWorkspace({
    repositoryId, pullNumber: pull, controlRepository: required('GITHUB_REPOSITORY'), token: required('CONTROL_TOKEN'),
    currentRun: `${required('GITHUB_RUN_ID')}:${required('GITHUB_RUN_ATTEMPT')}`, api: process.env.GITHUB_API_URL,
  });
  if (!previous) return null;
  const prefix = previous.published ? 'review-completed-workspace' : 'review-workspace';
  await downloadWorkspace(previous.runId, `${prefix}-${repositoryId}-${pull}-${previous.source}-${previous.runId}-${previous.runAttempt}`, directory);
  await exec('chmod', ['-R', 'a-w', directory]);
  return previous;
}

async function restoreCheckpoint(repositoryId: string, pull: string, snapshot: ReviewSnapshot, directory: string) {
  const checkpoint = await findCheckpoint();
  if (!checkpoint) return null;
  await downloadWorkspace(checkpoint.runId,
    `review-completed-workspace-${repositoryId}-${pull}-automatic-${checkpoint.runId}-${checkpoint.runAttempt}`, directory);
  const coverage = parseReviewCoverage(JSON.parse(await readFile(path.join(directory, 'review-coverage.json'), 'utf8')));
  validateAuditCheckpoint(coverage, { repository: snapshot.repository, pullNumber: Number(pull), base: snapshot.baseSha,
    head: checkpoint.headSha, run: checkpoint.runId, attempt: checkpoint.runAttempt });
  await validateCoverageCompletion(coverage, inventoryDigest(coverage.ledger.map(entry => entry.path)));
  await exec('chmod', ['-R', 'a-w', directory]);
  return checkpoint;
}

export async function main() {
  const inputs = {
    repository: required('REVIEW_REPOSITORY'), repository_id: required('REVIEW_REPOSITORY_ID'),
    pull_number: required('REVIEW_PULL_NUMBER'), trigger_source: required('REVIEW_TRIGGER_SOURCE'),
    comment_id: process.env.REVIEW_COMMENT_ID ?? '', comment_root_id: process.env.REVIEW_COMMENT_ROOT_ID ?? '',
    comment_body: process.env.REVIEW_COMMENT_BODY ?? '',
  };
  const snapshot: ReviewSnapshot = JSON.parse(await readFile(required('REVIEW_SNAPSHOT_PATH'), 'utf8'));
  if (snapshot.repository !== inputs.repository || snapshot.pullNumber !== inputs.pull_number) throw new Error('PR snapshot does not match dispatch inputs');
  const workspace = required('GITHUB_WORKSPACE');
  const temporary = required('RUNNER_TEMP');
  const control = fileURLToPath(new URL('../', import.meta.url));
  // 控制面已按固定 ref 检出，尚未启动 Agent；发布器由 Runner 保存为步骤输出。
  // 在持久化请求前交付，后续输入准备失败时仍可由该发布器保存恢复范围。
  await appendFile(required('GITHUB_OUTPUT'), `publisher_archive=${await archiveReviewPublisher(control)}\n`);
  const target = path.join(workspace, 'review-target');
  const base = path.join(workspace, 'review-base');
  const draft = path.join(workspace, 'review-workspace');
  const previousRequest = path.join(temporary, 'previous-request-workspace');
  const previousAudit = path.join(temporary, 'previous-review-workspace');
  Object.assign(process.env, {
    REPOSITORY: inputs.repository, REPOSITORY_ID: inputs.repository_id, PULL_NUMBER: inputs.pull_number,
    BASE_SHA: snapshot.baseSha, HEAD_SHA: snapshot.headSha,
    REVIEW_REPOSITORY: inputs.repository, REVIEW_PULL_NUMBER: inputs.pull_number,
    REVIEW_BASE_SHA: snapshot.baseSha, REVIEW_HEAD_SHA: snapshot.headSha, REVIEW_TRIGGER_SOURCE: inputs.trigger_source,
    REVIEW_TARGET_PATH: target, REVIEW_BASE_PATH: base, REVIEW_WORKSPACE_PATH: draft,
    REVIEW_ASSOCIATIONS_PATH: path.join(temporary, 'review-associations.json'),
    REVIEW_ATTRIBUTION_PATH: path.join(temporary, 'review-attribution.json'),
    REVIEW_CONTEXT_PATH: path.join(temporary, 'review-context/review-context.json'),
    REVIEW_PROGRESS_PATH: path.join(draft, 'review-progress.json'), REVIEW_INPUT_PATH: path.join(temporary, 'review-input.json'),
    REVIEW_COMMENT_ID: inputs.comment_id, REVIEW_COMMENT_ROOT_ID: inputs.comment_root_id, REVIEW_COMMENT_BODY: inputs.comment_body,
    CONTROL_REPOSITORY: required('GITHUB_REPOSITORY'),
  });
  // 讨论可以和 Git 下载同时读取；读取失败要在持久化本次请求后抛出，保留可恢复的范围。
  const discussion = readDiscussion(inputs.repository!, inputs.pull_number!).then(
    value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }),
  );
  const [, previous] = await Promise.all([
    checkoutReviewTarget(target, `${required('GITHUB_SERVER_URL')}/${inputs.repository}.git`, snapshot.baseSha, snapshot.headSha),
    restoreRequestedWorkspace(inputs.repository_id!, inputs.pull_number!, previousRequest),
    inputs.trigger_source === 'automatic' ? undefined : validateReviewTrigger({
      repository: inputs.repository!, pullNumber: inputs.pull_number!, source: inputs.trigger_source!,
      commentId: inputs.comment_id!, commentRootId: inputs.comment_root_id!, body: inputs.comment_body!,
      token: required('GH_TOKEN'), api: process.env.GITHUB_API_URL,
    }),
  ]);
  Object.assign(process.env, {
    REVIEW_PREVIOUS_REQUEST_WORKSPACE_PATH: previous ? previousRequest : '',
    REVIEW_PREVIOUS_RUN_ID: previous?.runId ?? '', REVIEW_PREVIOUS_RUN_ATTEMPT: previous?.runAttempt ?? '',
    REVIEW_PREVIOUS_SOURCE: previous?.source ?? '', REVIEW_PREVIOUS_PUBLISHED: String(previous?.published ?? false),
  });
  if (previous) {
    const coverage = parseReviewCoverage(JSON.parse(await readFile(path.join(previousRequest, 'review-coverage.json'), 'utf8')));
    // 显式请求的旧范围可能属于另一条历史；按记录补齐版本，保留失败范围与撤销变化。
    const ranges = coverage.scope?.ranges ?? coverage.default_plan?.ranges ?? [];
    await fetchReviewCommits(target, ranges.flatMap(range => [range.comparison_start, range.comparison_end]));
  }
  // 来源归因在持久化请求前完成：它写入可信上下文，Agent 不能改写来源已审的文件。
  await attributeSources();
  await persistRequest();
  const [checkpoint] = await Promise.all([
    restoreCheckpoint(inputs.repository_id!, inputs.pull_number!, snapshot, previousAudit),
    prepareAssociations(), prepareReviewBase(target, base, snapshot.baseSha),
  ]);
  process.env.REVIEW_PREVIOUS_WORKSPACE_PATH = checkpoint ? previousAudit : '';
  process.env.REVIEW_CHECKPOINT_HEAD = checkpoint?.headSha ?? '';
  const currentDiscussion = await discussion;
  if (currentDiscussion.status === 'rejected') throw currentDiscussion.reason;
  await prepareReviewInput(snapshot, currentDiscussion.value);
  const prompt = await loadReviewPrompt(control, parseReviewLanguage(process.env.REVIEW_LANGUAGE));
  const delimiter = `REVIEW_PROMPT_${crypto.randomUUID()}`;
  await appendFile(required('GITHUB_OUTPUT'), [
    `previous_workspace=${checkpoint ? previousAudit : ''}`, `previous_request_workspace=${previous ? previousRequest : ''}`,
    `checkpoint_head=${checkpoint?.headSha ?? ''}`, `prompt<<${delimiter}`, prompt, delimiter, '',
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
