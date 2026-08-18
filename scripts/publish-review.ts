import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareContext } from '../src/context.ts';
import { publishGitHubReview, validatePullRequestReview } from '../src/github.ts';

const reviewPath = required('REVIEW_OUTPUT_PATH');
const file = await stat(reviewPath);
if (!file.isFile() || file.size > 200_000) throw new Error('staged review must be a file no larger than 200 KB');
const raw = await readFile(reviewPath, 'utf8');

const cwd = path.resolve(required('REVIEW_REPOSITORY_PATH'));
const context = await prepareContext(
  cwd,
  required('REVIEW_BASE_SHA'),
  required('REVIEW_HEAD_SHA'),
  `${cwd}/.publish-review`,
);
const review = validatePullRequestReview(JSON.parse(raw));
console.log(await publishGitHubReview(context.root, review));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
