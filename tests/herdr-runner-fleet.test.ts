/**
 * Fleet-config-driven HerdrAgentRunner behavior (SPEC D4/D12/D15):
 * [runtime.<kind>] resolution into agent.start args + tab env, the
 * callIdentity() runner-provided hash data (fleet edits invalidate
 * journal replay; absence hashes as before), the fleet machine guard for
 * configured remote machines, and the on_blocked escalate policy (pane left
 * OPEN, escalation record + persisted pointer, recoverable failure carrying
 * the attach command, workspace preserved on close()).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { runWorkflow, type JournalEntry } from "../src/engine/workflow.js";
import { parseFleetToml } from "../src/fleet/config.js";
import { HERDR_BLOCKED, HerdrAgentRunner, HerdrWorkflowError } from "../src/runner/herdr-runner.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

const FLEET_TOML = `
[defaults]
kind = "claude"
on_blocked = "fail"

[runtime.claude]
permission = ["--dangerously-skip-permissions"]
model.opus = ["--model", "opus"]
model.big = ["--model", "opus"]
effort.high = { env = { MAX_THINKING_TOKENS = "32000" } }

[runtime.codex]
permission = ["--full-auto"]

[[machine]]
name = "local"

[[machine]]
name = "build-mac"
transport = "build-mac"
herdr_bin = "/opt/homebrew/bin/herdr"
slots = 4
kinds = ["claude", "codex"]
`;

interface Harness {
  server: MockHerdrServer;
  runner: HerdrAgentRunner;
  stateDir: string;
  close(): Promise<void>;
}

async function startHarness(fleetToml?: string, runnerOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-state-"));
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "claude" },
    ...(fleetToml !== undefined ? { fleet: parseFleetToml(fleetToml, "test://fleet.toml") } : {}),
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

// ─── D4: resolution into agent.start args and tab env ─────────────────────────

test("model/effort resolve into agent.start args (permission appended) and tab-level env", async () => {
  const harness = await startHarness(FLEET_TOML);
  const { server } = harness;
  server.on("agent.prompt", writesResult("resolved"));
  try {
    const result = await harness.runner.run("task", { label: "worker", model: "opus", effort: "high" });
    assert.equal(result, "resolved");
    const start = server.callsFor("agent.start")[0]!.params;
    assert.deepEqual(
      start.args,
      ["--model", "opus", "--dangerously-skip-permissions"],
      "model args then the kind's permission args, always appended",
    );
    const env = server.lastTabEnv!;
    assert.equal(env.MAX_THINKING_TOKENS, "32000", "effort env rides on the tab (agent.start has no env of its own)");
    assert.ok(env.HERDR_FLOW_OUT, "the contract env is still present alongside the runtime env");
  } finally {
    await harness.close();
  }
});

test("tier resolves through the model table; permission args are sent even for a bare call", async () => {
  const harness = await startHarness(FLEET_TOML);
  const { server } = harness;
  server.on("agent.prompt", writesResult("a"));
  try {
    await harness.runner.run("with tier", { label: "a", tier: "big" });
    assert.deepEqual(server.callsFor("agent.start")[0]!.params.args, [
      "--model",
      "opus",
      "--dangerously-skip-permissions",
    ]);

    server.on("agent.prompt", writesResult("b"));
    await harness.runner.run("bare call", { label: "b" });
    assert.deepEqual(
      server.callsFor("agent.start")[1]!.params.args,
      ["--dangerously-skip-permissions"],
      "no model/effort requested: only the always-appended permission args",
    );

    server.on("agent.prompt", writesResult("c"));
    await harness.runner.run("codex call", { label: "c", kind: "codex" });
    assert.deepEqual(server.callsFor("agent.start")[2]!.params.args, ["--full-auto"], "per-kind permission args");
  } finally {
    await harness.close();
  }
});

test("an explicit model with no [runtime.<kind>] mapping fails validation before any socket call", async () => {
  const harness = await startHarness(FLEET_TOML);
  const { server } = harness;
  try {
    await assert.rejects(harness.runner.run("task", { label: "worker", kind: "codex", model: "opus3" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /opus3/);
      assert.match(error.message, /runtime\.codex/);
      return true;
    });
    assert.equal(server.calls.length, 0, "rejected before touching the socket");
  } finally {
    await harness.close();
  }
});

// ─── D12: configured machines ─────────────────────────────────────────────────

test("a configured LOCAL machine is accepted; an UNCONFIGURED machine is a validation error, never a silent fallback (D12)", async () => {
  const harness = await startHarness(FLEET_TOML);
  const { server } = harness;
  server.on("agent.prompt", writesResult("ran locally"));
  try {
    assert.equal(await harness.runner.run("here", { label: "worker", machine: "local" }), "ran locally");

    await assert.rejects(harness.runner.run("there", { label: "worker", machine: "someones-laptop" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /someones-laptop/);
      assert.match(error.message, /not in the fleet/);
      assert.match(error.message, /local, build-mac/, "the error lists the configured machines");
      return true;
    });
  } finally {
    await harness.close();
  }
});

// ─── D4/D6: callIdentity and the engine call hash ────────────────────────────

test("callIdentity: undefined when nothing resolves (hash unchanged), resolved args/env otherwise", async () => {
  const bare = await startHarness(); // no fleet config at all
  const configured = await startHarness(FLEET_TOML);
  try {
    assert.equal(bare.runner.callIdentity({ kind: "claude" }), undefined, "no fleet, no options: no extra identity");
    assert.equal(
      configured.runner.callIdentity({ kind: "pi" }),
      undefined,
      "a kind with no [runtime] section and no requests resolves to nothing",
    );
    assert.deepEqual(configured.runner.callIdentity({ kind: "claude", model: "opus", effort: "high" }), {
      args: ["--model", "opus", "--dangerously-skip-permissions"],
      env: { MAX_THINKING_TOKENS: "32000" },
    });
    // Unresolvable explicit values throw from callIdentity too — the engine
    // hashes before it runs, so the validation error fires pre-socket.
    assert.throws(
      () => configured.runner.callIdentity({ kind: "codex", model: "opus3" }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
  } finally {
    await bare.close();
    await configured.close();
  }
});

test("callIdentity carries the runner's DEFAULT kind for implicit-kind calls (D6: the CLI that runs must be hashable)", async () => {
  // The engine hashes only the script-visible kind (call site / agentType);
  // an implicit-kind call's actual CLI comes from the runner default, which
  // must therefore reach the hash through callIdentity — or resuming under a
  // different default kind would silently replay one CLI's result as the
  // other's.
  const claude = await startHarness(); // defaults.kind "claude", no fleet
  const codex = await startHarness(undefined, { defaults: { kind: "codex" } });
  try {
    assert.deepEqual(claude.runner.callIdentity({}), { kind: "claude" }, "implicit kind contributes the default");
    assert.deepEqual(codex.runner.callIdentity({}), { kind: "codex" });
    assert.notDeepEqual(
      claude.runner.callIdentity({}),
      codex.runner.callIdentity({}),
      "a changed default kind must change the identity of every implicit-kind call",
    );
    // Explicit-kind calls stay byte-compatible with the pre-fleet hash format.
    assert.equal(claude.runner.callIdentity({ kind: "claude" }), undefined, "an explicit kind is already hashed by the engine");
    assert.equal(codex.runner.callIdentity({ kind: "claude" }), undefined);
  } finally {
    await claude.close();
    await codex.close();
  }
});

test("editing [runtime.<kind>].model invalidates cached calls that used it; an unchanged fleet replays (SPEC D4 consequence)", async () => {
  const SCRIPT = `export const meta = { name: 'hashed', description: 'fleet identity' }
return await agent('do the thing', { label: 'worker', model: 'opus' })`;
  const journal = new Map<string, JournalEntry>();

  // Run 1: journal the call under the original resolution.
  const first = await startHarness(FLEET_TOML);
  first.server.on("agent.prompt", writesResult("original flags"));
  try {
    const run = await runWorkflow(SCRIPT, {
      agent: first.runner,
      persistLogs: false,
      runId: "fleetrun",
      onAgentJournal: (entry) => journal.set(`fleetrun:${entry.index}`, entry),
    });
    assert.equal(run.result, "original flags");
  } finally {
    await first.close();
  }

  // Run 2: same fleet -> replay from the journal, no live agent.
  const same = await startHarness(FLEET_TOML);
  try {
    const run = await runWorkflow(SCRIPT, {
      agent: same.runner,
      persistLogs: false,
      runId: "fleetrun",
      resumeJournal: journal,
      resumeFromRunId: "fleetrun",
    });
    assert.equal(run.result, "original flags");
    assert.equal(same.server.calls.length, 0, "an unchanged fleet must replay without touching the socket");
  } finally {
    await same.close();
  }

  // Run 3: the fleet's model.opus mapping changed -> the cached call is
  // invalid and the agent runs live under the NEW flags.
  const edited = await startHarness(FLEET_TOML.replace('model.opus = ["--model", "opus"]', 'model.opus = ["--model", "opus-4.5"]'));
  edited.server.on("agent.prompt", writesResult("new flags"));
  try {
    const run = await runWorkflow(SCRIPT, {
      agent: edited.runner,
      persistLogs: false,
      runId: "fleetrun",
      resumeJournal: journal,
      resumeFromRunId: "fleetrun",
    });
    assert.equal(run.result, "new flags", "the edited resolution must invalidate the cached result");
    assert.deepEqual(edited.server.callsFor("agent.start")[0]!.params.args, [
      "--model",
      "opus-4.5",
      "--dangerously-skip-permissions",
    ]);
  } finally {
    await edited.close();
  }
});

// ─── D15: on_blocked = "escalate" ────────────────────────────────────────────

const ESCALATE_FLEET = FLEET_TOML.replace('on_blocked = "fail"', 'on_blocked = "escalate"');

test("escalate: a blocked worker is left OPEN, recorded, persisted, and the failure carries the attach command", async () => {
  const harness = await startHarness(ESCALATE_FLEET, { session: "flowtest" });
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
          "but NOT retryable: the escalated worker keeps its pane AND its machine slot (SPEC D15 — escalate " +
            "does not free capacity), so an engine retry would park forever on the very slot the escalation holds",
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
  const harness = await startHarness(ESCALATE_FLEET, { session: "flowtest" });
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

test("escalate + engine retries settles (no deadlock): the escalated call is NOT retried and collapses to null", async () => {
  // Regression lock (measured live before the fix): the escalated call keeps
  // its machine slot (D15) but used to fail plain-recoverable, so the
  // engine's automatic retry re-entered acquireMachine and parked FOREVER on
  // the very slot the escalation holds — runWorkflow never settled. With
  // retryable:false the call collapses to null on the first escalation: one
  // tab, one escalation record, the run finishes.
  const fleet = `${ESCALATE_FLEET}\n`.replace('[[machine]]\nname = "local"', '[[machine]]\nname = "local"\nslots = 1');
  const harness = await startHarness(fleet, { session: "flowtest" });
  const { server } = harness;
  server.on("agent.prompt", (params) => ({
    type: "agent_prompted",
    agent: server.makeAgentInfo((params as { target?: unknown })?.target, "blocked"),
  }));
  const histories: Array<Record<string, unknown>> = [];
  try {
    const outcome = await Promise.race([
      runWorkflow(
        `export const meta = { name: 'esc-retry', description: 'escalate under engine retries' }
return await agent('needs approval', { label: 'worker' })`,
        {
          agent: harness.runner,
          persistLogs: false,
          runId: "escretry",
          agentRetries: 2, // the plugin entry points hardcode 2 — the deadlock trigger
          onAgentHistory: ({ history }) => histories.push(...history),
        },
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("DEADLOCK: runWorkflow never settled — the retry parked on the held slot")), 10_000),
      ),
    ]);
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
  const harness = await startHarness(ESCALATE_FLEET);
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

test("default fail policy through runWorkflow is unchanged: blocked tears down and the call collapses per engine rules", async () => {
  const harness = await startHarness(FLEET_TOML);
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
  const harness = await startHarness(ESCALATE_FLEET, { session: "flowtest", localSessionMode: "default" });
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
