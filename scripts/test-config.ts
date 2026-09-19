import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveCommandRule } from "../src/config.js";

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

  // saveCommandRule: "Always allow" persistence
  await withConfig(
    JSON.stringify({ customConcerns: { aws_command: "Touches AWS" } }),
    async (path) => {
      const result = await saveCommandRule(
        { pattern: "^ls -la$", action: "allow", weight: 5, reason: "test" },
        path,
      );
      console.log("save onto existing config:", result);
      const onDisk = JSON.parse(await readFile(path, "utf8"));
      console.log("preserved unrelated fields:", onDisk.customConcerns);
      console.log("appended rule:", onDisk.commandRules);
    },
  );

  {
    const dir = await mkdtemp(join(tmpdir(), "pi-jev-approver-config-test-"));
    const path = join(dir, "nested", "config.json");
    try {
      const result = await saveCommandRule({ pattern: "^ls$", action: "allow", weight: 5 }, path);
      console.log("save with no existing file:", result);
      console.log("created:", JSON.parse(await readFile(path, "utf8")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  await withConfig(
    JSON.stringify({ commandRules: Array.from({ length: 50 }, (_, i) => ({ pattern: `p${i}`, action: "allow", weight: 0 })) }),
    async (path) => {
      const result = await saveCommandRule({ pattern: "^one-too-many$", action: "allow", weight: 5 }, path);
      console.log("save at rule cap:", result);
    },
  );

  await withConfig("{not valid json", async (path) => {
    const result = await saveCommandRule({ pattern: "^x$", action: "allow", weight: 5 }, path);
    console.log("save onto malformed json:", result);
  });
}

main();
