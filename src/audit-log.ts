// Append-only JSONL log of every decision this extension makes. Doubles as
// training data: each row pairs Jev's judgment with the human's actual
// decision (when one was asked for), which is exactly the labeled data you
// need to later fit a lightweight classical model on top of Jev's features.

import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { JevVerdict } from "./jev-client.js";
import type { GitContext } from "./git-context.js";
import type { ProjectContext } from "./project-context.js";
import type { EscalationVerdict } from "./llm-escalation.js";

export function logPath(): string {
  return join(homedir(), ".pi", "pi-jev-approver", "audit.jsonl");
}

export function exportsDir(): string {
  return join(homedir(), ".pi", "pi-jev-approver", "exports");
}

export interface AuditRow {
  timestamp: string;
  command: string;
  // Absent for rule_allow/rule_deny - those never call Jev or compute
  // context at all, that's the entire point of a hard config rule.
  jev?: JevVerdict;
  git?: GitContext;
  project?: ProjectContext;
  route:
    | "rule_allow"
    | "rule_deny"
    | "auto_allow"
    | "auto_deny"
    | "human_allow"
    | "human_deny"
    | "llm_allow"
    | "llm_deny"
    | "failed_closed";
  humanApproved?: boolean;
  humanReason?: string;
  llmEscalation?: EscalationVerdict;
  matchedRule?: { pattern: string; weight: number; reason?: string };
}

export interface PriorDecisions {
  timesSeen: number;
  humanAllowed: number;
  humanDenied: number;
  lastReason?: string;
}

// Looks up every past decision for the exact same (redacted) command string,
// so it can be fed back into Jev's state on the next classification of that
// command - "a human has approved this exact command 3 times before, most
// recently with reason X" is real signal Jev didn't have access to otherwise.
// Exact-match only: no fuzzy/prefix matching, to avoid conflating unrelated
// commands that merely look similar.
export async function getPriorDecisions(redactedCommand: string, scanLimit = 500): Promise<PriorDecisions> {
  const rows = await readRecentRows(scanLimit);
  const matches = rows.filter((row) => row.command === redactedCommand);

  const result: PriorDecisions = { timesSeen: matches.length, humanAllowed: 0, humanDenied: 0 };
  for (const row of matches) {
    if (row.route === "human_allow") result.humanAllowed++;
    if (row.route === "human_deny") result.humanDenied++;
    if (row.humanReason) result.lastReason = row.humanReason;
  }
  return result;
}

export async function writeAuditRow(row: AuditRow): Promise<void> {
  const path = logPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(row) + "\n", "utf8");
  } catch {
    // Logging must never block or fail a tool call.
  }
}

// Reads the last `limit` rows from the audit log, oldest first, skipping
// any malformed lines rather than failing the whole read.
export async function readRecentRows(limit: number): Promise<AuditRow[]> {
  let content: string;
  try {
    content = await readFile(logPath(), "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const rows: AuditRow[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      rows.push(JSON.parse(line) as AuditRow);
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

// Copies the current audit log to a timestamped file in exportsDir(), for
// the user to manually inspect/share. Every row was already redacted at
// write time (see redact.ts), but redaction is best-effort - review the
// export before sending it anywhere.
export async function exportAuditLog(): Promise<string> {
  const dest = join(exportsDir(), `export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await mkdir(exportsDir(), { recursive: true });
  await copyFile(logPath(), dest);
  return dest;
}
