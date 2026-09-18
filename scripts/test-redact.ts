// Sanity-check the redaction patterns against realistic sensitive commands.
// Not a rigorous test suite - a spot check to catch obvious regressions.

import { redactCommand } from "../src/redact.js";

const cases: Array<{ command: string; mustNotContain: string[] }> = [
  {
    command: `curl -H "Authorization: Bearer sk-abc123def456ghi789jkl" https://api.example.com`,
    mustNotContain: ["sk-abc123def456ghi789jkl"],
  },
  {
    command: `mysql -u root -p'S3cretPassw0rdHunter2' -h db.internal.example.com`,
    mustNotContain: ["S3cretPassw0rdHunter2"],
  },
  {
    command: `export API_KEY=sk-1234567890abcdefghijklmnop`,
    mustNotContain: ["sk-1234567890abcdefghijklmnop"],
  },
  {
    command: `git push https://user:ghp_1234567890abcdefghijklmnopqrstuvwxyz@github.com/foo/bar`,
    mustNotContain: ["ghp_1234567890abcdefghijklmnopqrstuvwxyz"],
  },
  {
    command: `echo "contact me at sam@phin.tech"`,
    mustNotContain: ["sam@phin.tech"],
  },
  {
    command: `ssh user@192.168.1.42`,
    mustNotContain: ["192.168.1.42"],
  },
  {
    command: `cat /Users/sphinizy/.ssh/id_rsa`,
    mustNotContain: ["sphinizy"],
  },
  {
    command: `curl -X POST --password hunter2asdfqwerty https://internal.example.com/login`,
    mustNotContain: ["hunter2asdfqwerty"],
  },
];

let failures = 0;
for (const { command, mustNotContain } of cases) {
  const redacted = redactCommand(command);
  const leaked = mustNotContain.filter((secret) => redacted.includes(secret));
  const ok = leaked.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${command}`);
  console.log(`      -> ${redacted}`);
  if (!ok) console.log(`      LEAKED: ${leaked.join(", ")}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) process.exit(1);
