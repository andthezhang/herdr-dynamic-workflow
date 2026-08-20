import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

interface ManifestAction {
  id: string;
  title: string;
  contexts: string[];
  command: string[];
}

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  min_herdr_version: string;
  description: string;
  platforms: string[];
  build: Array<{ command: string[] }>;
  actions: ManifestAction[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "herdr-plugin.toml");

test("the marketplace manifest has complete metadata and runnable actions", () => {
  const manifest = parse(readFileSync(manifestPath, "utf8")) as unknown as PluginManifest;

  assert.match(manifest.id, /^[A-Za-z0-9_.:-]+$/);
  assert.ok(manifest.name.trim());
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.min_herdr_version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.trim());
  assert.deepEqual(manifest.platforms, ["linux", "macos"]);
  assert.deepEqual(
    manifest.build.map((step) => step.command),
    [
      ["npm", "ci"],
      ["npm", "run", "build"],
    ],
  );

  assert.deepEqual(
    manifest.actions.map((action) => action.id),
    ["run", "resume"],
  );
  for (const action of manifest.actions) {
    assert.ok(action.title.trim());
    assert.deepEqual(action.contexts, ["global"]);
    assert.equal(action.command[0], "node");

    const builtEntrypoint = action.command[1];
    if (!builtEntrypoint) assert.fail(`action ${action.id} must declare an entry point`);
    assert.ok(builtEntrypoint.startsWith("dist/plugin/"));
    const sourceEntrypoint = builtEntrypoint.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
    assert.ok(existsSync(path.join(root, sourceEntrypoint)), `${sourceEntrypoint} must exist`);
  }
});
