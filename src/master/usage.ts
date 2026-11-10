/** Reading an account's quota from `claude -p /usage`, which costs nothing to run. */
import { ToolError } from "../shared/tooling.ts";

export interface Usage {
  /** The "… % used · resets …" lines, as Claude Code prints them. */
  lines: string[];
  /** Share of the weekly all-models quota already used, when reported. */
  weekUsedPercent?: number;
}

/** Arguments that make `claude` print usage as JSON and exit. */
export const USAGE_ARGS = ["-p", "/usage", "--output-format", "json"];

/** Parses the JSON that `claude -p /usage --output-format json` prints. */
export function parseUsage(output: string): Usage {
  let text: unknown;
  try {
    text = JSON.parse(output.slice(output.indexOf("{"))).result;
  } catch {
    throw new ToolError(`无法解析额度输出：${output.slice(0, 300)}`);
  }
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("% used"));
  if (lines.length === 0) throw new ToolError(`额度输出里没有用量信息：${String(text).slice(0, 300)}`);

  const week = lines.map((line) => /week \(all models\):\s*(\d+)% used/.exec(line)).find(Boolean);
  return { lines, weekUsedPercent: week ? Number(week[1]) : undefined };
}

export function remainingPercent(usage: Usage): number | undefined {
  return usage.weekUsedPercent === undefined ? undefined : 100 - usage.weekUsedPercent;
}
