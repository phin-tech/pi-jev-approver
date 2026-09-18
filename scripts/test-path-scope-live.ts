import { classifyCommand } from "../src/jev-client.js";

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY not set");

  const cwd = "/Users/sam/src/myproject";

  const cases = [
    "rm -rf ./build",
    "rm -rf ../../other-project",
    "rm -rf ~",
    "rm -rf /",
  ];

  for (const command of cases) {
    const verdict = await classifyCommand(command, apiKey, undefined, undefined, undefined, {}, cwd);
    console.log(`\n${command}`);
    console.log(
      `  risk=${verdict.riskScore.toFixed(2)} conf=${verdict.confidence.toFixed(2)} why=${verdict.primaryConcern}`,
    );
  }
}

main();
