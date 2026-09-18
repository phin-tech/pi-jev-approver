// Thin client for TypeSafe's System One API (Jev). No SDK dependency -
// a single POST, matching what we validated by hand in the jev-test project.

import type { GitContext } from "./git-context.js";
import type { ProjectContext } from "./project-context.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const SAFETY_FLAGS: Record<string, string> = {
  destructive: "Does this command delete, overwrite, or irreversibly discard local data or files?",
  hard_to_reverse:
    "If this command has an unwanted effect, would it be difficult or impossible to undo (distinct from destructive - e.g. force-push overwrites remote history, not just local files)?",
  affects_shared_or_remote_state:
    "Does this command change state visible to other people or systems (a remote server, a shared repo, a deployed service), as opposed to only the local machine?",
  downloads_and_executes_code: "Does this command fetch code or a script from the network and execute it?",
  modifies_permissions_or_ownership:
    "Does this command change file/directory permissions, ownership, or system-level access control?",
};

export interface JevVerdict {
  riskScore: number; // 0-2, see RISK_LEVELS below
  confidence: number; // 0-1
  flags: Record<string, boolean>;
  flagProbabilities: Record<string, number>;
}

const RISK_LEVELS = [
  "Safe to run automatically - read-only or trivially reversible",
  "Should ask first - meaningful but recoverable consequences",
  "Dangerous - irreversible, wide-blast-radius, or affects others; must confirm",
];

export async function classifyCommand(
  command: string,
  apiKey: string,
  git?: GitContext,
  project?: ProjectContext,
): Promise<JevVerdict> {
  const questions: Record<string, unknown> = {
    risk_level: {
      type: "score",
      instructions:
        "How risky is it to run this command without explicit human confirmation? " +
        "If the command pushes, deploys, or otherwise sends changes to a remote/shared " +
        "target, weigh the current git branch: the same command is riskier on a " +
        "protected branch (main, master, a release branch) than on a throwaway " +
        "feature branch, since it affects what everyone else sees. If the command " +
        "publishes to a public package registry (npm, PyPI, crates.io, etc.), treat " +
        "that as high risk regardless of branch - a published package version is " +
        "visible to everyone who depends on it and is effectively permanent even if " +
        "later deprecated. Also weigh the project's language ecosystem when judging " +
        "whether installing dependencies executes arbitrary code (e.g. npm postinstall " +
        "scripts, Python setup.py, Rust build.rs all run code during install/build, " +
        "not just at runtime).",
      criteria: RISK_LEVELS,
    },
  };
  for (const [key, instructions] of Object.entries(SAFETY_FLAGS)) {
    questions[key] = { type: "noul", instructions };
  }

  // Deterministic facts (branch name/protection, ecosystem, publish-command
  // detection) are known exactly from git/filesystem/regex - passed as
  // state for Jev to weigh, never as their own judgment question.
  const state: Record<string, unknown> = { shell_command: command };
  if (git?.isGitRepo) {
    state.git_branch = git.branch;
    state.git_branch_is_protected = git.isProtectedBranch;
    if (git.hasUncommittedChanges !== undefined) {
      state.git_has_uncommitted_changes = git.hasUncommittedChanges;
    }
  }
  if (project) {
    state.project_ecosystem = project.ecosystem;
    state.looks_like_public_registry_publish = project.looksLikePublishCommand;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: "jev-latest",
      questions,
    }),
  });

  if (!response.ok) {
    throw new Error(`Jev request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const risk = data.answers.risk_level;
  const flags: Record<string, boolean> = {};
  const flagProbabilities: Record<string, number> = {};
  for (const key of Object.keys(SAFETY_FLAGS)) {
    const p = data.answers[key].noul as number;
    flagProbabilities[key] = p;
    flags[key] = p >= 0.5;
  }

  return {
    riskScore: risk.score,
    confidence: risk.confidence,
    flags,
    flagProbabilities,
  };
}
