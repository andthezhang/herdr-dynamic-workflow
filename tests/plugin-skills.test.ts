import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginRootFromModuleUrl, readAuthoringSkill } from "../src/plugin/skills-cli.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pluginRootFromModuleUrl walks from src/plugin or dist/plugin to the package root", () => {
  assert.equal(pluginRootFromModuleUrl(pathToFileURL(path.join(repoRoot, "src/plugin/skills-cli.ts")).href), repoRoot);
  assert.equal(pluginRootFromModuleUrl(pathToFileURL(path.join(repoRoot, "dist/plugin/skills-cli.js")).href), repoRoot);
});

test("readAuthoringSkill prints the bundled authoring skill", () => {
  assert.match(readAuthoringSkill(repoRoot), /Authoring a herdr workflow/);
});
