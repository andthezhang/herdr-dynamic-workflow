/** Print the one bundled skill. Same idea as `browser-use skill`. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_FILE = "skills/herdr-workflow-authoring/SKILL.md";

export function pluginRootFromModuleUrl(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

export function readAuthoringSkill(root: string = pluginRootFromModuleUrl()): string {
  return readFileSync(path.join(root, SKILL_FILE), "utf8");
}
