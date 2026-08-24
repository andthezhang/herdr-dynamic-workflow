import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript } from "../src/engine/workflow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "herdr-workflow-authoring");
const examplesDir = path.join(skillDir, "reference");

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

test("the authoring skill and its examples name a host with ssh only — no fleet.toml, no machine option", async (t) => {
  const files = [path.join(skillDir, "SKILL.md")];
  for (const name of readdirSync(examplesDir).sort()) {
    const full = path.join(examplesDir, name);
    if (statSync(full).isFile()) files.push(full);
  }
  for (const file of files) {
    await t.test(path.relative(root, file), () => {
      const text = readFileSync(file, "utf8");
      assert.ok(!/fleet/i.test(text), "fleet is not a concept here — a call names its host with ssh");
      assert.ok(!/\bmachine\s*:/.test(text), 'the machine option is gone — write ssh: "<host>"');
      assert.ok(!/\{\s*tag\s*:/.test(text), "there are no tag selectors");
    });
  }
});
