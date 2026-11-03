// 使用第三方 Action 的发布产物验证扩展；隔离安装与执行命令见部署说明。
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
const compressionDirectory = process.env.PI_COMPRESSION_DIRECTORY;
if (!actionDirectory || !compressionDirectory) throw new Error('Set PI_ACTION_DIRECTORY and PI_COMPRESSION_DIRECTORY');
const actionPackage = JSON.parse(await readFile(path.join(actionDirectory, 'package.json'), 'utf8'));
assert.equal(agent.uses, `shaftoe/pi-coding-agent-action@v${actionPackage.version}`);
const compressionPackage = JSON.parse(await readFile(path.join(compressionDirectory, 'node_modules/billion-context-pi/package.json'), 'utf8'));
assert.equal(compressionPackage.version, workflow.env.BILLION_CONTEXT_PI_VERSION);
const configure = steps.find((step: any) => step.name === 'Configure Pi runtime').run;

for (const explicitCache of [false, true]) {
  test(`实际第三方 Action：显式缓存${explicitCache ? '开启' : '关闭'}，扩展执行压缩并保存 sidecar`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-action-compression-'));
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      const turn = requests.length;
      let item: any;
      if (turn <= 5) {
        item = { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'read',
          arguments: JSON.stringify({ path: path.join(directory, `evidence-${turn}.txt`) }) };
      } else if (turn === 6) {
        item = { type: 'function_call', id: 'fc_status', call_id: 'call_status', name: 'acp_status', arguments: '{}' };
      } else if (turn === 7) {
        const evidence = payload.input.find((entry: any) => entry.type === 'function_call_output' && entry.call_id === 'call_1');
        const ref = evidence?.output.match(/<acp [^>]+>(m\d+)<\/acp>/)?.[1];
        item = { type: 'function_call', id: 'fc_compress', call_id: 'call_compress', name: 'compress',
          arguments: JSON.stringify({ content: [{ startId: ref, endId: ref,
            summary: '已核对第一份证据：资源访问必须校验归属，接口应拒绝其他租户的数据。保留文件位置和校验结论供后续审查使用。',
          }] }) };
      } else {
        item = { type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'Review complete.' }] };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: `resp_${turn}`, status: 'completed', output: [item],
        usage: { input_tokens: 3000, output_tokens: 50, total_tokens: 3050, input_tokens_details: { cached_tokens: 0 } },
      } })}\n\n`);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await mkdir(path.join(directory, '.pi/agent'), { recursive: true });
      await mkdir(path.join(directory, 'review-workspace'));
      await symlink(root, path.join(directory, 'control'));
      await symlink(compressionDirectory, path.join(directory, 'review-pi-extensions'));
      await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-e', '-c', configure], {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, REVIEW_AGENT_MODEL: 'gpt-test',
          REVIEW_EXPLICIT_PROMPT_CACHE: String(explicitCache), REVIEW_WORKSPACE_PATH: path.join(directory, 'review-workspace') },
      });
      const configured = JSON.parse(await readFile(path.join(directory, '.pi/agent/models.json'), 'utf8'));
      await writeFile(path.join(directory, '.pi/agent/models.json'), JSON.stringify({ providers: { openai: {
        baseUrl: `${origin}/v1`, api: 'openai-responses', models: [{ id: 'gpt-test', name: 'test',
          ...configured.providers.openai.modelOverrides['gpt-test'],
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }],
      } } }));
      for (let index = 1; index <= 5; index++) {
        await writeFile(path.join(directory, `evidence-${index}.txt`), `EVIDENCE_${index}: verify resource ownership before reading data.\n`.repeat(100));
      }
      await writeFile(path.join(directory, 'event.json'), '{}');
      await writeFile(path.join(directory, 'outputs'), '');
      await writeFile(path.join(directory, 'summary'), '');
      writeReviewInput(path.join(directory, 'input.json'), []);
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(actionDirectory, 'dist/index.js')], {
        cwd: directory, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: process.env.PATH, HOME: directory, CI: 'true', PI_OFFLINE: '1',
          GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory, GITHUB_REPOSITORY: 'example/review',
          GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: path.join(directory, 'event.json'),
          GITHUB_API_URL: origin, GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
          INPUT_GITHUB_TOKEN: 'local-test-token', INPUT_PROVIDER: 'openai', INPUT_MODEL: 'gpt-test', INPUT_TOKEN: 'local-test-key',
          INPUT_BASE_URL: `${origin}/v1`, INPUT_THINKING_LEVEL: 'off', INPUT_PROMPT: '核对证据并压缩早期调查记录。',
          INPUT_EXTENSIONS: agent.with.extensions.replaceAll('${{ runner.temp }}', directory),
          INPUT_LOADED_TOOLS: agent.with.loaded_tools, INPUT_LOAD_BUILTIN_EXTENSIONS: String(agent.with.load_builtin_extensions),
          INPUT_ENABLE_CODEMODE: String(agent.with.enable_codemode), INPUT_AUTO_COMPACTION: String(agent.with.auto_compaction),
          INPUT_EXPORT_SESSION_JSONL: String(agent.with.export_session_jsonl), INPUT_EXPORT_SESSION_HTML: 'false',
          INPUT_REFRESH_MODEL_CATALOG: 'false', INPUT_CACHE_WARMING: 'off',
          REVIEW_INPUT_PATH: path.join(directory, 'input.json'), REVIEW_WORKSPACE_PATH: path.join(directory, 'review-workspace'),
        },
      });
      assert.doesNotMatch(stdout + stderr, /\[extension\].*(?:Error|error)|unknown tool name|unsupported host/i);
      assert.equal(requests.length, 8, stdout + stderr);
      const names = requests[0].tools.map((tool: any) => tool.name);
      for (const tool of agent.with.loaded_tools.trim().split(/\s+/)) assert.ok(names.includes(tool), `请求缺少工具 ${tool}`);
      assert.ok(!names.some((tool: string) => tool.startsWith('acp_delegate')));
      const hasBreakpoint = JSON.stringify(requests[0].input).includes('prompt_cache_breakpoint');
      assert.equal(hasBreakpoint, explicitCache);
      const compressed = requests[7].input.find((entry: any) => entry.type === 'function_call_output' && entry.call_id === 'call_compress');
      assert.match(compressed.output, /blocks: b1=/);
      assert.ok(!JSON.stringify(requests[7]).includes('EVIDENCE_1'));
      const files = await readdir(path.join(directory, '.pi/agent/sessions'), { recursive: true });
      const sidecar = files.find(file => file.endsWith('.jsonl.acp.json'));
      assert.ok(sidecar, '落盘会话必须保存 ACP 压缩状态');
      const state = JSON.parse(await readFile(path.join(directory, '.pi/agent/sessions', sidecar), 'utf8'));
      assert.equal(state.blocks.length, 1);
      assert.match(await readFile(path.join(directory, 'outputs'), 'utf8'), /^success<<[^\n]+\ntrue\n/m);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
