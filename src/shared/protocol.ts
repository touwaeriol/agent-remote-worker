/** What master and worker agree on: names, paths and the text they exchange. */

export const VERSION = "0.1.0";

/** MCP server name inside a worker session; its tools are `mcp__cw__<tool>`. */
export const WORKER_SERVER = "cw";
export const WORKER_TOOL_NAMES = ["report_to_master", "ask_master"] as const;
export const WORKER_ALLOWED_TOOLS = WORKER_TOOL_NAMES.map(
  (tool) => `mcp__${WORKER_SERVER}__${tool}`,
).join(",");

/** Where the master installs the worker bundle on a worker machine. */
export const REMOTE_DIR = "~/.agent-remote-worker";
export const REMOTE_SCRIPT = `${REMOTE_DIR}/worker.js`;

export const MASTER_PREFIX = "[master]";
export const WORKER_PREFIX = "[agent-remote-worker]";

export const PERMISSION_MODES = ["auto", "default", "bypassPermissions", "dontAsk", "acceptEdits"] as const;
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

/** Who has the final say on a worker's permission prompts and questions. */
export const APPROVAL_MODES = ["master", "user"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * A permission prompt or question a worker session is waiting on. The hook that
 * raised it keeps a file with this content until it is answered or gives up.
 */
export interface PendingRequest {
  id: string;
  kind: "permission" | "question";
  worker: string;
  session: string;
  /** The hook process holding the session; the request is void once it is gone. */
  pid: number;
  createdAt: number;
  deadline: number;
  approval: ApprovalMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** What Claude Code offered for "don't ask again", for a permission prompt. */
  suggestions?: unknown[];
}

export type RequestAnswer =
  | { kind: "permission"; decision: "allow" | "deny"; message?: string; remember?: boolean }
  | { kind: "question"; answers: string[] };

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

/** Renders the built-in question tool's input as text the master can answer. */
export function formatQuestions(input: AskUserQuestionInput): string {
  const questions = input.questions ?? [];
  return questions
    .map((q, index) => {
      const options = (q.options ?? [])
        .map((option) => `  - ${option.label ?? ""}${option.description ? `：${option.description}` : ""}`)
        .join("\n");
      const head = questions.length > 1 ? `问题 ${index + 1}：` : "";
      const title = `${head}${q.question ?? ""}${q.multiSelect ? "（可多选）" : ""}`;
      return options ? `${title}\n${options}` : title;
    })
    .join("\n\n");
}

/** The question texts, in order: the keys an answer to AskUserQuestion is given under. */
export function questionTexts(input: Record<string, unknown>): string[] {
  return ((input as AskUserQuestionInput).questions ?? []).map((q) => q.question ?? "");
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text);

/** A tool call as the master reads it in a permission request. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    const note = typeof input.description === "string" ? `\n说明：${input.description}` : "";
    return `工具：Bash\n命令：${clip(input.command, 2000)}${note}`;
  }
  return `工具：${toolName}\n参数：${clip(JSON.stringify(input, null, 1), 2000)}`;
}

/** A pending request as the master session reads it, with how to answer it. */
export function requestMessage(request: PendingRequest): string {
  const { worker, session, id } = request;
  const minutes = Math.max(1, Math.round((request.deadline - Date.now()) / 60_000));
  const who = request.approval === "user" ? "这个节点要求每个请求都先问用户，拿到用户的答复后再" : "你可以自己决定，也可以先问用户，然后";
  if (request.kind === "permission") {
    return (
      `${WORKER_PREFIX} worker「${worker}」会话「${session}」的权限请求 #${id}，它在原地等待答复：\n` +
      `${describeToolCall(request.toolName, request.toolInput)}\n\n` +
      `（${who}答复：worker_answer(worker="${worker}", request_id="${id}", decision="allow" 或 "deny", message=拒绝时的说明)。` +
      `约 ${minutes} 分钟内没有答复会按拒绝处理。）`
    );
  }
  return (
    `${WORKER_PREFIX} worker「${worker}」会话「${session}」的提问 #${id}，它在原地等待答复：\n` +
    `${formatQuestions(request.toolInput)}\n\n` +
    `（${who}答复：worker_answer(worker="${worker}", request_id="${id}", answers=[按问题顺序，每个问题一个答案，可以是选项标签或自由文本；多选用逗号分隔])。` +
    `约 ${minutes} 分钟内没有答复，worker 会结束这一轮，之后只能用 worker_send 回复。）`
  );
}

/**
 * The suggestions "remember" may apply: rules and directories for this kind of
 * call. Never a change of permission mode, which would wave through far more.
 */
export function rememberable(suggestions: unknown[] | undefined): Array<Record<string, unknown>> {
  return (suggestions ?? []).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && ["addRules", "addDirectories"].includes(String((entry as { type?: unknown }).type)),
  );
}

/** Text a hook hands back when it could not get an answer. */
export const QUESTION_NOT_FORWARDED =
  "这里没有用户可以回答，主节点当前也联系不上。请自行做出合理的决定并在完成汇报里说明，或稍后用 ask_master 重试。";
export const QUESTION_TIMED_OUT =
  `主节点没有在时限内回答这个问题。不要再次调用 AskUserQuestion：结束这一轮并等待，主节点的回复会作为一条以 ${MASTER_PREFIX} 开头的消息出现。`;
export const PERMISSION_NOT_FORWARDED =
  '这个操作需要确认，但主节点当前联系不上，已按拒绝处理。不要换着法子绕过：先做别的部分，或用 report_to_master(kind="blocked") 说明需要什么，主节点重连后会处理。';
export const PERMISSION_TIMED_OUT =
  '主节点没有在时限内批准这个操作，已按拒绝处理。不要换着法子绕过：用 report_to_master(kind="blocked") 说明是哪个操作、为什么需要它。';

export function permissionDenied(message?: string): string {
  return (
    `主节点拒绝了这个操作${message?.trim() ? `：${message.trim()}` : "。"}` +
    "不要换着法子绕过；按主节点的说明调整，确实需要时用 report_to_master(kind=\"blocked\") 说明理由。"
  );
}

/** The first prompt of a dispatched session: the ground rules, the code it has, then the task. */
export function taskBrief(task: string, code?: CodeBase): string {
  return [
    "你是一个远程 worker 会话：另一台机器上的主节点（master）Claude 通过 agent-remote-worker 把下面的任务派给你。约定：",
    "1. 主节点看不到你的屏幕输出，只能看到你用 mcp__cw__report_to_master 和 mcp__cw__ask_master 发送的内容。",
    '2. 任务完成时必须调用一次 report_to_master(kind="done")，写明做了什么、结果在哪、如何验证。值得主节点知道的中途进展用 kind="progress"，无法自行解决的阻碍用 kind="blocked"。',
    "3. 需要主节点做决定时用 AskUserQuestion：问题会转给主节点，你原地等到答复再继续。也可以用 ask_master 发一个开放式问题，然后结束这一轮等待 [master] 回复。",
    '4. 需要确认的操作会自动交给主节点批准，你原地等待结果。被拒绝时不要换着法子绕过：按拒绝理由调整，确实需要时用 report_to_master(kind="blocked") 说明是哪个操作、为什么需要它。',
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
