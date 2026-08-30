#!/usr/bin/env node
// Install a copy of the bundled authoring skill into detected agent clients.
// Herdr builds remote plugins in a temporary checkout before moving them, so
// this must copy the skill rather than leave symlinks to the build directory.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(dirname(fileURLToPath(import.meta.url)));

execFileSync(
  "npx",
  ["--yes", "skills@1.5.23", "add", here, "--skill", "herdr-workflow-authoring", "--global", "--yes", "--copy"],
  { stdio: "inherit" },
);
