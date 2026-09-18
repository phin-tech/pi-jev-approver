import { getProjectContext } from "../src/project-context.js";

async function main() {
  const cases: Array<[string, string]> = [
    ["/Users/sphinizy/src/github.com/phin-tech/pi-jev-approver", "npm install"],
    ["/Users/sphinizy/src/github.com/phin-tech/pi-jev-approver", "npm publish"],
    ["/Users/sphinizy/src/github.com/phin-tech/pi-jev-approver", "npm publish --access public"],
    ["/Users/sphinizy/src/github.com/phin-tech/jev-test", "twine upload dist/*"],
    ["/tmp", "cargo publish"],
    ["/Users/sphinizy/src/github.com/phin-tech/jev-test", "python -m pip install -r requirements.txt"],
  ];
  for (const [cwd, command] of cases) {
    console.log(cwd, "|", command, "->", await getProjectContext(cwd, command));
  }
}
main();
