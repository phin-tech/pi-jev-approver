import { classifyPaths } from "../src/path-scope.js";

const cwd = "/Users/sam/src/myproject";
const cases = [
  ["./build", "node_modules"],
  ["../sibling-project"],
  ["../../../etc/hosts"],
  ["~"],
  ["~/Documents/secret.txt"],
  ["/"],
  ["/Users/sam/src/myproject/dist"],
];

for (const paths of cases) {
  console.log(paths, "->", classifyPaths(paths, cwd));
}
