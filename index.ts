import type { ExtensionAPI, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { evaluateToolCall } from "./src/decision.js";
import { exportAuditLog, logPath, readRecentRows } from "./src/audit-log.js";
import { formatRecentDecisions } from "./src/format.js";

const STATUS_KEY = "pi-jev-approver";
const DEFAULT_RECENT_LIMIT = 15;

export default function piJevApproverExtension(pi: ExtensionAPI): void {
  const apiKey = process.env.TYPESAFE_API_KEY;

  pi.registerCommand?.("jev-approver", {
    description: "args: status | recent [n] | export - recent shows the last n decisions with scores",
    handler: async (args, ctx: ExtensionContextLike) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const command = parts[0] || "status";

      if (command === "export") {
        try {
          const dest = await exportAuditLog();
          ctx.ui?.notify?.(
            `Exported redacted audit log to:\n  ${dest}\nReview it before sharing - redaction is best-effort, not a guarantee.`,
          );
        } catch (error) {
          ctx.ui?.notify?.(`Export failed: ${String(error)}`, "error");
        }
        return;
      }

      if (command === "recent") {
        const requested = Number.parseInt(parts[1] ?? "", 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_RECENT_LIMIT;
        const rows = await readRecentRows(limit);
        ctx.ui?.notify?.(formatRecentDecisions(rows));
        return;
      }

      ctx.ui?.notify?.(
        [
          `enabled: ${Boolean(apiKey)}`,
          apiKey ? "" : "TYPESAFE_API_KEY is not set - all bash calls will fail closed.",
          `audit log: ${logPath()}`,
          `run "/jev-approver recent [n]" to see recent decisions and scores`,
          `run "/jev-approver export" to copy a shareable, redacted snapshot`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContextLike) => {
    ctx.ui?.setStatus?.(STATUS_KEY, apiKey ? "jev-approver" : "jev-approver (no key)");
  });

  pi.on("tool_call", async (event: ToolCallEventLike, ctx: ExtensionContextLike) => {
    if (!apiKey) {
      const toolName = (event.toolName ?? event.name) as string | undefined;
      if (toolName !== "bash") return {};
      return { block: true, reason: "pi-jev-approver: TYPESAFE_API_KEY is not set." };
    }
    return evaluateToolCall(event, ctx, apiKey);
  });
}
