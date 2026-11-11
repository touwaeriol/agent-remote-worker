/** The MCP server a worker session loads: its only way to talk to the master. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { postToInbox } from "../shared/inbox.ts";
import { VERSION, WORKER_SERVER, workerMessage, type ReportKind } from "../shared/protocol.ts";
import { ToolError, errorText, textTool } from "../shared/tooling.ts";
import { currentMaster } from "./routes.ts";

export async function serveWorker(): Promise<void> {
  const masterSocket = process.env.CW_MASTER_SOCK ?? "";
  const worker = process.env.CW_WORKER ?? "worker";
  const session = process.env.CW_SESSION ?? "?";

  const deliver = async (kind: ReportKind, body: string) => {
    if (!body.trim()) throw new ToolError("消息内容为空。");
    try {
      // The master that last dispatched, messaged or resumed this session.
      await postToInbox(currentMaster(session, masterSocket).socket, workerMessage(worker, session, kind, body));
    } catch (error) {
      throw new ToolError(
        `未送达：主节点当前不在线（${errorText(error, 80)}）。可以稍后重试，或先继续工作，主节点重连后会让你重新汇报。`,
      );
    }
  };

  const server = new McpServer({ name: WORKER_SERVER, version: VERSION });

  server.registerTool(
    "report_to_master",
    {
      description:
        "向主节点（派发任务给你的那个 Claude）发送一条消息，发完可以继续工作。" +
        "kind: progress=进度或中途发现，done=任务完成（写明做了什么、分支名、如何验证），blocked=遇到无法自行解决的阻碍。" +
        "主节点看不到你的屏幕输出，只能看到你用本工具发送的内容。",
      inputSchema: {
        kind: z.enum(["progress", "done", "blocked"]),
        message: z.string(),
      },
    },
    textTool(async ({ kind, message }) => {
      await deliver(kind, message);
      return "已送达主节点。";
    }),
  );

  server.registerTool(
    "ask_master",
    {
      description:
        "向主节点提问并等待回复。调用后请结束当前这一轮；回复会作为一条以 [master] 开头的消息出现。" +
        "只在确实需要主节点做决定时使用。",
      inputSchema: { question: z.string() },
    },
    textTool(async ({ question }) => {
      await deliver("question", question);
      return "问题已送达主节点。现在结束这一轮并等待：主节点的回复会作为一条以 [master] 开头的消息出现。";
    }),
  );

  await server.connect(new StdioServerTransport());
}
