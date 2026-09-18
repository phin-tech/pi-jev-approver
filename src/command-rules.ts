// User-configured regex rules that hard-override Jev entirely - a "deny"
// rule means genuinely verboten: never runs, no matter what Jev or an
// escalated LLM would have said, since neither can be trusted 100% of the
// time and some commands need a guarantee stronger than a probabilistic
// judgment. An "allow" rule skips the Jev call for known-safe commands
// (cheaper and faster, not just more lenient).
//
// This check runs first, before any context is even computed - that's the
// point: a rule match short-circuits everything else in decision.ts.

export interface CommandRule {
  pattern: string;
  // Regex flags, default "i" - shell commands aren't case-meaningful in any
  // way that would cause a spurious match ("DROP TABLE" and "drop table"
  // are the same risk), and a verboten-command list written in one casing
  // must still catch the other. Pass "" explicitly for case-sensitive.
  flags?: string;
  action: "allow" | "deny";
  weight: number;
  reason?: string;
}

export interface MatchedRule extends CommandRule {
  regex: RegExp;
}

const MAX_RULES = 50;

// A rule needs a compiled RegExp per use; compile once here rather than on
// every command. Invalid patterns are dropped (fail open on the individual
// rule, not on the whole config) since a typo'd regex must never crash
// command evaluation - it would either silently stop protecting anything
// (bad) or block everything (also bad, and confusing to debug).
export function compileRules(rules: CommandRule[]): MatchedRule[] {
  const compiled: MatchedRule[] = [];
  for (const rule of rules.slice(0, MAX_RULES)) {
    try {
      compiled.push({ ...rule, regex: new RegExp(rule.pattern, rule.flags ?? "i") });
    } catch {
      // drop silently at this layer - config.ts is responsible for
      // surfacing a warning to the user at load time if it wants to
    }
  }
  return compiled;
}

// Highest weight wins. On an exact tie, deny wins over allow - a config
// mistake that leaves two contradictory rules at the same weight must fail
// toward caution, not toward silently allowing something meant to be
// verboten.
export function matchCommand(command: string, rules: MatchedRule[]): MatchedRule | undefined {
  let best: MatchedRule | undefined;
  for (const rule of rules) {
    if (!rule.regex.test(command)) continue;
    if (
      !best ||
      rule.weight > best.weight ||
      (rule.weight === best.weight && rule.action === "deny" && best.action === "allow")
    ) {
      best = rule;
    }
  }
  return best;
}
