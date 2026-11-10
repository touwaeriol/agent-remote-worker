/** The operations behind the master's tools. Each returns the text the model reads. */
import { randomBytes } from "node:crypto";
import os from "node:os";
import { ownSessionInbox, postToInbox } from "../shared/inbox.ts";
import {
  RECONNECT_NOTICE,
  WORKER_PREFIX,
  masterMessage,
  taskBrief,
  type CodeBase,
  type PermissionMode,
} from "../shared/protocol.ts";
import { ToolError, errorText } from "../shared/tooling.ts";
import type { PrepResult } from "../worker/cli.ts";
import { Channels } from "./channels.ts";
import { loadConfig, pickWorker, type Config } from "./config.ts";
import { run } from "./exec.ts";
import { inspectProject, syncProblems, type Project } from "./project.ts";
import { USAGE_ARGS, parseUsage, remainingPercent, type Usage } from "./usage.ts";
import { WorkerNode, describeSession, hasExited, type RemoteSession } from "./worker-node.ts";

export interface DispatchArgs {
  worker?: string;
  task: string;
  /** A project on this machine to hand over; defaults to where the session runs. */
  project_dir?: string;
  /** Run in this existing folder on the worker instead, with no code preparation. */
  cwd?: string;
  allow_unsynced?: boolean;
  name?: string;
  model?: string;
  permission_mode?: PermissionMode;
  force?: boolean;
}

export interface SessionArgs {
  worker?: string;
  session: string;
}

/** A dispatch whose code is still being cloned or updated on the worker. */
interface Preparation {
  worker: string;
  phase: string;
  startedAt: number;
  /** The latest progress line git printed. */
  progress?: string;
}

const indent = (lines: string[]) => lines.map((line) => `  ${line}`).join("\n");
const randomName = () => `cw-${randomBytes(3).toString("hex")}`;

export class Master {
  private readonly nodes = new Map<string, WorkerNode>();
  /** Names of the sessions this master started, per worker, for the reconnect notice. */
  private readonly dispatched = new Map<string, Set<string>>();
  private readonly channels = new Channels((node) => this.askToReport(node));
  /** Dispatches still getting their code ready, by session name. */
  private readonly preparing = new Map<string, Preparation>();

  close(): void {
    this.channels.close();
  }

  private resolve(workerName?: string): { node: WorkerNode; config: Config } {
    const config = loadConfig();
    const [name, workerConfig] = pickWorker(config, workerName);
    const key = `${name}:${JSON.stringify(workerConfig)}`;
    let node = this.nodes.get(key);
    if (!node) this.nodes.set(key, (node = new WorkerNode(name, workerConfig)));
    return { node, config };
  }

  private remember(node: WorkerNode, sessionName: string): void {
    let names = this.dispatched.get(node.name);
    if (!names) this.dispatched.set(node.name, (names = new Set()));
    names.add(sessionName);
  }

  private async askToReport(node: WorkerNode): Promise<void> {
    const names = this.dispatched.get(node.name);
    if (!names?.size) return;
    for (const session of await node.sessions(false)) {
      if (session.pid && session.name && names.has(session.name)) {
        await node.post(session, RECONNECT_NOTICE).catch(() => {});
      }
    }
  }

  // ---- dispatch, send, resume

  async dispatch(args: DispatchArgs): Promise<string> {
    const { node, config } = this.resolve(args.worker);
    const task = args.task.trim();
    if (!task) throw new ToolError("task 不能为空。");

    // Everything that can refuse the dispatch runs first, before anything is created on the worker.
    const project = args.cwd ? undefined : await this.projectToHandOver(args);
    const quotaNote = args.force ? "" : await this.checkQuota(node, config);
    const channel = await this.channels.ensure(node);

    let name = args.name?.trim() || randomName();
    const taken = [...(await node.sessions()).map((session) => session.name), ...this.preparing.keys()];
    if (taken.includes(name)) name += `-${randomBytes(2).toString("hex")}`;
    const permissionMode = args.permission_mode ?? node.config.permissionMode;
    const follow = "worker 的汇报和提问会作为消息自动出现在本会话里，不需要轮询。追加指令用 worker_send。";

    if (!project) {
      const cwd = args.cwd!.trim();
      const id = await node.launch({ cwd, name, prompt: taskBrief(task), permissionMode, model: args.model, channel });
      this.remember(node, name);
      return [
        `已派发到 worker「${node.name}」。`,
        `会话 id：${id}`,
        `名字：${name}`,
        `目录：${cwd}（未准备代码）`,
        `权限模式：${permissionMode}`,
        follow + quotaNote,
      ].join("\n");
    }

    if ((await node.ensureWorkRootTrusted()) === "untrusted") {
      throw new ToolError(
        `没有派发：worker「${node.name}」上的 workRoot（${node.config.workRoot}）还没有被 Claude Code 信任，后台会话无法在里面启动。\n` +
          "两种解决办法：在 worker 上进入该目录运行一次 claude 并接受信任提示；" +
          "或在节点配置里给这个节点加 \"trustWorkRoot\": true，让插件自动信任它。",
      );
    }

    // Cloning can take minutes: do it in the background and tell the session when it is done.
    const job: Preparation = { worker: node.name, phase: "正在 worker 上克隆或更新项目", startedAt: Date.now() };
    this.preparing.set(name, job);
    void this.prepareAndLaunch(node, job, { name, task, project, permissionMode, model: args.model, channel })
      .then((text) => this.notify(text))
      .finally(() => this.preparing.delete(name));
    return [
      `已受理，正在 worker「${node.name}」上准备代码，准备好后自动启动会话。`,
      `名字：${name}`,
      `代码：${project.url} 的 ${project.branch}@${project.commit.slice(0, 12)}`,
      `权限模式：${permissionMode}`,
      "不需要等待：会话启动（或准备失败）时本会话会收到一条通知。想看进度用 worker_status。" + quotaNote,
    ].join("\n");
  }

  /** The background half of a dispatch. Resolves to the notice the master session should read. */
  private async prepareAndLaunch(
    node: WorkerNode,
    job: Preparation,
    plan: {
      name: string;
      task: string;
      project: Project;
      permissionMode: PermissionMode;
      model?: string;
      channel: PrepResult;
    },
  ): Promise<string> {
    const { name, project } = plan;
    let sessionDir: string | undefined;
    try {
      const workspace = await node.addWorkspace(
        { url: project.url, commit: project.commit, session: name },
        (line) => (job.progress = line),
      );
      sessionDir = workspace.path;
      job.phase = "正在启动会话";
      job.progress = undefined;
      const code: CodeBase = {
        url: project.url,
        branch: project.branch,
        commit: project.commit,
        localBranch: workspace.localBranch,
        dir: workspace.codeDir,
      };
      const id = await node.launch({
        cwd: workspace.path,
        name,
        prompt: taskBrief(plan.task, code),
        permissionMode: plan.permissionMode,
        model: plan.model,
        channel: plan.channel,
      });
      this.remember(node, name);
      return (
        `${WORKER_PREFIX} worker「${node.name}」会话「${name}」已启动（id ${id}）。` +
        `代码已${workspace.cloned ? "克隆" : "更新"}到 ${workspace.codeDir}，起点 ${project.branch}@${project.commit.slice(0, 12)}。` +
        `它完成后会推送到 ${project.branch}，届时在本机 git pull 后审查。`
      );
    } catch (error) {
      if (sessionDir) await node.removeWorkspace(sessionDir, true).catch(() => {});
      const detail = job.progress ? `\n最后的输出：${job.progress}` : "";
      return `${WORKER_PREFIX} worker「${node.name}」会话「${name}」没有启动：${errorText(error, 600)}${detail}`;
    }
  }

  /** Puts a notice into this master session, waking it if it is idle. */
  private async notify(text: string): Promise<void> {
    const inbox = ownSessionInbox();
    if (inbox) await postToInbox(inbox, text).catch(() => {});
  }

  private describePreparing(workerName: string): string[] {
    return [...this.preparing]
      .filter(([, job]) => job.worker === workerName)
      .map(([name, job]) => {
        const seconds = Math.round((Date.now() - job.startedAt) / 1000);
        return `（准备中）${name}  ${job.phase}，已用 ${seconds} 秒${job.progress ? `  [${job.progress}]` : ""}`;
      });
  }

  /** The project a dispatch hands to the worker, refused when the worker could not see the same code. */
  private async projectToHandOver(args: DispatchArgs): Promise<Project> {
    const dir = args.project_dir?.trim() || process.cwd();
    const project = await inspectProject(dir);
    if (!project) {
      throw new ToolError(
        `${dir} 不在 git 仓库里，无法把项目交给 worker。` +
          "要派发与代码无关的任务，请用 cwd 指定 worker 上一个已信任的目录；要派发别的项目，请用 project_dir 指定它在本机的路径。",
      );
    }
    const problems = syncProblems(project);
    if (problems.length && !args.allow_unsynced) {
      throw new ToolError(
        `没有派发：${project.dir} ${problems.join("，")}，worker 从远端拿不到这些内容。\n` +
          "请先提交并推送再重试。如果任务不需要未提交的改动，可以加 allow_unsynced=true：" +
          `worker 会从本机当前提交 ${project.commit.slice(0, 12)} 开始，这个提交必须已在远端。`,
      );
    }
    return project;
  }

  /** Stops a session, deletes it and cleans up its worktree. */
  async remove(args: SessionArgs & { force?: boolean }): Promise<string> {
    const { node } = this.resolve(args.worker);
    const session = await node.findSession(args.session);
    const lines: string[] = [];
    const wasRunning = !hasExited(session);
    if (wasRunning) await node.stop(session);
    if (session.cwd) {
      const result = await node.removeWorkspace(session.cwd, Boolean(args.force));
      if (!result.removed && result.reason?.startsWith("工作目录里还有")) {
        throw new ToolError(
          `没有删除：会话 ${session.id} 的${result.reason}。` +
            (wasRunning ? "会话已停止，可用 worker_resume 续跑让它推送；" : "可用 worker_resume 让它推送；") +
            "确认可以丢弃则加 force=true。",
        );
      }
      lines.push(result.removed ? `已清理工作目录 ${session.cwd}。` : `工作目录未清理：${result.reason}。`);
    }
    await node.forget(session);
    lines.unshift(`已删除会话 ${session.id}（${session.name ?? "未命名"}）。`);
    return lines.join("\n");
  }

  /** Throws when the worker is under the quota floor; returns a note when the check itself failed. */
  private async checkQuota(node: WorkerNode, config: Config): Promise<string> {
    let usage: Usage;
    try {
      usage = await node.usage();
    } catch (error) {
      return `\n注意：额度检查失败（${errorText(error, 200)}），已继续派发。`;
    }
    const remaining = remainingPercent(usage);
    if (remaining !== undefined && remaining < config.minRemainingPercent) {
      throw new ToolError(
        `没有派发：worker「${node.name}」本周额度只剩 ${remaining}%，低于门槛 ${config.minRemainingPercent}%。\n` +
          `${usage.lines.join("\n")}\n确实要派发请加 force=true，并先告知用户。`,
      );
    }
    return "";
  }

  async send(args: SessionArgs & { message: string }): Promise<string> {
    const { node } = this.resolve(args.worker);
    const message = args.message.trim();
    if (!message) throw new ToolError("message 不能为空。");

    const session = await node.findSession(args.session);
    if (hasExited(session)) return this.relaunch(node, session, message);

    await this.channels.ensure(node);
    await node.post(session, masterMessage(message));
    const when =
      session.status === "busy"
        ? "它正在工作，会在当前工具调用结束后读到。"
        : session.status === "waiting"
          ? `它正卡在「${session.waitingFor ?? "等待输入"}」上，消息已排队，要等那个确认被处理后才会读到。`
          : "它处于空闲，已被唤醒。";
    return `已送达会话 ${session.id}（${session.name ?? "未命名"}）。${when}`;
  }

  async resume(args: SessionArgs & { message?: string; permission_mode?: PermissionMode }): Promise<string> {
    const { node } = this.resolve(args.worker);
    const session = await node.findSession(args.session);
    if (!hasExited(session)) {
      throw new ToolError(
        `会话 ${session.id} 还在运行（${session.status ?? session.state}），不需要续跑；直接用 worker_send 发消息。`,
      );
    }
    return this.relaunch(node, session, args.message?.trim(), args.permission_mode);
  }

  private async relaunch(
    node: WorkerNode,
    session: RemoteSession,
    message?: string,
    permissionMode?: PermissionMode,
  ): Promise<string> {
    if (!session.sessionId) throw new ToolError(`会话 ${session.id} 没有可续跑的对话记录。`);
    const channel = await this.channels.ensure(node);
    const name = session.name ?? randomName();
    const id = await node.launch({
      cwd: session.cwd ?? "~",
      name,
      prompt: masterMessage(message || "主节点让你从上次停下的地方继续。"),
      permissionMode: permissionMode ?? node.config.permissionMode,
      resumeSessionId: session.sessionId,
      channel,
    });
    this.remember(node, name);
    const changed = id === session.id ? "" : `\n注意：续跑后的会话 id 变成了 ${id}。`;
    return `会话 ${session.id} 的进程已退出，已在后台续跑${message ? "并带上了你的消息" : ""}。当前 id：${id}${changed}`;
  }

  // ---- status, stop, list

  async status(args: { worker?: string; session?: string }): Promise<string> {
    const { node } = this.resolve(args.worker);
    if (args.session) {
      const job = this.preparing.get(args.session);
      if (job) return this.describePreparing(job.worker).find((line) => line.includes(args.session!)) ?? "";
      const session = await node.findSession(args.session);
      return `${describeSession(session)}\n${JSON.stringify(session, null, 1)}`;
    }
    const lines = [...this.describePreparing(node.name), ...(await node.sessions(false)).map(describeSession)];
    if (lines.length === 0) return `worker「${node.name}」上没有活动的后台会话。`;
    return `worker「${node.name}」的活动会话：\n${lines.join("\n")}`;
  }

  async stop(args: SessionArgs): Promise<string> {
    const { node } = this.resolve(args.worker);
    const session = await node.findSession(args.session);
    await node.stop(session);
    return `已停止会话 ${session.id}（${session.name ?? "未命名"}）。对话保留，可用 worker_resume 续跑。`;
  }

  async list(): Promise<string> {
    const config = loadConfig();
    const blocks = await Promise.all(
      Object.keys(config.workers).map(async (name) => {
        try {
          const { node } = this.resolve(name);
          const sessions = await node.sessions();
          const link = this.channels.isOpen(name) ? "通道已连接" : "通道未连接（派发或发消息时自动建立）";
          const lines = [...this.describePreparing(name), ...sessions.map(describeSession)];
          const body = lines.length ? indent(lines) : "  （没有后台会话）";
          return `${name}（ssh: ${node.config.ssh}，${link}）\n${body}`;
        } catch (error) {
          return `${name}：无法查询（${errorText(error, 200)}）`;
        }
      }),
    );
    return blocks.join("\n\n");
  }

  // ---- usage, check

  private async localUsage(config: Config): Promise<Usage> {
    const claude = config.localClaudePath ?? process.env.CLAUDE_CODE_EXECPATH ?? "claude";
    const result = await run(claude, USAGE_ARGS, { cwd: os.homedir(), timeoutMs: 90_000 });
    return parseUsage(result.stdout);
  }

  async usage(args: { worker?: string }): Promise<string> {
    const config = loadConfig();
    const names = args.worker ? [pickWorker(config, args.worker)[0]] : Object.keys(config.workers);

    const local = this.localUsage(config)
      .then((usage) => `主节点（本机）\n${indent(usage.lines)}`)
      .catch((error) => `主节点（本机）：查询失败（${errorText(error, 200)}）`);

    const remote = names.map(async (name) => {
      try {
        const usage = await this.resolve(name).node.usage();
        const remaining = remainingPercent(usage);
        const low =
          remaining !== undefined && remaining < config.minRemainingPercent
            ? `\n  ⚠ 本周剩余 ${remaining}%，低于派发门槛 ${config.minRemainingPercent}%`
            : "";
        return `worker「${name}」\n${indent(usage.lines)}${low}`;
      } catch (error) {
        return `worker「${name}」：查询失败（${errorText(error, 200)}）`;
      }
    });
    return (await Promise.all([local, ...remote])).join("\n\n");
  }

  async check(args: { worker?: string; cwd?: string }): Promise<string> {
    const { node } = this.resolve(args.worker);
    const rows: string[] = [];
    const step = async (label: string, probe: () => Promise<string> | string): Promise<boolean> => {
      try {
        rows.push(`✓ ${label}：${await probe()}`);
        return true;
      } catch (error) {
        rows.push(`✗ ${label}：${errorText(error)}`);
        return false;
      }
    };

    if (await step("SSH 连接", () => node.hostname())) {
      await step("claude", () => node.version("claude"));
      await step("node", () => node.version("node"));
      await step("worker 脚本", async () => ((await node.ensureScript()) ? "已更新" : "版本一致"));
      await step("登录与额度", async () => (await node.usage()).lines.join("；"));
      await step("主会话收件箱", () => {
        const inbox = ownSessionInbox();
        if (!inbox) throw new ToolError("找不到，worker 的消息将无法送达");
        return inbox;
      });
      const root = node.config.workRoot;
      await step("workRoot 信任", async () => {
        const state = await node.ensureWorkRootTrusted();
        if (state === "untrusted") {
          throw new ToolError(
            `${root} 未被信任：请在 worker 上进入该目录运行一次 claude 并接受信任提示，或在节点配置里设置 "trustWorkRoot": true`,
          );
        }
        return state === "just-trusted" ? `${root} 已自动信任（trustWorkRoot 已开启）` : `${root} 已信任`;
      });
      const cwd = args.cwd;
      if (cwd && cwd !== root) {
        await step("目录信任", async () => {
          if (await node.isTrusted(cwd)) return `${cwd} 已信任`;
          throw new ToolError(`${cwd} 未被信任：请在 worker 上进入该目录运行一次 claude 并接受信任提示`);
        });
      }
    }
    rows.push(`权限模式默认值：${node.config.permissionMode}`);
    return `节点「${node.name}」自检：\n${rows.join("\n")}`;
  }
}
