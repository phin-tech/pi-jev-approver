import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

// Uses an isolated temp path, never the real configPath() - a config test
// must not be able to touch (let alone delete) the user's real config file.
async function withConfig(content: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-approver-config-test-"));
  const path = join(dir, "config.json");
  await writeFile(path, content, "utf8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("no file:", await loadConfig(join(tmpdir(), "definitely-does-not-exist.json")));

  await withConfig(
    JSON.stringify({
      customConcerns: {
        aws_command: "Touches AWS infrastructure",
        "Bad-Key!": "should be dropped - invalid key",
        empty_desc: "",
      },
    }),
    async (path) => console.log("mixed valid/invalid:", await loadConfig(path)),
  );

  await withConfig("{not valid json", async (path) => console.log("malformed json:", await loadConfig(path)));

  const manyKeys = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [`concern_${i}`, `description ${i}`]),
  );
  await withConfig(JSON.stringify({ customConcerns: manyKeys }), async (path) => {
    const result = await loadConfig(path);
    console.log("over max (15 given):", Object.keys(result.customConcerns).length, "kept");
  });
}

main();
