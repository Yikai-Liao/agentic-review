import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/review-execution.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.review.steps;

test('压缩扩展按固定版本隔离缓存，命中后跳过安装，保存发生在 Agent 启动前', () => {
  const restore = steps.find((step: any) => step.id === 'pi-compression');
  const install = steps.find((step: any) => step.name === 'Install trusted Pi compression extension');
  const save = steps.find((step: any) => step.name === 'Save trusted Pi compression extension');
  const agent = steps.find((step: any) => step.id === 'pi-review');
  assert.match(workflow.env.BILLION_CONTEXT_PI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(steps.indexOf(restore) < steps.indexOf(install));
  assert.ok(steps.indexOf(install) < steps.indexOf(save) && steps.indexOf(save) < steps.indexOf(agent));
  assert.equal(install.if, "steps.pi-compression.outputs.cache-hit != 'true'");
  assert.equal(save.if, install.if);
  assert.equal(restore.with.path, '${{ runner.temp }}/review-pi-extensions');
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, '${{ steps.pi-compression.outputs.cache-primary-key }}');
  assert.ok(restore.with.key.includes('${{ env.BILLION_CONTEXT_PI_VERSION }}'));
  assert.equal(restore.with['restore-keys'], undefined, '不能恢复其他版本的可执行扩展');
  assert.match(install.run, /--ignore-scripts/);
  assert.match(install.run, /--legacy-peer-deps/, 'host SDK 由 Action 提供');
  assert.match(install.run, /billion-context-pi@\$BILLION_CONTEXT_PI_VERSION/);
  assert.ok(agent.with.extensions.includes(`${restore.with.path}/node_modules/billion-context-pi/dist/index.js`));
  assert.ok(!agent.with.extensions.includes('npm:'), 'Action 只加载已安装的本地入口');
  assert.equal(agent.with.auto_compaction, false, '只保留 ACP 一条压缩路径');
  // Action 的 false 输入只是不再主动开启，真正关闭须写入 Pi settings。
  const configure = steps.find((step: any) => step.name === 'Configure Pi runtime').run;
  const settings = JSON.parse(configure.match(/settings\.json" <<'JSON'\n([\s\S]*?)\nJSON/)[1]);
  assert.equal(settings.compaction.enabled, false);
});
