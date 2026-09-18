import { classifyCommand } from "../src/jev-client.js";
import { loadConfig } from "../src/config.js";

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY not set");

  const config = await loadConfig();
  console.log("loaded custom concerns:", Object.keys(config.customConcerns));

  const commands = [
    "aws s3 rm s3://prod-user-uploads/2026/report.csv",
    "kubectl config use-context prod-cluster && kubectl delete pod payments-worker-0",
    "ls -la",
  ];

  for (const command of commands) {
    const verdict = await classifyCommand(command, apiKey, undefined, undefined, undefined, config.customConcerns);
    console.log(`\n${command}`);
    console.log(`  risk=${verdict.riskScore.toFixed(2)} conf=${verdict.confidence.toFixed(2)} why=${verdict.primaryConcern}`);
    console.log(`  flags:`, verdict.flags);
  }
}

main();
