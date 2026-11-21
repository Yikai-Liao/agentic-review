# Resolving Local Code Scope

A delta review fixes the complete change set. Confirm the Git worktree, then choose one comparison by the user's intent; the number of commits does not stand in for the actual diff. An audit uses the current snapshot of the module the user named and needs no diff.

## Uncommitted Changes

Compare `HEAD` with the index and working tree, and read untracked files as additions. Scope includes staged, unstaged, deleted, renamed, and untracked content.

## A Single Commit

Compare the commit's first parent with the commit; a root commit compares with the Git empty tree. Use another parent of a merge commit only when the user explicitly asks.

## A Branch or Ref Range

"Compare with `<base>`" defaults to `merge-base(<base>, <head>) → <head>`, the target as seen from the common ancestor; `<head>` defaults to the current `HEAD`. Use `<base> → <head>` only when the user explicitly asks to compare the two snapshots directly; never mix the two.

## No Scope Given

Review uncommitted changes if any. If the worktree is clean, ask for a commit, branch, or two refs; do not pick the latest commit on your own.

## Re-review of a Revised Change

The **full range** stays the complete change from its base. The **increment** runs from the head of the last review whose coverage record carries over to the new head; investigate it first per [Workspace and re-review](../../review-state.md#deciding-what-to-reinvestigate-after-a-revision). Paths in the increment that vanished from the full range are reverted changes: check how the revert affects earlier conclusions. "Behavior after merge", finding evidence, and locations come only from the full range.

## Reading the Diff

Read file lists with `--name-status` (`-z` when paths may contain special characters) and sizes with `--numstat`, both with `--find-renames --find-copies`, and pass paths literally. A diff that fits in the remaining context is read once in full; size depends on long lines and context, not changed-line counts alone. Read larger diffs by path, and oversized files by hunk: locate hunk headers in `--unified=0` output, then read the patch and source by line range, continuing past truncation.

## Record the Scope Used

Record the real base and head, whether the working tree and untracked files are included, and the full changed-file list. Keep change types and both paths of renames and copies; later reads include both paths.
