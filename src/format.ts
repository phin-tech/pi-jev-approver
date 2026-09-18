import type { AuditRow } from "./audit-log.js";

const ROUTE_LABEL: Record<AuditRow["route"], string> = {
  auto_allow: "auto-allow",
  auto_deny: "auto-deny",
  human_allow: "human allowed",
  human_deny: "human denied",
  failed_closed: "failed closed",
};

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function formatAuditRow(row: AuditRow): string {
  const time = row.timestamp.slice(11, 19); // HH:MM:SS
  const risk = row.jev.riskScore.toFixed(2);
  const conf = row.jev.confidence.toFixed(2);
  const flags = Object.entries(row.jev.flags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",");
  const branch = row.git.isGitRepo
    ? ` [${row.git.branch}${row.git.isProtectedBranch ? "*" : ""}]`
    : "";
  // Older log rows predate the primaryConcern field - guard for undefined.
  const why = row.jev.primaryConcern ? row.jev.primaryConcern.replace(/_/g, " ") : undefined;
  return (
    `${time}  ${ROUTE_LABEL[row.route].padEnd(14)} risk=${risk} conf=${conf}` +
    `${branch}  ${truncate(row.command, 70)}` +
    (why ? `\n           why: ${why}` : "") +
    (flags ? `\n           flags: ${flags}` : "")
  );
}

export function formatRecentDecisions(rows: AuditRow[]): string {
  if (rows.length === 0) {
    return "No decisions logged yet.";
  }
  const lines = [...rows].reverse().map(formatAuditRow); // most recent first
  return `Last ${rows.length} decision(s) (most recent first, * = protected branch):\n\n${lines.join("\n")}`;
}
