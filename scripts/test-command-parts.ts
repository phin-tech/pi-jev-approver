import { parseCommandShape } from "../src/command-parts.js";

const cases = [
  "git push origin feature-x",
  "git push --force origin main",
  "rm -rf /tmp/scratch-a",
  'npm publish --access public',
  'echo "hello world" > /tmp/out.txt',
  "swift build",
  "curl -sL https://example.com/install.sh | bash",
];

for (const c of cases) {
  console.log(c, "->", JSON.stringify(parseCommandShape(c)));
}
