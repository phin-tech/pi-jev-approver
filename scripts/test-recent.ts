import { readRecentRows } from "../src/audit-log.js";
import { formatRecentDecisions } from "../src/format.js";

async function main() {
  const rows = await readRecentRows(15);
  console.log(formatRecentDecisions(rows));
}
main();
