import { compileRules, matchCommand, type CommandRule } from "../src/command-rules.js";

const rules: CommandRule[] = [
  { pattern: "^git status", action: "allow", weight: 10, reason: "always safe" },
  { pattern: "drop\\s+(table|database)", action: "deny", weight: 100, reason: "never run raw SQL drops" },
  { pattern: "^rm -rf /(\\s|$)", action: "deny", weight: 100, reason: "never rm -rf root" },
  // deliberately invalid regex - should be dropped, not crash
  { pattern: "([unterminated", action: "deny", weight: 50 },
  // tie-break case: same weight, allow vs deny - deny should win
  { pattern: "^tie-test$", action: "allow", weight: 5 },
  { pattern: "^tie-test$", action: "deny", weight: 5, reason: "deny should win the tie" },
];

const compiled = compileRules(rules);
console.log(`compiled ${compiled.length}/${rules.length} rules (1 invalid dropped)\n`);

const cases = [
  "git status --short",
  "DROP TABLE users;",
  "rm -rf /",
  "rm -rf /tmp/scratch",
  "tie-test",
  "echo hello",
];

for (const command of cases) {
  const match = matchCommand(command, compiled);
  console.log(command, "->", match ? `${match.action} (weight ${match.weight}, ${match.reason ?? "no reason"})` : "no match");
}
