// Cheap, best-effort project ecosystem detection from cwd: which language
// package manager this project uses, purely from marker files present. Used
// as extra state for Jev (a publish command means something different, and
// is riskier, in a Python project than an npm postinstall does) and to
// recognize registry-publish commands as their own flag - "affects shared
// state" undersells "this goes out to the public npm/PyPI/crates.io registry
// and generally can't be taken back."

import { access } from "node:fs/promises";
import { join } from "node:path";

export type Ecosystem = "node" | "python" | "rust" | "go" | "ruby" | "java" | "unknown";

const MARKERS: Array<[string, Ecosystem]> = [
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["Gemfile", "ruby"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
];

// Commands that publish to a public package registry - essentially
// irreversible (you can yank/deprecate a version, rarely delete it) and
// visible to anyone who depends on the package, not just your team.
const PUBLISH_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bcargo\s+publish\b/,
  /\bgem\s+push\b/,
  /\bmvn\s+deploy\b/,
];

export interface ProjectContext {
  ecosystem: Ecosystem;
  looksLikePublishCommand: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getProjectContext(cwd: string, command: string): Promise<ProjectContext> {
  let ecosystem: Ecosystem = "unknown";
  for (const [marker, lang] of MARKERS) {
    if (await exists(join(cwd, marker))) {
      ecosystem = lang;
      break;
    }
  }

  return {
    ecosystem,
    looksLikePublishCommand: PUBLISH_COMMAND_PATTERNS.some((p) => p.test(command)),
  };
}
