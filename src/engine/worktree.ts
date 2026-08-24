/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Falls back to a logged no-op when isolation isn't possible.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 *
 * The `name` passed to createWorktree must be deterministic (derived from
 * runId + call index, never wall-clock) so resume keys stay stable.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Worktree {
  /** True when a real worktree was created; false means "ran in the shared tree". */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree under `<repoRoot>/.herdr/worktrees/<name>` on branch
 * `herdr/wf/<name>`. Returns a no-op Worktree on any failure (isolation is
 * best-effort by design).
 */
export async function createWorktree(baseCwd: string, name: string): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const path = join(repoRoot, ".herdr", "worktrees", id);
  const branch = `herdr/wf/${id}`;
  try {
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
    return { isolated: true, cwd: path, branch, repoRoot };
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  if (!wt.isolated || !wt.repoRoot) return;
  try {
    await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd]);
  } catch {
    // already gone / locked — fall through
  }
  if (wt.branch) {
    try {
      await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch]);
    } catch {
      // branch already deleted
    }
  }
}
