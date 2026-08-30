#!/usr/bin/env node
// Copy herdr-dynamic-workflow next to the herdr binary (the directory already
// on PATH). Do not resolve Homebrew cellars: dirname of `command -v herdr` is
// /opt/homebrew/bin, not Cellar/herdr/<ver>/bin.
import { accessSync, constants, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(here, "bin", "herdr-dynamic-workflow");

try {
  accessSync(src, constants.F_OK);
} catch {
  console.error(`install-cli: missing ${src}`);
  process.exit(1);
}

let herdrBin;
try {
  herdrBin = execFileSync("which", ["herdr"], { encoding: "utf8" }).trim();
  if (!herdrBin) throw new Error("empty");
} catch {
  console.error("install-cli: herdr not found on PATH");
  process.exit(1);
}

const bindir = dirname(herdrBin);
const dest = join(bindir, "herdr-dynamic-workflow");

try {
  accessSync(bindir, constants.W_OK);
} catch {
  console.error(`install-cli: cannot write ${dest} (directory not writable)`);
  process.exit(1);
}

copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`installed ${dest}`);
