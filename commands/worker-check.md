---
description: 自检 worker 节点（SSH、claude、脚本、登录、目录信任）
argument-hint: "[节点名] [worker 上的 workRoot 目录]"
---

调用 `worker_check` 工具自检节点。参数：$ARGUMENTS

如果参数里有目录，把它作为 `cwd` 传入以检查信任状态。把结果逐项告诉用户；有 ✗ 的项要说明怎么修。
