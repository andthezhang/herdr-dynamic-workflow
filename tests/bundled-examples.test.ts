import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript } from "../src/engine/workflow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "skills", "herdr-workflow-authoring", "reference");

test("every bundled JavaScript workflow passes the runtime parser", async (t) => {
  const examples = readdirSync(examplesDir)
    .filter((name) => name.endsWith(".js"))
    .sort();

  assert.ok(examples.length > 0);
  for (const name of examples) {
    await t.test(name, () => {
      const parsed = parseWorkflowScript(readFileSync(path.join(examplesDir, name), "utf8"));
      assert.ok(parsed.meta.name);
      assert.ok(parsed.body.trim());
    });
  }
});
