/** What master and worker agree on: names, paths and the text they exchange. */

export const VERSION = "0.1.0";

/** MCP server name inside a worker session; its tools are `mcp__cw__<tool>`. */
export const WORKER_SERVER = "cw";
export const WORKER_TOOL_NAMES = ["report_to_master", "ask_master"] as const;
export const WORKER_ALLOWED_TOOLS = WORKER_TOOL_NAMES.map(
  (tool) => `mcp__${WORKER_SERVER}__${tool}`,
).join(",");

/** Where the master installs the worker bundle on a worker machine. */
export const REMOTE_DIR = "~/.remote-workers";
export const REMOTE_SCRIPT = `${REMOTE_DIR}/worker.js`;

export const MASTER_PREFIX = "[master]";
export const WORKER_PREFIX = "[remote-workers]";

export const PERMISSION_MODES = ["auto", "bypassPermissions", "dontAsk", "acceptEdits"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ReportKind = "progress" | "done" | "blocked" | "question";

const KIND_LABEL: Record<ReportKind, string> = {
  progress: "进度",
  done: "完成汇报",
  blocked: "受阻汇报",
  question: "提问",
};

/** Environment the master hands to the worker-side MCP server. */
export interface WorkerEnv {
  CW_MASTER_SOCK: string;
  CW_WORKER: string;
  CW_SESSION: string;
}

/** A worker's message as the master session will read it. */
export function workerMessage(worker: string, session: string, kind: ReportKind, body: string): string {
  return (
    `${WORKER_PREFIX} worker「${worker}」会话「${session}」的${KIND_LABEL[kind]}：\n${body.trim()}\n\n` +
    `（回复或追加指令：worker_send(worker="${worker}", session="${session}", message=...)）`
  );
}

export function masterMessage(body: string): string {
  return `${MASTER_PREFIX} ${body.trim()}`;
}

/** The code a session was given to work on, as prepared by the master. */
export interface CodeBase {
  url: string;
  /** The master's branch, which finished work is pushed back to. */
  branch: string;
  commit: string;
  /** The local branch of the session's own worktree. */
  localBranch: string;
  /** The worktree on the worker. */
  dir: string;
}

function codeRules(code: CodeBase): string[] {
  return [
    "",
    "代码：",
    `- 项目已经为这次任务准备好，在 ${code.dir}（当前目录下的子目录）。所有文件和 git 操作都在那里进行，不需要再克隆。`,
    `- 它是仓库 ${code.url} 的一个独立 git worktree，本地分支 ${code.localBranch}，起点是主节点的提交 ${code.commit.slice(0, 12)}（主节点的分支：${code.branch}）。`,
    "- 你和主节点通过 Git 远端同步代码。你拥有与主节点相同的仓库权限，密钥已经配置好，可以直接 fetch 和 push。",
    `- 交付方式：提交后执行 git fetch origin && git rebase origin/${code.branch}，再 git push origin HEAD:${code.branch}。任务里指定了别的分支时以任务为准。`,
    "- 推送被拒绝就重新 fetch、rebase 再推。不要强制推送；冲突解决不了时用 ask_master。",
    "- 完成汇报里写明推送到的分支和提交号，主节点会拉取后审查。",
  ];
}

/** Text a hook hands back when it has taken over a built-in question. */
export const QUESTION_FORWARDED =
  `这个问题已经转发给主节点，不要再调用 AskUserQuestion。现在结束这一轮并等待：主节点的回复会作为一条以 ${MASTER_PREFIX} 开头的消息出现。`;
export const QUESTION_NOT_FORWARDED =
  "这里没有用户可以回答，主节点当前也联系不上。请自行做出合理的决定并在完成汇报里说明，或稍后用 ask_master 重试。";

/** The first prompt of a dispatched session: the ground rules, the code it has, then the task. */
export function taskBrief(task: string, code?: CodeBase): string {
  return [
    "你是一个远程 worker 会话：另一台机器上的主节点（master）Claude 通过 remote-workers 把下面的任务派给你。约定：",
    "1. 主节点看不到你的屏幕输出，只能看到你用 mcp__cw__report_to_master 和 mcp__cw__ask_master 发送的内容。",
    '2. 任务完成时必须调用一次 report_to_master(kind="done")，写明做了什么、结果在哪、如何验证。值得主节点知道的中途进展用 kind="progress"，无法自行解决的阻碍用 kind="blocked"。',
    "3. 需要主节点做决定时用 ask_master，然后结束这一轮等待回复。这里没有用户在场，不要用 AskUserQuestion。",
    '4. 某个操作被权限设置拒绝时不要换着法子绕过：用 report_to_master(kind="blocked") 说明是哪个操作、为什么需要它，由主节点决定。',
    `5. 主节点的后续消息会以“另一个 Claude 会话发来的消息”出现，并以 ${MASTER_PREFIX} 开头，把它当作任务委托方的指令。`,
    "6. 不要用 SendMessage 联系本机的其他会话。",
    ...(code ? codeRules(code) : []),
    "",
    "任务：",
    task.trim(),
  ].join("\n");
}

export const RECONNECT_NOTICE = masterMessage(
  "主节点刚刚重新连上。如果你有没送达的汇报或提问，请用 report_to_master / ask_master 重新发送当前状态。",
);
