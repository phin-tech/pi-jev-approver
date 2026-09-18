// Compares a command's file-path-like arguments against the actual cwd -
// deterministic (path resolution, not judgment), fed to Jev as state. Catches
// the case flags/scoring alone miss: `rm -rf ../../other-project` or
// `rm -rf ~` look identical to a scoped `rm -rf ./build` by the flags we ask
// about (both "destructive"), but one stays inside the current project and
// the other reaches well outside it.

import { resolve } from "node:path";
import { homedir } from "node:os";

export interface PathScopeResult {
  path: string;
  withinCwd: boolean;
  isHomeDirectory: boolean;
  isFilesystemRoot: boolean;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

export function classifyPaths(paths: string[], cwd: string): PathScopeResult[] {
  const resolvedCwd = resolve(cwd);
  return paths.map((path) => {
    const resolvedPath = resolve(cwd, expandHome(path));
    const withinCwd = resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + "/");
    return {
      path,
      withinCwd,
      isHomeDirectory: resolvedPath === homedir(),
      isFilesystemRoot: resolvedPath === "/",
    };
  });
}
