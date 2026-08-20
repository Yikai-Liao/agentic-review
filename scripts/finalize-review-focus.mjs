import { appendFile, readFile, rename, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/;

export async function finalizeReviewFocus({ checkpointHead, fullDiffPath, focusDiffPath }) {
  const temporaryPath = `${focusDiffPath}.tmp`;
  await rm(focusDiffPath, { force: true });
  if (!checkpointHead) {
    await rm(temporaryPath, { force: true });
    return 'initial';
  }

  const [fullDiff, focusDiff] = await Promise.all([readFile(fullDiffPath), readFile(temporaryPath)]);
  if (!focusDiff.length) {
    await rm(temporaryPath);
    return 'incremental_unchanged';
  }
  if (fullDiff.equals(focusDiff)) {
    await rm(temporaryPath);
    return 'incremental_all';
  }
  await rename(temporaryPath, focusDiffPath);
  return 'incremental';
}

async function main() {
  const {
    CHECKPOINT_HEAD: checkpointHead = '',
    REVIEW_DIFF_PATH: fullDiffPath,
    REVIEW_FOCUS_DIFF_PATH: focusDiffPath,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!fullDiffPath || !focusDiffPath || !output || (checkpointHead && !shaPattern.test(checkpointHead))) {
    throw new Error('Invalid review focus environment');
  }
  const mode = await finalizeReviewFocus({ checkpointHead, fullDiffPath, focusDiffPath });
  await appendFile(output, `mode=${mode}\ncheckpoint_head=${checkpointHead}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
