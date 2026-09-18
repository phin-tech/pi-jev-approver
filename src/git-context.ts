// Cheap, best-effort git context for the current cwd - current branch and
// whether it looks "protected" (main/master/release/etc). Used as extra
// state for Jev's judgment (a push to main should read as riskier than the
// same push to a feature branch) and as its own feature for later training.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROTECTED_BRANCH_PATTERNS = [/^main$/, /^master$/, /^prod(uction)?$/, /^release\//, /^deploy\//];

export interface GitContext {
  isGitRepo: boolean;
  branch?: string;
  isProtectedBranch: boolean;
  hasUncommittedChanges?: boolean;
}

async function run(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function getGitContext(cwd: string): Promise<GitContext> {
  const branch = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) {
    return { isGitRepo: false, isProtectedBranch: false };
  }

  const status = await run(cwd, ["status", "--porcelain"]);
  const isProtectedBranch = PROTECTED_BRANCH_PATTERNS.some((p) => p.test(branch));

  return {
    isGitRepo: true,
    branch,
    isProtectedBranch,
    hasUncommittedChanges: status !== undefined ? status.length > 0 : undefined,
  };
}
