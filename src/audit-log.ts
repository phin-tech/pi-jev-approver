// Append-only JSONL log of every decision this extension makes. Doubles as
// training data: each row pairs Jev's judgment with the human's actual
// decision (when one was asked for), which is exactly the labeled data you
// need to later fit a lightweight classical model on top of Jev's features.

import { appendFile, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { JevVerdict } from "./jev-client.js";
import type { GitContext } from "./git-context.js";
import type { ProjectContext } from "./project-context.js";

export function logPath(): string {
  return join(homedir(), ".pi", "pi-jev-approver", "audit.jsonl");
}

export function exportsDir(): string {
  return join(homedir(), ".pi", "pi-jev-approver", "exports");
}

export interface AuditRow {
  timestamp: string;
  command: string;
  jev: JevVerdict;
  git: GitContext;
  project: ProjectContext;
  route: "auto_allow" | "auto_deny" | "human_allow" | "human_deny" | "failed_closed";
  humanApproved?: boolean;
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
