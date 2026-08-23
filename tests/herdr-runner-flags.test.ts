/**
 * HerdrAgentRunner launch flags and blocked policy (SPEC D4/D6/D15): the
 * hardcoded per-kind permission bypass plus `model`/`effort` pass-through into
 * agent.start args, the callIdentity() runner-provided hash data (a changed
 * flag invalidates journal replay), and the onBlocked escalate policy (pane
 * left OPEN, escalation record + persisted pointer, recoverable failure
 * carrying the attach command, workspace preserved on close()).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { runWorkflow, type JournalEntry } from "../src/engine/workflow.js";
import { buildStartArgs, HERDR_BLOCKED, HerdrAgentRunner, HerdrWorkflowError } from "../src/runner/herdr-runner.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

interface Harness {
  server: MockHerdrServer;
  runner: HerdrAgentRunner;
  stateDir: string;
  close(): Promise<void>;
}

async function startHarness(runnerOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flags-state-"));
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "claude" },
    paneBusyDelayMs: 1,
    agentReadyPollMs: 1,
    outputSettleMs: 40,
    abortSettleMs: 1,
    ...runnerOverrides,
  });
  return {
    server,
    runner,
    stateDir,
    async close() {
      await runner.close();
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** agent.prompt handler that plays a compliant agent: writes the output file. */
function writesResult(value: unknown, status = "done") {
  return async (params: { target?: unknown } | undefined, server: MockHerdrServer) => {
    const env = server.lastTabEnv;
    assert.ok(env?.HERDR_FLOW_OUT, "tab.create must inject HERDR_FLOW_OUT before the prompt");
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: value }));
    return { type: "agent_prompted", agent: server.makeAgentInfo(params?.target, status) };
  };
}

// ─── D4: permission bypass is hardcoded, model/effort pass through ────────────

test("buildStartArgs: the kind's permission bypass, then model/effort verbatim", () => {
  assert.deepEqual(buildStartArgs("claude", {}), ["--dangerously-skip-permissions"]);
  assert.deepEqual(buildStartArgs("codex", {}), [
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
  ]);
  assert.deepEqual(buildStartArgs("claude", { model: "opus", effort: "high" }), [
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--effort",
    "high",
  ]);
  assert.deepEqual(
    buildStartArgs("Claude.exe", {}),
    ["--dangerously-skip-permissions"],
    "the kind is normalized the way herdr normalizes it",
  );
  assert.deepEqual(buildStartArgs("pi", {}), [], "a kind with no known bypass launches bare");
  assert.deepEqual(
    buildStartArgs("claude", { tier: "sonnet" }),
    ["--dangerously-skip-permissions", "--model", "sonnet"],
    "tier is a coarse model name and resolves through --model",
  );
});

test("claude start args carry the permission bypass with no config file at all", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult("resolved"));
  try {
    assert.equal(await harness.runner.run("task", { label: "worker" }), "resolved");
    assert.deepEqual(server.callsFor("agent.start")[0]!.params.args, ["--dangerously-skip-permissions"]);
  } finally {
    await harness.close();
  }
});

test("model and effort from the script reach agent.start as --model/--effort", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult("a"));
  try {
    await harness.runner.run("with model", { label: "a", model: "opus" });
    assert.deepEqual(server.callsFor("agent.start")[0]!.params.args, [
      "--dangerously-skip-permissions",
      "--model",
      "opus",
    ]);

    server.on("agent.prompt", writesResult("b"));
    await harness.runner.run("codex call", { label: "b", kind: "codex", effort: "high" });
    assert.deepEqual(server.callsFor("agent.start")[1]!.params.args, [
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--effort",
      "high",
    ]);
  } finally {
    await harness.close();
  }
});

test("an unknown model name is passed through for the CLI to reject — the engine keeps no model table", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult("passed through"));
  try {
    assert.equal(await harness.runner.run("task", { label: "worker", model: "opus3" }), "passed through");
    assert.deepEqual(server.callsFor("agent.start")[0]!.params.args, [
      "--dangerously-skip-permissions",
      "--model",
      "opus3",
    ]);
  } finally {
    await harness.close();
  }
});

// ─── D4/D6: callIdentity and the engine call hash ────────────────────────────

test("callIdentity: the resolved launch args are identity", async () => {
  const harness = await startHarness();
  try {
    assert.deepEqual(harness.runner.callIdentity({ kind: "claude" }), {
      args: ["--dangerously-skip-permissions"],
    });
    assert.equal(
      harness.runner.callIdentity({ kind: "pi" }),
      undefined,
      "a kind with no bypass and no model/effort resolves to nothing",
    );
    assert.deepEqual(harness.runner.callIdentity({ kind: "claude", model: "opus", effort: "high" }), {
      args: ["--dangerously-skip-permissions", "--model", "opus", "--effort", "high"],
    });
  } finally {
    await harness.close();
  }
});

test("callIdentity carries the runner's DEFAULT kind for implicit-kind calls (D6: the CLI that runs must be hashable)", async () => {
  // The engine hashes only the script-visible kind (call site / agentType);
  // an implicit-kind call's actual CLI comes from the runner default, which
  // must therefore reach the hash through callIdentity — or resuming under a
  // different default kind would silently replay one CLI's result as the
  // other's.
  const claude = await startHarness();
  const codex = await startHarness({ defaults: { kind: "codex" } });
  try {
    assert.deepEqual(claude.runner.callIdentity({}), {
      kind: "claude",
      args: ["--dangerously-skip-permissions"],
    });
    assert.deepEqual(codex.runner.callIdentity({}), {
      kind: "codex",
      args: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
    });
    assert.notDeepEqual(
      claude.runner.callIdentity({}),
      codex.runner.callIdentity({}),
      "a changed default kind must change the identity of every implicit-kind call",
    );
    assert.deepEqual(
      claude.runner.callIdentity({ kind: "claude" }),
      { args: ["--dangerously-skip-permissions"] },
      "an explicit kind does not contribute the default",
    );
  } finally {
    await claude.close();
    await codex.close();
  }
});

test("a changed model invalidates cached calls that used it; an unchanged one replays (SPEC D4 consequence)", async () => {
  const script = (model: string) => `export const meta = { name: 'hashed', description: 'flag identity' }
return await agent('do the thing', { label: 'worker', model: '${model}' })`;
  const journal = new Map<string, JournalEntry>();

  const first = await startHarness();
  first.server.on("agent.prompt", writesResult("original flags"));
  try {
    const run = await runWorkflow(script("opus"), {
      agent: first.runner,
      persistLogs: false,
      runId: "flagrun",
      onAgentJournal: (entry) => journal.set(`flagrun:${entry.index}`, entry),
    });
    assert.equal(run.result, "original flags");
  } finally {
    await first.close();
  }

  const same = await startHarness();
  try {
    const run = await runWorkflow(script("opus"), {
      agent: same.runner,
      persistLogs: false,
      runId: "flagrun",
      resumeJournal: journal,
      resumeFromRunId: "flagrun",
    });
    assert.equal(run.result, "original flags");
    assert.equal(same.server.calls.length, 0, "unchanged flags must replay without touching the socket");
  } finally {
    await same.close();
  }

  const edited = await startHarness();
  edited.server.on("agent.prompt", writesResult("new flags"));
  try {
    const run = await runWorkflow(script("opus-4.5"), {
      agent: edited.runner,
      persistLogs: false,
      runId: "flagrun",
      resumeJournal: journal,
      resumeFromRunId: "flagrun",
    });
    assert.equal(run.result, "new flags", "the changed model must invalidate the cached result");
    assert.deepEqual(edited.server.callsFor("agent.start")[0]!.params.args, [
      "--dangerously-skip-permissions",
      "--model",
      "opus-4.5",
    ]);
  } finally {
    await edited.close();
  }
});

// ─── D15: onBlocked = "escalate" ─────────────────────────────────────────────

test("escalate: a blocked worker is left OPEN, recorded, persisted, and the failure carries the attach command", async () => {
  const harness = await startHarness({ onBlocked: "escalate", session: "flowtest" });
  const { server } = harness;
  server.on("agent.prompt", (params) => ({
    type: "agent_prompted",
    agent: server.makeAgentInfo((params as { target?: unknown })?.target, "blocked"),
  }));
  const histories: Array<Record<string, unknown>> = [];
  try {
    await assert.rejects(
      harness.runner.run("needs approval", {
        label: "worker",
        sessionName: "workflow:runesc worker",
        onHistory: (entries) => histories.push(...entries),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, HERDR_BLOCKED);
        assert.equal(error.recoverable, true, "escalate fails the call recoverable (the run goes on without it)");
        assert.equal(
          error.retryable,
          false,
          "but NOT retryable: the escalated worker deliberately keeps its pane (SPEC D15), so an engine " +
            "retry would open a duplicate worker while a human is still answering the first",
        );
        assert.match(
          error.message,
          /herdr --session flowtest agent attach flow-runesc-0/,
          "the message must carry the exact human-runnable attach command",
        );
        assert.match(error.message, /left OPEN/i);
        const details = error.details as Record<string, unknown>;
        assert.equal(details.paneClosed, false, "paneClosed reflects reality: the pane is still open");
        assert.equal(details.attachCommand, "herdr --session flowtest agent attach flow-runesc-0");
        assert.equal(typeof details.escalationPath, "string");
        return true;
      },
    );

    // The tab (and its pane, and the blocked agent) must NOT be torn down.
    assert.equal(server.callsFor("tab.close").length, 0, "escalate must not close the blocked tab");
    assert.equal(server.callsFor("agent.send_keys").length, 0, "no interrupt keys are sent to a blocked worker");

    // The escalation record went through onHistory.
    const record = histories.find((entry) => entry.code === "agent_blocked_escalated");
    assert.ok(record, "an escalation record must be emitted via onHistory");
    assert.equal(record.type, "escalation");
    assert.equal(record.runId, "runesc");
    assert.equal(record.callIndex, 0);
    assert.equal(record.attachCommand, "herdr --session flowtest agent attach flow-runesc-0");
    assert.match(String(record.paneId), /^w1:p/);

    // The persisted pointer exists in the run's state dir and carries the same identity.
    const pointerPath = path.join(harness.stateDir, "runesc", "escalation-0.json");
    assert.ok(existsSync(pointerPath), "a pointer must be persisted in the run state dir");
    const persisted = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.code, "agent_blocked_escalated");
    assert.equal(persisted.agentName, "flow-runesc-0");
    assert.equal(persisted.attachCommand, "herdr --session flowtest agent attach flow-runesc-0");

    // close() must leave the workspace (holding the open pane) alive.
    await harness.runner.close();
    assert.equal(
      server.callsFor("workspace.close").length,
      0,
      "close() must not tear down a workspace holding escalated panes",
    );
  } finally {
    await harness.close();
  }
});

test("escalate applies on the harvest re-check path too (false idle, file missing, agent actually blocked)", async () => {
  const harness = await startHarness({ onBlocked: "escalate", session: "flowtest" });
  const { server } = harness;
  // Startup readiness poll healthy; the harvest re-check discovers blocked.
  server.queueResponses("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "idle"),
  }));
  server.on("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "blocked"),
  }));
  try {
    await assert.rejects(
      harness.runner.run("write the file please", { label: "worker", sessionName: "workflow:runesc2 worker" }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, HERDR_BLOCKED);
        assert.match(error.message, /agent attach flow-runesc2-0/);
        return true;
      },
    );
    assert.equal(server.callsFor("tab.close").length, 0, "the re-check path must honor escalate too");
    assert.ok(existsSync(path.join(harness.stateDir, "runesc2", "escalation-0.json")));
  } finally {
    await harness.close();
  }
});

test("escalate + engine retries settles: the escalated call is NOT retried and collapses to null", async () => {
  const harness = await startHarness({ onBlocked: "escalate", session: "flowtest" });
  const { server } = harness;
  server.on("agent.prompt", (params) => ({
    type: "agent_prompted",
    agent: server.makeAgentInfo((params as { target?: unknown })?.target, "blocked"),
  }));
  const histories: Array<Record<string, unknown>> = [];
  try {
    const outcome = await runWorkflow(
      `export const meta = { name: 'esc-retry', description: 'escalate under engine retries' }
return await agent('needs approval', { label: 'worker' })`,
      {
        agent: harness.runner,
        persistLogs: false,
        runId: "escretry",
        agentRetries: 2, // the plugin entry points hardcode 2
        onAgentHistory: ({ history }) => histories.push(...history),
      },
    );
    assert.equal(outcome.result, null, "the escalated call collapses to null; the run itself completes");
    assert.equal(server.callsFor("tab.create").length, 1, "no duplicate worker was opened for a retry");
    assert.equal(server.callsFor("tab.close").length, 0, "the one escalated pane stays open for the human");
    assert.equal(
      histories.filter((entry) => entry.code === "agent_blocked_escalated").length,
      1,
      "exactly one escalation record — not one per retry attempt",
    );
  } finally {
    await harness.close();
  }
});

test("escalate: non-blocked calls still tear down normally, and close() then closes the workspace", async () => {
  const harness = await startHarness({ onBlocked: "escalate" });
  const { server } = harness;
  server.on("agent.prompt", writesResult("fine"));
  try {
    assert.equal(await harness.runner.run("ok task", { label: "worker" }), "fine");
    assert.equal(server.callsFor("tab.close").length, 1, "a successful call's tab still closes under escalate policy");
    await harness.runner.close();
    assert.equal(server.callsFor("workspace.close").length, 1, "no escalations: close() tears the workspace down");
  } finally {
    await harness.close();
  }
});

test("the default fail policy tears the blocked pane down and the call collapses per engine rules", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", (params) => ({
    type: "agent_prompted",
    agent: server.makeAgentInfo((params as { target?: unknown })?.target, "blocked"),
  }));
  try {
    await assert.rejects(
      harness.runner.run("needs approval", { label: "worker" }),
      (error: unknown) =>
        error instanceof HerdrWorkflowError &&
        error.herdrCode === HERDR_BLOCKED &&
        (error.details as Record<string, unknown>).paneClosed === true,
    );
    assert.equal(server.callsFor("tab.close").length, 1);
  } finally {
    await harness.close();
  }
});

test('escalate in zero-config default mode: the attach command omits --session (the pane is in the USER\'S OWN session)', async () => {
  // run.js keeps session as the worker NAME ("flow"/"flowtest") even when
  // local placement targeted the user's own default session — but the pane
  // then lives in THAT session, so `herdr --session flowtest agent attach …`
  // would point the human at a different (typically not running) session.
  // localSessionMode: "default" is how run.js tells the runner, and the
  // printed command must be the plain no---session form.
  const harness = await startHarness({ onBlocked: "escalate", session: "flowtest", localSessionMode: "default" });
  const { server } = harness;
  server.on("agent.prompt", (params) => ({
    type: "agent_prompted",
    agent: server.makeAgentInfo((params as { target?: unknown })?.target, "blocked"),
  }));
  const histories: Array<Record<string, unknown>> = [];
  try {
    await assert.rejects(
      harness.runner.run("needs approval", {
        label: "worker",
        sessionName: "workflow:runescdef worker",
        onHistory: (entries) => histories.push(...entries),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, HERDR_BLOCKED);
        const details = error.details as Record<string, unknown>;
        assert.equal(details.attachCommand, "herdr agent attach flow-runescdef-0");
        assert.match(error.message, /Answer it with: herdr agent attach flow-runescdef-0/);
        assert.ok(!String(error.message).includes("--session"), "no --session flag may appear in default mode");
        return true;
      },
    );
    const record = histories.find((entry) => entry.code === "agent_blocked_escalated");
    assert.ok(record);
    assert.equal(record.attachCommand, "herdr agent attach flow-runescdef-0");
  } finally {
    await harness.close();
  }
});

test("an unwaitable kind is rejected before any socket work, wherever it arrives", async () => {
  const harness = await startHarness();
  try {
    await assert.rejects(harness.runner.run("task", { label: "worker", kind: "cline" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      return true;
    });
    assert.equal(harness.server.calls.length, 0, "rejected before touching the socket");
  } finally {
    await harness.close();
  }
});
