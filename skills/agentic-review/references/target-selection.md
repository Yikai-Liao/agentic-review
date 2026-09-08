# 本地变化范围

先确认当前目录属于 Git worktree，再按用户意图选择唯一范围。不要用提交数量代替代码差异。

## 未提交变化

比较 `HEAD` 与当前 index、working tree，并把 untracked 文件作为新增文件读取。staged、unstaged、删除、重命名和 untracked 都属于完整变化集合。

## 指定 commit

比较该 commit 的第一父提交与 commit；root commit 与 Git empty tree 比较。用户明确要求合并提交的其他父视角时再使用对应 parent。

## 分支或 ref 差异

“与 `<base>` 比较”使用 `merge-base(<base>, <head>) → <head>`，默认 `<head>` 为当前 `HEAD`。只有用户明确要求两端快照的直接差异时，才比较 `<base> → <head>`。

## 未指定范围

当前存在未提交变化时默认审查它们；工作区干净时请用户指定 commit、分支或两个 ref，不擅自选择最近一次提交。

完成条件：记录实际使用的 base/head、是否包含 working tree 和 untracked 文件，以及完整 changed file 清单。
