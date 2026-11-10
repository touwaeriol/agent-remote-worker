import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A failure the model should read and act on, as opposed to a bug. */
export class ToolError extends Error {}

/** Wraps a tool body so it returns plain text and reports failures instead of throwing. */
export function textTool<Args>(body: (args: Args) => Promise<string> | string) {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: await body(args) }] };
    } catch (error) {
      const text =
        error instanceof ToolError
          ? error.message
          : `内部错误：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      return { content: [{ type: "text", text }], isError: true };
    }
  };
}

export function errorText(error: unknown, limit = 300): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}
