# agent-remote-worker

Claude Code 插件 `remote-workers`。

把任务从你正在用的 Claude Code 会话（主节点）派给其他机器上的 Claude Code 会话（worker）。worker 用它自己登录的账号，所以消耗的是另一份额度。两边可以随时互发消息：worker 上报进度、提问，主节点追加要求，双方空闲时都会被消息唤醒。

## 它怎么工作

```
主节点                                   worker
主会话 ──worker_* 工具──▶ 插件的 MCP 服务器 ──SSH──▶ claude --bg 后台会话
   ▲                                                  │
   └──────── SSH 反向映射 ◀── report_to_master / ask_master
```

- 主节点安装本插件，得到 9 个 `worker_*` 工具。
- 派发时，插件读取主节点当前项目的仓库地址、分支和提交，经 SSH 在 worker 上克隆或更新这个项目，为这次任务建一个独立的 git worktree，再用 `claude --bg` 在里面启动后台会话。这一步在后台进行，完成后主会话会收到通知。
- 插件把 `dist/worker.js` 复制到 worker，给会话提供 `report_to_master` 和 `ask_master` 两个工具。worker 上不需要安装任何东西。
- 代码只通过 Git 远端同步：主节点先推送，worker 拉取；worker 完成后推送，主节点拉取。
- 消息走 Claude Code 自带的会话收件箱（inbox socket）：主节点经 SSH 写 worker 会话的收件箱；worker 经一条 SSH 反向映射写主会话的收件箱。主节点不需要开放任何端口。

## 前提

| | 主节点 | worker |
| --- | --- | --- |
| Claude Code | 2.1.224 以上，已登录 | 同左，登录另一个账号 |
| Node.js | 18 以上，`node` 在 `PATH` 里 | 18 以上 |
| SSH | 能免密登录 worker | — |
| Git | 项目已提交并推送 | 有和主节点相同的仓库权限，密钥已配置 |
| 其他 | — | `workRoot` 目录已被 Claude Code 信任（一次即可） |

## 安装和配置

1. 在主节点安装插件。在 Claude Code 会话里：

   ```text
   /plugin marketplace add touwaeriol/agent-remote-worker
   /plugin install remote-workers@agent-remote-worker
   ```

   开发时也可以克隆仓库后直接加载目录：`claude --plugin-dir /path/to/agent-remote-worker`。

2. 写 `~/.claude/workers.json`：

   ```json
   {
     "workers": {
       "worker": {
         "ssh": "worker",
         "claudePath": "/home/USER/.local/bin/claude",
         "workRoot": "~/remote-workers",
         "permissionMode": "auto"
       }
     },
     "minRemainingPercent": 10
   }
   ```

   | 字段 | 含义 |
   | --- | --- |
   | `ssh` | `~/.ssh/config` 里的主机别名。密钥和端口留在 SSH 配置里 |
   | `claudePath` | worker 上 `claude` 的绝对路径。非交互 SSH 的 `PATH` 里常常没有它 |
   | `workRoot` | worker 上放项目的目录，默认 `~/remote-workers`。在 worker 上进入它运行一次 `claude` 并接受信任提示 |
   | `nodePath` | worker 上 `node` 的路径。默认在 `claude` 所在目录和 `PATH` 里找 |
   | `permissionMode` | 该节点的默认权限模式：`auto`、`bypassPermissions`、`dontAsk`、`acceptEdits` |
   | `minRemainingPercent` | worker 本周额度剩余低于这个百分比时拒绝派发，默认 10 |
   | `localClaudePath` | 本机 `claude` 的路径，查本机额度时用。默认自动找 |

3. 在会话里运行 `/remote-workers:worker-check worker ~/remote-workers` 自检，第二个参数是 `workRoot`。

## 工具

主节点：

| 工具 | 作用 |
| --- | --- |
| `worker_dispatch` | 把当前项目交给 worker 并启动后台会话执行任务；也可以指定 worker 上的现成目录 |
| `worker_send` | 给会话发消息；进程已退出时自动续跑 |
| `worker_status` | 查看会话状态 |
| `worker_stop` | 停止会话，对话保留 |
| `worker_resume` | 续跑已停止的会话 |
| `worker_remove` | 删除会话并清理它的 worktree；有未推送内容时拒绝 |
| `worker_usage` | 查主节点和各 worker 的额度 |
| `worker_list` | 列出节点和会话 |
| `worker_check` | 自检节点 |

worker 会话：`report_to_master`（进度、完成、受阻）和 `ask_master`（提问并等待回复）。

worker 上的内置提问工具（`AskUserQuestion`）会被一个钩子拦下并转发给主节点，因为 worker 会话旁边没有人。

## worker 上的目录

```
<workRoot>/repos/<项目>-<编号>/                   每个项目克隆一份
<workRoot>/sessions/<项目>-<编号>/<会话名>/        会话的起始目录
<workRoot>/sessions/<项目>-<编号>/<会话名>/<项目>/  这次任务的 worktree
```

会话从 worktree 外面的普通目录启动：Claude Code 允许普通目录继承 `workRoot` 的信任，但每个 git 检出都要单独确认，而后台会话没有人可以点确认。

## 权限模式

worker 会话无人值守，卡在权限确认上就会停住，所以要选一个不需要人点确认的模式。取值优先级：`worker_dispatch` 的 `permission_mode` 参数，然后是节点配置，最后是默认值 `auto`。

选 `bypassPermissions` 时，插件会同时给会话设置 `crossSessionInbound: accept`，否则这种会话会把主节点的消息扣住等人批准。

## 已知限制

- **消息格式没有公开文档。** 收件箱本身是 Claude Code 文档写明的功能，但每行消息的写法不是。Claude Code 升级后如果格式变了，只需要改 `src/shared/inbox.ts` 里的 `inboxFrame`。
- **消息不持久化。** 主节点不在线时，worker 的工具会返回“未送达”；通道恢复后主节点会让 worker 重新汇报。
- **同一时间只有一个主会话接收某个 worker 的消息。** 最后一个派发或发消息的主会话接管通道。
- **消息不能打断正在运行的命令。** 它在两次工具调用之间被读到。要立刻停下用 `worker_stop`。
- **主会话处于 `bypassPermissions` 模式时会扣住 worker 的消息。** 需要在主节点的设置里加 `"crossSessionInbound": "accept"`。
- **后台会话只能在已信任的目录里启动。** 所以 `workRoot` 要先信任一次，并且它自己不能在某个 git 仓库里面。
- **worker 的权限确认不能由主节点代批。** worker 被拒绝后会向主节点汇报，由主节点和你决定换做法还是换权限模式续跑。
- **worker 默认把结果推回主节点当前所在的分支。** 想让它推到别的分支，在任务说明里写明。

## 开发

```bash
git clone git@github.com:touwaeriol/agent-remote-worker.git && cd agent-remote-worker
npm install
npm run check        # 类型检查、单元测试、构建
node tests/drive.mjs worker_check '{"cwd":"~/repo"}'   # 不经过 Claude，直接调用工具
```

源码在 `src/`：`shared/` 是两边共用的协议和收件箱，`master/` 是主节点的 MCP 服务器，`worker/` 是 worker 端的 MCP 服务器和几个经 SSH 调用的辅助命令。`dist/` 是打包结果，需要提交，因为插件安装时不会执行构建。

## 许可证

MIT
