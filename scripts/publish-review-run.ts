import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { main as assembleWorkspace } from './prepare-review-publication.ts';
import { main as publishReview } from './publish-review.ts';

export async function main() {
  await assembleWorkspace();
  await appendFile(process.env.GITHUB_OUTPUT!, 'workspace_ready=true\n');
  if (process.env.PI_REVIEW_OUTCOME !== 'success') throw new Error('Agent did not complete the review; workspace saved for recovery');
  await publishReview();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
