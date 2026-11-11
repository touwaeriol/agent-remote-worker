/** The MCP server the plugin starts in the master session: the worker_* tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PERMISSION_MODES, VERSION } from "../shared/protocol.ts";
import { textTool } from "../shared/tooling.ts";
import { Master } from "./master.ts";

const INSTRUCTIONS =
  "agent-remote-worker：把任务派给其他机器上的 Claude Code 会话（remote worker），它们用的是另一个账号的额度。" +
  "和内置 Sub Agent 不同：worker 在另一台机器、另一个账号、独立的代码副本上运行，看不到本会话的上下文和文件，" +
  "所以 worker_dispatch 的 task 必须自包含（目标、边界、验收标准）。代码通过 Git 远端同步：派发前本机代码要已提交并推送，" +
  "worker 默认把结果推回本机当前所在的分支，由你 git pull 后审查。" +
  "worker 的权限请求和提问会转给你，worker 在原地等待：用 worker_answer 按编号答复。任务范围内你能定的直接答复，需求取舍、有风险或不可逆的操作、超出原任务范围的事先问用户。" +
  "用户要求派给 worker 时才派发。派发后不需要轮询：worker 的汇报和提问会作为以 [agent-remote-worker] 开头的消息自动出现，用 worker_send 回复。" +
  "派发前会自动检查 worker 的额度。详细做法见 agent-remote-worker:dispatch skill。";

const worker = z.string().optional().describe("节点名（workers.json 里的键）；只有一个节点时可省略");
const session = z.string().describe("会话 id 或名字");
const permissionMode = z.enum(PERMISSION_MODES).optional().describe("覆盖节点默认的权限模式");

const master = new Master();
const server = new McpServer({ name: "agent-remote-worker", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "worker_dispatch",
  {
    description:
      "把任务派给 worker：自动在 worker 上克隆或更新本项目，为这次任务建一个独立的 git worktree（停在本机当前提交），再在里面启动后台 Claude Code 会话，立即返回会话 id。" +
      "本机代码必须已提交并推送。task 必须自包含：worker 看不到本会话的上下文。",
    inputSchema: {
      worker,
      task: z.string().describe("完整的任务说明"),
      project_dir: z
        .string()
        .optional()
        .describe("要交给 worker 的项目在本机的路径；省略时用本会话所在的项目"),
      cwd: z
        .string()
        .optional()
        .describe("改为在 worker 上这个现成的已信任目录里运行，不准备代码；只用于与本机项目无关的任务"),
      allow_unsynced: z.boolean().optional().describe("本机有未推送或未提交的改动时仍然派发"),
      name: z.string().optional().describe("会话名字"),
      model: z.string().optional().describe("模型"),
      permission_mode: permissionMode,
      force: z.boolean().optional().describe("跳过额度门槛检查"),
    },
  },
  textTool((args) => master.dispatch(args)),
);

server.registerTool(
  "worker_send",
  {
    description:
      "给 worker 会话发一条消息（追加要求、回答它的提问、询问进度）。忙时它会在当前工具调用结束后读到，空闲时被唤醒，进程已退出时自动续跑。",
    inputSchema: { worker, session, message: z.string() },
  },
  textTool((args) => master.send(args)),
);

server.registerTool(
  "worker_answer",
  {
    description:
      "答复 worker 会话正在等待的一个权限请求或提问（消息里的 #编号）。权限请求给 decision，提问给 answers；worker 收到后当场继续。" +
      "需求取舍、有风险或不可逆的操作、超出原任务范围的事，先问用户再答复。",
    inputSchema: {
      worker,
      request_id: z.string().describe("请求编号，即消息里 # 后面的部分"),
      decision: z.enum(["allow", "deny"]).optional().describe("权限请求：allow 放行，deny 拒绝"),
      message: z.string().optional().describe("拒绝时告诉 worker 的理由或替代做法"),
      remember: z.boolean().optional().describe("放行时，本会话内同类操作不再询问"),
      answers: z.array(z.string()).optional().describe("提问：按问题顺序，每个问题一个答案（选项标签或自由文本，多选用逗号分隔）"),
      user_confirmed: z.boolean().optional().describe("这个答复已经问过用户；节点配置为 approval=user 时必须为 true"),
    },
  },
  textTool((args) => master.answer(args)),
);

server.registerTool(
  "worker_pending",
  {
    description: "列出 worker 会话正在等待答复的权限请求和提问。通道断过、或想确认有没有漏掉的请求时使用。",
    inputSchema: { worker },
  },
  textTool((args) => master.pending(args)),
);

server.registerTool(
  "worker_status",
  {
    description: "查看 worker 上会话的状态；不给 session 时列出该节点所有活动会话。",
    inputSchema: { worker, session: session.optional() },
  },
  textTool((args) => master.status(args)),
);

server.registerTool(
  "worker_stop",
  {
    description: "停止一个 worker 会话。对话保留，可用 worker_resume 续跑。",
    inputSchema: { worker, session },
  },
  textTool((args) => master.stop(args)),
);

server.registerTool(
  "worker_remove",
  {
    description:
      "任务结束后的收尾：停止并删除一个 worker 会话，清理它的 worktree。工作目录里有未推送或未提交的内容时会拒绝，除非 force=true。",
    inputSchema: { worker, session, force: z.boolean().optional().describe("丢弃未推送和未提交的内容") },
  },
  textTool((args) => master.remove(args)),
);

server.registerTool(
  "worker_resume",
  {
    description: "把已停止或进程已退出的 worker 会话在后台重新拉起，保留原有上下文，可附一条新指令。",
    inputSchema: { worker, session, message: z.string().optional(), permission_mode: permissionMode },
  },
  textTool((args) => master.resume(args)),
);

server.registerTool(
  "worker_usage",
  {
    description: "查询主节点和各 worker 账号的额度使用情况（当前时段、本周、按模型）及重置时间。不消耗额度。",
    inputSchema: { worker },
  },
  textTool((args) => master.usage(args)),
);

server.registerTool(
  "worker_list",
  { description: "列出所有节点及其后台会话。", inputSchema: {} },
  textTool(() => master.list()),
);

server.registerTool(
  "worker_check",
  {
    description:
      "自检一个节点：SSH、claude、node、脚本版本、登录、收件箱、workRoot 是否已信任（配置了 trustWorkRoot 时会自动信任）；给出 cwd 时还检查该目录。",
    inputSchema: { worker, cwd: z.string().optional().describe("要检查信任状态的 worker 目录") },
  },
  textTool((args) => master.check(args)),
);

const shutdown = () => {
  master.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(new StdioServerTransport());
