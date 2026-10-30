import { rmSync, writeFileSync } from 'node:fs';

// 限制入口直接展开的内容；大输入由 Agent 使用现有工具分段读取。
const inlineBytes = 32 * 1024;
const inlineLines = 1000;

export function writeReviewInput(file: string, content: string) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const source = `${file}.full.md`;
  if (bytes <= inlineBytes && content.split('\n').length <= inlineLines) {
    writeFileSync(file, content, { mode: 0o600 });
    rmSync(source, { force: true });
    return;
  }

  writeFileSync(source, content, { mode: 0o600 });
  writeFileSync(file, [
    '# Review input', '',
    `完整输入为 ${bytes} UTF-8 字节，超过入口直接展开的预算（${inlineBytes} 字节、${inlineLines} 行）。`,
    `完整原文：\`${source}\`。包含请求、讨论、项目规则和恢复清单。`,
    '使用现有 read 或 bash 工具分段读取；每段结论和进度落盘后再继续，不一次拼接或并行载入全文。',
    '长单行也按片段读取，工具输出截断不代表该段已读完。此索引不代表已覆盖完整输入。', '',
  ].join('\n'), { mode: 0o600 });
}
