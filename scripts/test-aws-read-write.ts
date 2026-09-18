// Demonstrates: allow AWS reads via a hard rule, let AWS writes fall
// through to the normal Jev pipeline (no deny rule needed for writes).

import { compileRules, matchCommand, type CommandRule } from "../src/command-rules.js";
import { classifyCommand } from "../src/jev-client.js";

const rules: CommandRule[] = [
  {
    pattern: "^aws\\s+\\S+\\s+(describe|list|get|head|lookup|ls)[a-z0-9-]*\\b",
    action: "allow",
    weight: 20,
    reason: "AWS CLI read-only operation",
  },
];
const compiled = compileRules(rules);

const cases = [
  "aws s3 ls s3://prod-bucket/",
  "aws ec2 describe-instances",
  "aws sts get-caller-identity",
  "aws s3 rm s3://prod-bucket/report.csv",
  "aws ec2 terminate-instances --instance-ids i-1234567890abcdef0",
  "aws iam create-user --user-name test",
];

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;

  for (const command of cases) {
    const match = matchCommand(command, compiled);
    if (match) {
      console.log(`${command}\n  -> RULE: ${match.action} (${match.reason}) - Jev never called`);
      continue;
    }
    if (!apiKey) {
      console.log(`${command}\n  -> no rule match; would go to Jev (no TYPESAFE_API_KEY set to demo it live)`);
      continue;
    }
    const verdict = await classifyCommand(command, apiKey, undefined, undefined, undefined, {
      aws_command: "This command interacts with AWS infrastructure and could affect live cloud resources or incur cost",
    });
    console.log(
      `${command}\n  -> no rule match; Jev: risk=${verdict.riskScore.toFixed(2)} conf=${verdict.confidence.toFixed(2)} why=${verdict.primaryConcern}`,
    );
  }
}

main();
