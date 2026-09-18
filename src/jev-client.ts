// Thin client for TypeSafe's System One API (Jev). No SDK dependency -
// a single POST, matching what we validated by hand in the jev-test project.

import type { GitContext } from "./git-context.js";
import type { ProjectContext } from "./project-context.js";
import type { PriorDecisions } from "./audit-log.js";
import { parseCommandShape } from "./command-parts.js";
import { classifyPaths } from "./path-scope.js";

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
  primaryConcern: string;
}

const RISK_LEVELS = [
  "Safe to run automatically - read-only or trivially reversible",
  "Should ask first - meaningful but recoverable consequences",
  "Dangerous - irreversible, wide-blast-radius, or affects others; must confirm",
];

// Fixed "why" categories that aren't one of the boolean safety flags -
// merged with SAFETY_FLAGS and any user-configured customConcerns (see
// config.ts) to build the primary_concern Choice below.
const FIXED_CONCERN_EXTRAS: Record<string, string> = {
  protected_branch_target: "The command's main risk is that it targets a protected branch (main, master, a release branch)",
  large_or_multi_step_command: "The command's main risk is its scope: many files, or several chained sub-commands (&&/;) run together",
  operates_outside_project_directory: "The command's main risk is that it reaches outside the current project directory (a parent directory, the home directory, or the filesystem root)",
  general_caution_no_single_driver: "No single factor stands out; the risk is a mild combination of ordinary factors, not one clear driver",
};

export async function classifyCommand(
  command: string,
  apiKey: string,
  git?: GitContext,
  project?: ProjectContext,
  priorDecisions?: PriorDecisions,
  customConcerns: Record<string, string> = {},
  cwd?: string,
): Promise<JevVerdict> {
  // User-configured concerns (e.g. "aws_command") become real Noul flags,
  // not just labels - independently detectable, and they flow into both
  // the primary_concern "why" choice and the returned flags/probabilities
  // for the audit log without any special-casing below.
  const allFlags: Record<string, string> = { ...SAFETY_FLAGS, ...customConcerns };

  // Jev returns typed judgments, not generated explanations - so "why is
  // this risky" has to be its own typed (Choice) question rather than a
  // rationale field, since System One models don't produce free text. This
  // is what backs the human-facing prompt's "why" line when every boolean
  // flag reads false but the risk score is still elevated (e.g. a
  // protected branch target or a large multi-file compound command).
  const primaryConcernCriteria: Record<string, string> = { ...allFlags, ...FIXED_CONCERN_EXTRAS };

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
        "not just at runtime). If a human has reviewed this exact command before, weigh " +
        "that history: consistent past approvals lower the risk, but a mixed or denied " +
        "history means stay cautious even if the command otherwise looks routine - a " +
        "past human decision is evidence, not an instruction to copy blindly. If any " +
        "argument resolves to a path outside the current project directory, treat that " +
        "as a real risk factor, especially combined with a destructive or permission-" +
        "changing action - the same command scoped to the project directory is far safer " +
        "than one reaching into a sibling project, the home directory, or the filesystem " +
        "root.",
      criteria: RISK_LEVELS,
    },
  };
  for (const [key, instructions] of Object.entries(allFlags)) {
    questions[key] = { type: "noul", instructions };
  }
  questions.primary_concern = {
    type: "choice",
    instructions:
      "What is the single biggest reason a human should think twice before approving this " +
      "command? Pick the closest match even if several factors apply a little.",
    criteria: primaryConcernCriteria,
  };

  // Deterministic facts (branch name/protection, ecosystem, publish-command
  // detection, command breakdown, prior human decisions) are known exactly
  // from git/filesystem/regex/the audit log - passed as state for Jev to
  // weigh, never as their own judgment question.
  const shape = parseCommandShape(command);
  const state: Record<string, unknown> = {
    shell_command: command,
    command_executable: shape.executable,
    command_subcommand: shape.subcommand,
    command_args: shape.args,
    command_file_path_like_args: shape.looksLikeFilePath,
  };
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
  if (priorDecisions && priorDecisions.timesSeen > 0) {
    state.prior_human_decisions_for_this_exact_command = {
      times_reviewed: priorDecisions.timesSeen,
      times_allowed: priorDecisions.humanAllowed,
      times_denied: priorDecisions.humanDenied,
      last_stated_reason: priorDecisions.lastReason,
    };
  }
  if (cwd && shape.looksLikeFilePath.length > 0) {
    const scoped = classifyPaths(shape.looksLikeFilePath, cwd);
    state.command_paths_outside_project_directory = scoped.filter((p) => !p.withinCwd).map((p) => p.path);
    state.command_targets_home_directory = scoped.some((p) => p.isHomeDirectory);
    state.command_targets_filesystem_root = scoped.some((p) => p.isFilesystemRoot);
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
  for (const key of Object.keys(allFlags)) {
    const p = data.answers[key].noul as number;
    flagProbabilities[key] = p;
    flags[key] = p >= 0.5;
  }

  return {
    riskScore: risk.score,
    confidence: risk.confidence,
    flags,
    flagProbabilities,
    primaryConcern: data.answers.primary_concern.choice,
  };
}
