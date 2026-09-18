import type { ExtensionAPI, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { evaluateToolCall } from "./src/decision.js";
import { exportAuditLog, logPath } from "./src/audit-log.js";

const STATUS_KEY = "pi-jev-approver";

export default function piJevApproverExtension(pi: ExtensionAPI): void {
  const apiKey = process.env.TYPESAFE_API_KEY;

  pi.registerCommand?.("jev-approver", {
    description: "args: status | export - status shows config, export copies the redacted audit log for sharing",
    handler: async (args, ctx: ExtensionContextLike) => {
      const command = args.trim().split(/\s+/)[0] || "status";
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
      ctx.ui?.notify?.(
        [
          `enabled: ${Boolean(apiKey)}`,
          apiKey ? "" : "TYPESAFE_API_KEY is not set - all bash calls will fail closed.",
          `audit log: ${logPath()}`,
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
