import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("install-skill copies the bundled skill globally without prompts", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "herdr-skill-install-"));
  try {
    const argsPath = path.join(tempDir, "args.txt");
    const fakeNpx = path.join(tempDir, "npx");
    writeFileSync(
      fakeNpx,
      '#!/bin/sh\nset -eu\nprintf "%s\\n" "$@" > "$HERDR_SKILLS_TEST_ARGS"\n',
    );
    chmodSync(fakeNpx, 0o755);

    const result = spawnSync(process.execPath, [path.join(root, "scripts/install-skill.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HERDR_SKILLS_TEST_ARGS: argsPath,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(argsPath, "utf8").trim().split("\n"), [
      "--yes",
      "skills@1.5.23",
      "add",
      root,
      "--skill",
      "herdr-workflow-authoring",
      "--global",
      "--yes",
      "--copy",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
