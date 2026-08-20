/**
 * Engine-level tests for the M2 runner->engine identity seam
 * (WorkflowAgentRunner.callIdentity) and the `effort` agent() option:
 * identity folded into the call hash only when present (absence hashes
 * byte-identically to the pre-seam format, so old journals keep replaying),
 * fleet-style config edits invalidating replay, callIdentity validation
 * errors surfacing pre-run, and effort threading/identity. Uses fake runners —
 * no Herdr socket involved; the socket-backed half lives in
 * herdr-runner-fleet.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCallIdentity, AgentRunOptions, WorkflowAgentRunner } from "../src/engine/agent-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { runWorkflow, type JournalEntry } from "../src/engine/workflow.js";

const SCRIPT = `export const meta = { name: 'seam', description: 'identity seam' }
return await agent('do the thing', { label: 'worker' })`;

function collectingJournal(): { journal: Map<string, JournalEntry>; onAgentJournal: (entry: JournalEntry) => void } {
  const journal = new Map<string, JournalEntry>();
  return {
    journal,
    onAgentJournal: (entry) => journal.set(`${entry.runId ?? "seamrun"}:${entry.index}`, entry),
  };
}

test("a journal from a runner WITHOUT callIdentity replays under one whose callIdentity returns undefined", async () => {
  // "Absence of fleet config hashes as before": the seam must be invisible
  // when it contributes nothing.
  const { journal, onAgentJournal } = collectingJournal();
  const legacyRunner: WorkflowAgentRunner = { run: async () => "legacy result" };
  await runWorkflow(SCRIPT, { agent: legacyRunner, persistLogs: false, runId: "seamrun", onAgentJournal });

  let liveRuns = 0;
  const seamRunner: WorkflowAgentRunner = {
    run: async () => {
      liveRuns++;
      return "live result";
    },
    callIdentity: () => undefined,
  };
  const replay = await runWorkflow(SCRIPT, {
    agent: seamRunner,
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(replay.result, "legacy result", "the cached result must replay");
  assert.equal(liveRuns, 0, "identity-less callIdentity must not change the hash");
});

test("a changed callIdentity value invalidates the cached call; an identical one replays", async () => {
  const { journal, onAgentJournal } = collectingJournal();
  const makeRunner = (identity: unknown, result: string, counter: { runs: number }): WorkflowAgentRunner => ({
    run: async () => {
      counter.runs++;
      return result;
    },
    callIdentity: () => identity,
  });

  const first = { runs: 0 };
  await runWorkflow(SCRIPT, {
    agent: makeRunner({ args: ["--model", "opus"], env: {} }, "under v1 flags", first),
    persistLogs: false,
    runId: "seamrun",
    onAgentJournal,
  });
  assert.equal(first.runs, 1);

  // Same identity: replay.
  const same = { runs: 0 };
  const replayed = await runWorkflow(SCRIPT, {
    agent: makeRunner({ args: ["--model", "opus"], env: {} }, "never seen", same),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(replayed.result, "under v1 flags");
  assert.equal(same.runs, 0);

  // Changed identity (a fleet config edit): live re-run.
  const changed = { runs: 0 };
  const rerun = await runWorkflow(SCRIPT, {
    agent: makeRunner({ args: ["--model", "opus-4.5"], env: {} }, "under v2 flags", changed),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(rerun.result, "under v2 flags");
  assert.equal(changed.runs, 1, "the edited identity must cache-miss");
});

test("callIdentity receives the call's resolved kind/model/tier/effort", async () => {
  const seen: AgentCallIdentity[] = [];
  const runner: WorkflowAgentRunner = {
    run: async () => "ok",
    callIdentity: (call) => {
      seen.push(call);
      return undefined;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'args', description: 'identity args' }
return await agent('t', { label: 'w', kind: 'codex', model: 'opus', effort: 'high' })`,
    { agent: runner, persistLogs: false },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.kind, "codex");
  assert.equal(seen[0]!.model, "opus");
  assert.equal(seen[0]!.effort, "high");
});

test("a callIdentity SCRIPT_VALIDATION_ERROR halts the run before the runner ever runs", async () => {
  let ran = 0;
  const runner: WorkflowAgentRunner = {
    run: async () => {
      ran++;
      return "never";
    },
    callIdentity: () => {
      throw new WorkflowError('model "opus" cannot be resolved', WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    },
  };
  await assert.rejects(
    runWorkflow(SCRIPT, { agent: runner, persistLogs: false, agentRetries: 2 }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(ran, 0, "validation fires before any backend work — and is never retried");
});

// ─── machine identity (SPEC D6) ──────────────────────────────────────────────

test("the call's machine option is part of the resume hash: repointing invalidates the cached result (D6)", async () => {
  const { journal, onAgentJournal } = collectingJournal();
  const makeRunner = (result: string, counter: { runs: number }): WorkflowAgentRunner => ({
    run: async () => {
      counter.runs++;
      return result;
    },
  });
  const script = (machine: string) => `export const meta = { name: 'm', description: 'machine identity' }
return await agent('t', { label: 'w', machine: '${machine}' })`;

  const first = { runs: 0 };
  await runWorkflow(script("box-a"), { agent: makeRunner("made on box-a", first), persistLogs: false, runId: "seamrun", onAgentJournal });
  assert.equal(first.runs, 1);

  // Same machine: replay.
  const same = { runs: 0 };
  const replayed = await runWorkflow(script("box-a"), {
    agent: makeRunner("never seen", same),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(replayed.result, "made on box-a");
  assert.equal(same.runs, 0, "an unchanged machine must replay from the journal");

  // Repointed: the cached result must NOT be replayed as box-b's.
  const moved = { runs: 0 };
  const rerun = await runWorkflow(script("box-b"), {
    agent: makeRunner("made on box-b", moved),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(rerun.result, "made on box-b");
  assert.equal(moved.runs, 1, "repointing a call at a different machine must invalidate its cached result");
});

test("an implicit placement (no machine option) hashes stably: pre-fleet journals keep replaying", async () => {
  const { journal, onAgentJournal } = collectingJournal();
  let liveRuns = 0;
  const runner = (result: string): WorkflowAgentRunner => ({
    run: async () => {
      liveRuns++;
      return result;
    },
  });
  await runWorkflow(SCRIPT, { agent: runner("implicit result"), persistLogs: false, runId: "seamrun", onAgentJournal });
  const replay = await runWorkflow(SCRIPT, {
    agent: runner("never seen"),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(replay.result, "implicit result");
  assert.equal(liveRuns, 1, "an implicit placement must hash identically across runs");
});

// ─── effort option ────────────────────────────────────────────────────────────

test("effort is a known agent() option, threaded to the runner and part of the call identity", async () => {
  const efforts: Array<string | undefined> = [];
  const { journal, onAgentJournal } = collectingJournal();
  const runner = (result: string): WorkflowAgentRunner => ({
    run: async (_prompt: string, options: AgentRunOptions) => {
      efforts.push(options.effort);
      return result;
    },
  });
  const EFFORT_SCRIPT = `export const meta = { name: 'e', description: 'effort' }
return await agent('t', { label: 'w', effort: 'high' })`;

  await runWorkflow(EFFORT_SCRIPT, { agent: runner("with high"), persistLogs: false, runId: "seamrun", onAgentJournal });
  assert.deepEqual(efforts, ["high"], "effort must be forwarded verbatim");

  // Changing effort invalidates the cached call.
  const rerun = await runWorkflow(EFFORT_SCRIPT.replace("'high'", "'low'"), {
    agent: runner("with low"),
    persistLogs: false,
    runId: "seamrun",
    resumeJournal: journal,
    resumeFromRunId: "seamrun",
  });
  assert.equal(rerun.result, "with low", "an edited effort is a different call");
});

test("effort must be a non-empty string", async () => {
  const runner: WorkflowAgentRunner = { run: async () => "ok" };
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad', description: 'bad effort' }
return await agent('t', { effort: '  ' })`,
      { agent: runner, persistLogs: false },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
});
