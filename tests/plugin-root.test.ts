import assert from "node:assert/strict";
import test from "node:test";
import { pluginRootFromListJson } from "../src/plugin/plugin-root.js";

const listed = {
  id: "cli:plugin",
  result: {
    type: "plugin_list",
    plugins: [
      {
        plugin_id: "herdrflow.engine",
        plugin_root: "/workspace/plugins/herdr-dynamic-workflow",
      },
    ],
  },
};

test("pluginRootFromListJson reads plugin_root from herdr plugin list --json", () => {
  assert.equal(pluginRootFromListJson(JSON.stringify(listed)), "/workspace/plugins/herdr-dynamic-workflow");
});

test("pluginRootFromListJson rejects missing plugin or bad JSON", () => {
  assert.throws(() => pluginRootFromListJson("{"), /did not return JSON/);
  assert.throws(
    () => pluginRootFromListJson(JSON.stringify({ result: { plugins: [] } })),
    /not installed/,
  );
  assert.throws(
    () =>
      pluginRootFromListJson(
        JSON.stringify({ result: { plugins: [{ plugin_id: "other", plugin_root: "/x" }] } }),
      ),
    /no plugin_root/,
  );
});
