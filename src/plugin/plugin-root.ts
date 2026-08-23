/**
 * Locate this plugin's checkout from `herdr plugin list --json`.
 * The CLI shim uses the same JSON shape; keep that script in sync.
 */
export const PLUGIN_ID = "herdrflow.engine";

export function pluginRootFromListJson(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("herdr plugin list did not return JSON");
  }
  const result = (parsed as { result?: { plugins?: unknown } })?.result;
  const plugins = result?.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error(
      `plugin ${PLUGIN_ID} is not installed. Run: herdr plugin install andthezhang/herdr-dynamic-workflow`,
    );
  }
  const match = plugins.find((entry) => {
    return (
      entry !== null &&
      typeof entry === "object" &&
      "plugin_id" in entry &&
      (entry as { plugin_id?: unknown }).plugin_id === PLUGIN_ID
    );
  }) as { plugin_root?: unknown } | undefined;
  const root = match?.plugin_root;
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(`plugin ${PLUGIN_ID} has no plugin_root`);
  }
  return root;
}
