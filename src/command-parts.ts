// Best-effort breakdown of a shell command into its executable, subcommand,
// and remaining args/flags - fed to Jev as separate named state fields
// rather than one raw string, since a named-field breakdown is easier for
// it to weigh precisely (e.g. judging "rm" vs "-rf" vs the target path as
// distinct signals instead of parsing them back out of prose).
//
// This is NOT used to loosen the prior-decisions exact-match key (see
// audit-log.ts) - grouping by executable/subcommand alone would conflate
// commands with very different risk profiles, e.g. `git push origin
// feature-x` and `git push --force origin main` are both "git push".

export interface CommandShape {
  executable: string;
  subcommand?: string;
  args: string[];
  looksLikeFilePath: string[];
}

// Simple whitespace/quote-aware tokenizer - not a full shell parser (no
// pipes/redirects/expansion handling), good enough for pulling out the
// leading executable and subcommand.
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function looksLikePath(token: string): boolean {
  return token.includes("/") || token.startsWith("~") || token.startsWith(".");
}

export function parseCommandShape(command: string): CommandShape {
  const tokens = tokenize(command);
  const executable = tokens[0] ?? "";
  const rest = tokens.slice(1);

  // Second token counts as a "subcommand" only if it doesn't look like a
  // flag or a path - e.g. `git push` (subcommand: push) vs `rm -rf foo`
  // (no subcommand, -rf is a flag).
  const second = rest[0];
  const hasSubcommand = second !== undefined && !second.startsWith("-") && !looksLikePath(second);
  const subcommand = hasSubcommand ? second : undefined;
  const args = hasSubcommand ? rest.slice(1) : rest;

  return {
    executable,
    subcommand,
    args,
    looksLikeFilePath: args.filter(looksLikePath),
  };
}
