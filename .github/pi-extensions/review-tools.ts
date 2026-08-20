import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    [key: string]: unknown;
    execute: (...args: any[]) => Promise<unknown>;
  }): void;
};

export default function reviewTools(pi: ExtensionAPI) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_review',
    label: 'Submit review',
    description: 'Submit a finalized review-result JSON file from the private review workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Path to the finalized JSON file inside REVIEW_WORKSPACE_PATH.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, { path: inputPath }: { path: string }) {
      if (submitted) throw new Error('the review was already submitted');

      const workspace = process.env.REVIEW_WORKSPACE_PATH;
      const resultPath = process.env.REVIEW_RESULT_PATH;
      if (!workspace || !path.isAbsolute(workspace) || !resultPath || !path.isAbsolute(resultPath)) {
        throw new Error('Review paths are unavailable');
      }

      const workspacePath = await realpath(workspace);
      const reviewPath = await realpath(path.resolve(inputPath));
      const relative = path.relative(workspacePath, reviewPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Review file must be inside REVIEW_WORKSPACE_PATH');
      }

      const info = await stat(reviewPath);
      if (!info.isFile() || info.size > 1_000_000) throw new Error('Review file must be a regular file no larger than 1 MB');
      const content = await readFile(reviewPath, 'utf8');
      JSON.parse(content);
      await writeFile(resultPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      submitted = true;

      return {
        content: [{ type: 'text', text: 'Review queued for trusted publication.' }],
        details: { queued: true, source: reviewPath },
      };
    },
  });
}
