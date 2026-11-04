// 使用第三方 Action 的发布产物验证 pi-fold；隔离安装与执行命令见部署说明。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { writeReviewInput } from '../scripts/write-review-input.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = parse(await readFile(path.join(root, '.github/workflows/review-execution.yml'), 'utf8'));
const steps = workflow.jobs.review.steps;
const agent = steps.find((step: any) => step.id === 'pi-review');
const actionDirectory = process.env.PI_ACTION_DIRECTORY;
const foldDirectory = process.env.PI_FOLD_DIRECTORY;
if (!actionDirectory || !foldDirectory) throw new Error('Set PI_ACTION_DIRECTORY and PI_FOLD_DIRECTORY');
const actionPackage = JSON.parse(await readFile(path.join(actionDirectory, 'package.json'), 'utf8'));
assert.equal(agent.uses, `shaftoe/pi-coding-agent-action@v${actionPackage.version}`);
const foldPackage = JSON.parse(await readFile(path.join(foldDirectory, 'node_modules/pi-fold/package.json'), 'utf8'));
assert.equal(foldPackage.version, workflow.env.PI_FOLD_VERSION);
const configure = steps.find((step: any) => step.name === 'Configure Pi runtime').run;

// 每次 bash 返回约 45KB 原文（低于 Pi 的 50KB/2000 行截断），约 18 次后超过 272K 窗口的 80%；
// 70 次读取使 pi-fold 多次提交折叠，规则 Prompt 要在多次折叠后仍保持原文。
const READS = 70;
// 约 100KB，与中央规则 Prompt 同一量级；Action 经环境变量传入，单项上限 128KB。
const PROMPT = `逐份核对证据。\n${'RULE_LINE 固定规则正文。\n'.repeat(3000)}`;
const evidence = (index: number) => `EVIDENCE_${index}: verify resource ownership before reading data.\n`.repeat(700);

test('实际第三方 Action：pi-fold 自动折叠旧证据，不调用模型摘要，审查继续完成', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-action-fold-'));
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const turn = requests.length;
    const item = turn <= READS
      ? { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'bash',
        arguments: JSON.stringify({ command: `cat evidence-${turn}.txt` }) }
      : { type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'Review complete.' }] };
    // 按请求体大小报告输入 token，使 Pi 与 pi-fold 得到真实的窗口占用。
    const input = Math.ceil(JSON.stringify(payload.input).length / 4);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: `resp_${turn}`, status: 'completed', output: [item],
      usage: { input_tokens: input, output_tokens: 50, total_tokens: input + 50, input_tokens_details: { cached_tokens: 0 } },
    } })}\n\n`);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await mkdir(path.join(directory, '.pi/agent'), { recursive: true });
    await mkdir(path.join(directory, 'review-workspace'));
    await symlink(root, path.join(directory, 'control'));
    await symlink(foldDirectory, path.join(directory, 'review-pi-extensions'));
    await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-e', '-c', configure], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, REVIEW_AGENT_MODEL: 'gpt-test',
        REVIEW_EXPLICIT_PROMPT_CACHE: 'false', REVIEW_WORKSPACE_PATH: path.join(directory, 'review-workspace') },
    });
    const configured = JSON.parse(await readFile(path.join(directory, '.pi/agent/models.json'), 'utf8'));
    await writeFile(path.join(directory, '.pi/agent/models.json'), JSON.stringify({ providers: { openai: {
      baseUrl: `${origin}/v1`, api: 'openai-responses', models: [{ id: 'gpt-test', name: 'test',
        ...configured.providers.openai.modelOverrides['gpt-test'],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }],
    } } }));
    for (let index = 1; index <= READS; index++) await writeFile(path.join(directory, `evidence-${index}.txt`), evidence(index));
    await writeFile(path.join(directory, 'event.json'), '{}');
    await writeFile(path.join(directory, 'outputs'), '');
    await writeFile(path.join(directory, 'summary'), '');
    writeReviewInput(path.join(directory, 'input.json'), []);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(actionDirectory, 'dist/index.js')], {
      cwd: directory, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH, HOME: directory, CI: 'true', PI_OFFLINE: '1',
        GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory, GITHUB_REPOSITORY: 'example/review',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: path.join(directory, 'event.json'),
        GITHUB_API_URL: origin, GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
        INPUT_GITHUB_TOKEN: 'local-test-token', INPUT_PROVIDER: 'openai', INPUT_MODEL: 'gpt-test', INPUT_TOKEN: 'local-test-key',
        INPUT_BASE_URL: `${origin}/v1`, INPUT_THINKING_LEVEL: 'off', INPUT_PROMPT: PROMPT,
        INPUT_EXTENSIONS: agent.with.extensions.replaceAll('${{ runner.temp }}', directory),
        INPUT_LOADED_TOOLS: agent.with.loaded_tools, INPUT_LOAD_BUILTIN_EXTENSIONS: String(agent.with.load_builtin_extensions),
        INPUT_ENABLE_CODEMODE: String(agent.with.enable_codemode), INPUT_AUTO_COMPACTION: String(agent.with.auto_compaction),
        INPUT_EXPORT_SESSION_JSONL: String(agent.with.export_session_jsonl), INPUT_EXPORT_SESSION_HTML: 'false',
        INPUT_REFRESH_MODEL_CATALOG: 'false', INPUT_CACHE_WARMING: 'off',
        REVIEW_INPUT_PATH: path.join(directory, 'input.json'), REVIEW_WORKSPACE_PATH: path.join(directory, 'review-workspace'),
      },
    });
    const log = stdout + stderr;
    assert.doesNotMatch(log, /\[extension\].*(?:Error|error)|unknown tool name|unsupported host|compaction failed/i);
    // 每个请求都是带工具的审查回合；原生摘要请求没有工具，出现即说明退回了模型压缩。
    assert.equal(requests.length, READS + 1, log);
    assert.ok(requests.every(request => request.tools?.length), '不应出现模型摘要请求');
    const names = requests[0].tools.map((tool: any) => tool.name);
    for (const tool of agent.with.loaded_tools.trim().split(/\s+/)) assert.ok(names.includes(tool), `请求缺少工具 ${tool}`);
    assert.ok(!names.includes('pi_fold_context'), '模型不应获得上下文调度工具');
    // 请求体经 JSON 序列化，证据原文按同样的转义形式比较。
    const raw = (index: number) => JSON.stringify(evidence(index)).slice(1, -1);
    const last = JSON.stringify(requests.at(-1).input);
    const sizes = requests.map(request => JSON.stringify(request.input).length);
    assert.ok(sizes.some(size => size / 4 > 272000 * 0.8 * 0.9), `上下文应接近折叠阈值：${sizes.join(' ')}`);
    assert.ok(sizes.some((size, index) => index > 0 && size < sizes[index - 1] / 2), `应出现一次折叠提交：${sizes.join(' ')}`);
    assert.ok(JSON.stringify(requests[1].input).includes(raw(1)), '证据先以原文进入窗口');
    assert.ok(!last.includes(raw(1)), '最早的证据原文应已折叠出窗口');
    assert.ok(last.includes(raw(READS)), '最近的证据保持原文');
    assert.ok(last.length / 4 < 272000 * 0.8, '折叠后的请求回到阈值以下');
    assert.ok(sizes.filter((size, index) => index > 0 && size < sizes[index - 1] / 2).length >= 3, `应连续提交多次折叠：${sizes.join(' ')}`);
    // 整轮审查是同一个未结束的 user 回合；pi-fold 不折叠该回合的首条消息。
    // 折叠摘要只保留 Prompt 的前 120 个字符；完整 Prompt 的尾部仍在请求中，说明它没有被摘要替换。
    assert.ok(last.includes(JSON.stringify(PROMPT.trimEnd()).slice(1, -1)), '多次折叠后完整启动 Prompt 保持原文');
    const files = await readdir(path.join(directory, '.pi/agent/sessions'), { recursive: true });
    const session = files.find(file => file.endsWith('.jsonl'));
    assert.ok(session);
    const entries = (await readFile(path.join(directory, '.pi/agent/sessions', session), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.type === 'custom' && String(entry.customType).startsWith('pi-fold')), '落盘会话应保存折叠记录');
    assert.ok(!entries.some(entry => entry.type === 'compaction'), '不应触发原生压缩');
    assert.match(await readFile(path.join(directory, 'outputs'), 'utf8'), /^success<<[^\n]+\ntrue\n/m);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
