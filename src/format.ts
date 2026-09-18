import type { AuditRow } from "./audit-log.js";

const ROUTE_LABEL: Record<AuditRow["route"], string> = {
  rule_allow: "rule pre-approved",
  rule_deny: "HARD BLOCK",
  auto_allow: "auto-allow",
  auto_deny: "auto-deny",
  human_allow: "human allowed",
  human_deny: "human denied",
  llm_allow: "llm allowed",
  llm_deny: "llm denied",
  failed_closed: "failed closed",
};

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function formatAuditRow(row: AuditRow): string {
  const time = row.timestamp.slice(11, 19); // HH:MM:SS

  if (row.route === "rule_allow" || row.route === "rule_deny") {
    const rule = row.matchedRule;
    return (
      `${time}  ${ROUTE_LABEL[row.route].padEnd(14)} ${truncate(row.command, 70)}` +
      (rule ? `\n           matched rule: "${rule.pattern}" (weight ${rule.weight})${rule.reason ? ` - ${rule.reason}` : ""}` : "")
    );
  }

  const jev = row.jev;
  const risk = jev ? jev.riskScore.toFixed(2) : "?";
  const conf = jev ? jev.confidence.toFixed(2) : "?";
  const flags = jev
    ? Object.entries(jev.flags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",")
    : "";
  const branch = row.git?.isGitRepo ? ` [${row.git.branch}${row.git.isProtectedBranch ? "*" : ""}]` : "";
  // Older log rows predate the primaryConcern field - guard for undefined.
  const why = jev?.primaryConcern ? jev.primaryConcern.replace(/_/g, " ") : undefined;
  const llmLine = row.llmEscalation
    ? `\n           llm (${row.llmEscalation.modelUsed ?? "?"}): ${truncate(row.llmEscalation.rationale, 80)}`
    : "";
  return (
    `${time}  ${ROUTE_LABEL[row.route].padEnd(14)} risk=${risk} conf=${conf}` +
    `${branch}  ${truncate(row.command, 70)}` +
    (why ? `\n           why: ${why}` : "") +
    (flags ? `\n           flags: ${flags}` : "") +
    llmLine
  );
}

export function formatRecentDecisions(rows: AuditRow[]): string {
  if (rows.length === 0) {
    return "No decisions logged yet.";
  }
  const lines = [...rows].reverse().map(formatAuditRow); // most recent first
  return `Last ${rows.length} decision(s) (most recent first, * = protected branch):\n\n${lines.join("\n")}`;
}
