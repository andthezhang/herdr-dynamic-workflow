/**
 * Tests for HerdrAgentRunner (src/runner/herdr-runner.ts) against the
 * MockHerdrServer: the D11 topology (workspace.create once per run ->
 * tab.create per call -> agent.start -> agent.prompt -> harvest -> tab.close;
 * workspace.close on runner.close()), pane-busy backoff, prompt-stalled
 * esc-retry, blocked, missing-output fallback, schema pass/noncompliance,
 * abort teardown, the broken-kind guard, and the HERDR_SOCKET_PATH env trap.
 * Launch flags, hash identity, and the onBlocked escalate policy live in
 * herdr-runner-flags.test.ts; ssh placement in herdr-runner-remote.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { runWorkflow } from "../src/engine/workflow.js";
import { OUTPUT_CONTRACT_PREAMBLE } from "../src/runner/contract.js";
import { HERDR_BLOCKED, HerdrAgentRunner, HerdrWorkflowError, normalizeAgentKind } from "../src/runner/herdr-runner.js";
import { SshHerdrTransport } from "../src/runner/ssh-transport.js";
import { FakeRemoteMachine } from "./fake-ssh.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

interface Harness {
  server: MockHerdrServer;
  runner: HerdrAgentRunner;
  stateDir: string;
  close(): Promise<void>;
}

async function startHarness(runnerOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-state-"));
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "codex" },
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

/** Real-shaped agent.prompt success: {type:"agent_prompted", agent:{agent_status}}. */
function agentPrompted(server: MockHerdrServer, target: unknown, status: string) {
  return { type: "agent_prompted", agent: server.makeAgentInfo(target, status) };
}

/** agent.prompt handler that plays a compliant agent: writes the output file. */
function writesResult(value: unknown, status = "done") {
  return async (params: { target?: unknown } | undefined, server: MockHerdrServer) => {
    const env = server.lastTabEnv;
    assert.ok(env?.HERDR_FLOW_OUT, "tab.create must inject HERDR_FLOW_OUT before the prompt");
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: value }));
    return agentPrompted(server, params?.target, status);
  };
}

test("happy path end-to-end through runWorkflow: real socket, fake agent writes the output file", async () => {
  const harness = await startHarness();
  const { server } = harness;
  // The §7 trap, exercised on the real flow: even with HERDR_SOCKET_PATH
  // pointing somewhere else entirely, the runner drives its constructed path.
  const previousEnv = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/nonexistent/users-own-session.sock";
  server.on("agent.prompt", writesResult("hello from the pane"));
  try {
    const run = await runWorkflow(
      `export const meta = { name: 'happy', description: 'herdr happy path' }
const a = await agent('Review the diff for regressions.', { label: 'reviewer', kind: 'claude' })
return a`,
      { agent: harness.runner, persistLogs: false, runId: "runhappy1" },
    );
    assert.equal(run.result, "hello from the pane");
    assert.equal(run.agentCount, 1);

    // Full call sequence, in order (D11: workspace per run, tab per call;
    // agent.get is the post-start readiness poll — agent.start only types the
    // launch command, so prompting without the poll fails agent_not_ready).
    const methods = server.calls.map((call) => call.method);
    assert.deepEqual(methods, ["workspace.create", "tab.create", "agent.start", "agent.get", "agent.prompt", "tab.close"]);

    // workspace.create: labeled for the run, never focused.
    const workspace = server.callsFor("workspace.create")[0]!.params;
    assert.equal(workspace.label, "flow/runhappy1");
    assert.equal(workspace.focus, false);

    // tab.create: in the run's workspace, env injected, focus false, tab label
    // carries the agent's identity (D16 progress view).
    const tab = server.callsFor("tab.create")[0]!.params;
    assert.equal(tab.workspace_id, "w1");
    assert.equal(tab.focus, false);
    assert.equal(tab.label, "reviewer");
    assert.equal(tab.env.HERDR_FLOW_RUN, "runhappy1");
    assert.equal(tab.env.HERDR_FLOW_CALL, "0");
    assert.ok(String(tab.env.HERDR_FLOW_OUT).endsWith(path.join("runhappy1", "0.json")));
    assert.equal(tab.env.HERDR_FLOW_SCHEMA, undefined, "no schema -> no schema path");

    // agent.start: the response's root-pane id used (never predicted — the
    // workspace's own root pane is w1:p1, the call's tab minted w1:p2), name
    // constraint met, call-site kind wins over the runner default.
    const start = server.callsFor("agent.start")[0]!.params;
    assert.equal(start.pane_id, "w1:p2");
    assert.equal(start.kind, "claude");
    assert.match(start.name, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.ok(start.name.length <= 32);

    // agent.prompt: preamble prepended verbatim, wait armed atomically on all
    // three settled states.
    const prompt = server.callsFor("agent.prompt")[0]!.params;
    assert.equal(prompt.target, start.name);
    assert.ok(prompt.text.startsWith(OUTPUT_CONTRACT_PREAMBLE));
    assert.ok(prompt.text.includes("Review the diff for regressions."));
    assert.deepEqual(prompt.wait.until, ["idle", "done", "blocked"]);
    assert.ok(prompt.wait.timeout_ms > 0);

    // Per-call teardown: the call's tab was actually closed (its pane with it).
    assert.equal(server.callsFor("tab.close")[0]!.params.tab_id, "w1:t2");

    // Run teardown: closing the runner closes the run's workspace.
    await harness.runner.close();
    assert.equal(server.callsFor("workspace.close")[0]!.params.workspace_id, "w1");
  } finally {
    if (previousEnv === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousEnv;
    await harness.close();
  }
});

test("agent_pane_busy on agent.start is retried with backoff until the shell is ready", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.queueResponses(
    "agent.start",
    MockHerdrServer.fail("agent_pane_busy"),
    MockHerdrServer.fail("agent_pane_busy"),
  );
  server.on("agent.prompt", writesResult("after busy retries"));
  try {
    const result = await harness.runner.run("do the work", { label: "worker" });
    assert.equal(result, "after busy retries");
    assert.equal(server.callsFor("agent.start").length, 3, "two busy failures then success");
  } finally {
    await harness.close();
  }
});

test("agent_pane_busy exhausts after 3 retries and maps to a recoverable error", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.start", MockHerdrServer.fail("agent_pane_busy"));
  try {
    await assert.rejects(harness.runner.run("busy forever", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      assert.equal(error.herdrCode, "agent_pane_busy");
      return true;
    });
    assert.equal(server.callsFor("agent.start").length, 4, "initial attempt + 3 retries");
    assert.equal(server.callsFor("tab.close").length, 1, "tab freed even on failure");
  } finally {
    await harness.close();
  }
});

test("agent tabs open in the runner's default cwd; a call-site cwd (worktree) wins", async () => {
  // Measured live: with no cwd at all, tab.create lands the pane in the
  // server process's home directory — the agent cannot see the project, and
  // claude drifted into answering inline instead of honoring the output-file
  // contract there.
  const harness = await startHarness({ defaults: { kind: "codex", cwd: "/repo/checkout" } });
  const { server } = harness;
  server.on("agent.prompt", writesResult("done"));
  try {
    await harness.runner.run("first", { label: "a" });
    await harness.runner.run("second", { label: "b", cwd: "/worktrees/b" });
    const tabs = server.callsFor("tab.create");
    assert.equal(tabs[0]!.params.cwd, "/repo/checkout", "default cwd applies when the call names none");
    assert.equal(tabs[1]!.params.cwd, "/worktrees/b", "call-site cwd (isolation) wins over the default");
  } finally {
    await harness.close();
  }
});

test("readiness poll: launch_pending/working agent is polled until interactive_ready", async () => {
  const harness = await startHarness();
  const { server } = harness;
  // agent.start returns immediately; the first two agent.get polls still show
  // a starting agent (mirrors the real server's launch_pending window).
  server.queueResponses(
    "agent.get",
    (params) => ({
      type: "agent_info",
      agent: server.makeAgentInfo(params?.target, "working", { launch_pending: true, interactive_ready: false }),
    }),
    (params) => ({
      type: "agent_info",
      agent: server.makeAgentInfo(params?.target, "idle", { launch_pending: true, interactive_ready: false }),
    }),
  );
  server.on("agent.prompt", writesResult("ready after polling"));
  try {
    const result = await harness.runner.run("wait for me", { label: "worker" });
    assert.equal(result, "ready after polling");
    assert.equal(server.callsFor("agent.get").length, 3, "two not-ready polls, then the ready one");
    const order = server.calls.map((call) => call.method);
    assert.ok(order.lastIndexOf("agent.get") < order.indexOf("agent.prompt"), "never prompt before the poll passes");
  } finally {
    await harness.close();
  }
});

test("readiness poll: a kind ALIAS ('claude-code') succeeds although detection reports the CANONICAL label ('claude')", async () => {
  // Ground truth (herdr src/detect/mod.rs lookup_agent + src/app/agents.rs):
  // agent.start accepts kind aliases, but AgentInfo.agent carries the
  // canonical detection label. The runner must not compare the raw configured
  // kind against the detected one — that check failed every alias
  // deterministically with a spurious agent_kind_mismatch (and herdr's own
  // CLI normalizes through an alias table we must not duplicate, SPEC D14).
  const harness = await startHarness({ defaults: { kind: "claude-code" } });
  const { server } = harness;
  server.on("agent.get", (params) => ({
    type: "agent_info",
    // Detection succeeded: the canonical label, not the requested alias.
    agent: server.makeAgentInfo(params?.target, "idle", { agent: "claude" }),
  }));
  server.on("agent.prompt", writesResult("alias worked"));
  try {
    const result = await harness.runner.run("do it", { label: "worker" });
    assert.equal(result, "alias worked", "an alias kind must never fail the readiness poll");
    assert.equal(server.callsFor("agent.start")[0]!.params.kind, "claude-code", "the alias goes to the server verbatim");
  } finally {
    await harness.close();
  }
});

test("a resumed run never harvests the PREVIOUS execution's stale output file (out path truncated before the prompt)", async () => {
  // A resume constructs a FRESH runner (callSeq back at 0) with the original
  // runId against the same persistent stateDir, so a live resumed call's
  // HERDR_FLOW_OUT is exactly the crashed run's `<runId>/0.json`. The runner
  // must wipe that path before prompting: with a contract-violating agent
  // (writes nothing) and an empty screen, the call must fail
  // AGENT_EMPTY_OUTPUT — never silently return the stale payload.
  const harness = await startHarness();
  const { server, stateDir, runner } = harness;
  const stalePath = path.join(stateDir, "stalerun", "0.json");
  await mkdir(path.dirname(stalePath), { recursive: true });
  await writeFile(stalePath, JSON.stringify({ ok: true, result: "STALE answer from the crashed run" }));
  try {
    // Default mock agent.prompt settles idle WITHOUT writing the file;
    // default agent.read returns an empty screen.
    await assert.rejects(
      runner.run("recompute", { label: "w", sessionName: "workflow:stalerun w" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT, "missing output, not the stale payload");
        return true;
      },
    );
    assert.equal(readFileSync(stalePath, "utf8"), "", "the stale file was truncated before the prompt");
  } finally {
    await harness.close();
  }
});

test("readiness poll: blocked during startup is the agent_not_ready placement failure", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "blocked"),
  }));
  try {
    await assert.rejects(harness.runner.run("trust prompt ahead", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.herdrCode, "agent_not_ready");
      assert.equal(error.recoverable, false, "placement failures must not be retried into the same trust prompt");
      return true;
    });
    assert.equal(server.callsFor("agent.prompt").length, 0, "a blocked launch is never prompted");
    assert.equal(server.callsFor("tab.close").length, 1, "the tab is still freed");
  } finally {
    await harness.close();
  }
});

test("readiness poll: a settled agent that is not pending and not interactive means the CLI exited", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "done", { interactive_ready: false }),
  }));
  try {
    await assert.rejects(harness.runner.run("crashy CLI", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.herdrCode, "agent_start_failed");
      assert.equal(error.recoverable, true);
      assert.match(error.message, /exited before becoming interactive/);
      return true;
    });
    assert.equal(server.callsFor("agent.prompt").length, 0);
  } finally {
    await harness.close();
  }
});

test("agent_not_ready is a placement failure: non-recoverable and never retried at this layer", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.start", MockHerdrServer.fail("agent_not_ready"));
  try {
    await assert.rejects(harness.runner.run("nope", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.herdrCode, "agent_not_ready");
      assert.equal(
        error.recoverable,
        false,
        "placement failures are deterministic per (host, kind): recoverable would let the engine retry them identically and then null the call",
      );
      return true;
    });
    assert.equal(server.callsFor("agent.start").length, 1, "no retry on agent_not_ready");
  } finally {
    await harness.close();
  }
});

test("agent_not_ready propagates through runWorkflow as a halt, not a silent null (reference §1 phase 2)", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.start", MockHerdrServer.fail("agent_not_ready"));
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'placement', description: 'placement failure' }
return await agent('task', { label: 'x' })`,
        { agent: harness.runner, persistLogs: false, agentRetries: 2 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, "agent_not_ready");
        return true;
      },
    );
    assert.equal(server.callsFor("agent.start").length, 1, "engine-level retries must not replay a placement failure");
  } finally {
    await harness.close();
  }
});

test("agent_prompt_stalled: one esc then retry succeeds", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.queueResponses("agent.prompt", MockHerdrServer.fail("agent_prompt_stalled"));
  server.on("agent.prompt", writesResult("second try landed"));
  try {
    const result = await harness.runner.run("stubborn composer", { label: "worker" });
    assert.equal(result, "second try landed");
    assert.equal(server.callsFor("agent.prompt").length, 2);
    const sends = server.callsFor("agent.send_keys");
    assert.equal(sends.length, 1, "exactly one esc between the attempts");
    assert.deepEqual(sends[0]!.params.keys, ["esc"]);
  } finally {
    await harness.close();
  }
});

test("agent_prompt_stalled twice fails recoverable after exactly one retry", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", MockHerdrServer.fail("agent_prompt_stalled"));
  try {
    await assert.rejects(harness.runner.run("never starts", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      assert.equal(error.herdrCode, "agent_prompt_stalled");
      return true;
    });
    assert.equal(server.callsFor("agent.prompt").length, 2, "one retry only");
    assert.equal(server.callsFor("agent.send_keys").length, 1);
  } finally {
    await harness.close();
  }
});

test("a wait that resolves blocked fails the call with the distinct BLOCKED code and diagnostic identity", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", (params) => agentPrompted(server, params?.target, "blocked"));
  try {
    await assert.rejects(harness.runner.run("needs approval", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.herdrCode, HERDR_BLOCKED);
      assert.equal(error.recoverable, true, "M1 policy: fail recoverable; a real policy engine comes later");
      const details = error.details as { tabId?: string; paneId?: string; agentName?: string; paneClosed?: boolean };
      assert.equal(details.tabId, "w1:t2");
      assert.equal(details.paneId, "w1:p2");
      assert.match(String(details.agentName), /^flow-/);
      // The identity is diagnostic only: under the default "fail" policy,
      // teardown closes the tab before the caller sees this error, and the
      // error must say so honestly rather than promising a findable tab/pane.
      assert.equal(details.paneClosed, true, "the error must not advertise a pane that teardown destroys");
      assert.match(error.message, /torn down/i);
      return true;
    });
    assert.equal(server.callsFor("tab.close").length, 1, "default fail policy: the blocked tab is still freed");
  } finally {
    await harness.close();
  }
});

test("a wait timeout maps to AGENT_TIMEOUT", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", MockHerdrServer.fail("timeout", "wait timed out after 900000 ms"));
  try {
    await assert.rejects(harness.runner.run("slow", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_TIMEOUT);
      assert.equal(error.recoverable, true);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("missing output file falls back to agent.read visible, tagged output_file_missing", async () => {
  const harness = await startHarness();
  const { server } = harness;
  // Default agent.prompt writes nothing; the visible screen has the answer.
  server.on("agent.read", () => ({
    type: "pane_read",
    read: {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t2",
      source: "visible",
      format: "text",
      text: "  the visible screen answer  ",
      revision: 3,
      truncated: false,
    },
  }));
  const histories: Array<Record<string, unknown>> = [];
  try {
    const result = await harness.runner.run("write the file please", {
      label: "worker",
      onHistory: (entries) => histories.push(...entries),
    });
    assert.equal(result, "the visible screen answer");
    // §6 ladder step 1: the wait is not trusted — state re-checked BEFORE the
    // scrape (call 1 is the post-start readiness poll, call 2 the re-check).
    assert.equal(server.callsFor("agent.get").length, 2, "agent.get re-check must precede the degraded fallback");
    assert.equal(server.callsFor("agent.explain").length, 1, "agent.explain re-check must precede the degraded fallback");
    const order = server.calls.map((call) => call.method);
    assert.ok(
      order.indexOf("agent.prompt") < order.lastIndexOf("agent.get") &&
        order.lastIndexOf("agent.get") < order.indexOf("agent.read"),
      "re-check first, scrape second",
    );
    const read = server.callsFor("agent.read")[0]!.params;
    assert.equal(read.source, "visible");
    assert.equal(read.strip_ansi, true);
    const fallback = histories.find((entry) => entry.fallbackReason === "output_file_missing");
    assert.ok(fallback, "fallback harvest must be tagged with fallbackReason output_file_missing");
    assert.equal(fallback.agentStatus, "idle", "the re-checked settled status rides along in the fallback tag");
  } finally {
    await harness.close();
  }
});

test("false settle: wait resolved while the agent was still working — re-arm agent.wait, then harvest the file", async () => {
  // Measured live (claude on 0.8.0): screen detection can flap through a
  // settled state mid-turn, so agent.prompt's wait resolves `done` while the
  // agent is still generating. Tearing down there kills it mid-answer. The
  // runner must re-check, see `working`, re-arm one agent.wait, and only then
  // harvest.
  const harness = await startHarness();
  const { server } = harness;
  // agent.get call 1 = readiness poll (ready); call 2 = harvest probe (still
  // working — the settle was false).
  server.queueResponses(
    "agent.get",
    (params) => ({ type: "agent_info", agent: server.makeAgentInfo(params?.target, "idle") }),
    (params) => ({ type: "agent_info", agent: server.makeAgentInfo(params?.target, "working") }),
  );
  // The re-armed wait is where the agent actually finishes and writes.
  server.on("agent.wait", async (params, srv) => {
    const env = srv.lastTabEnv;
    assert.ok(env?.HERDR_FLOW_OUT);
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: "finished during the re-wait" }));
    return { type: "agent_info", agent: srv.makeAgentInfo((params as { target?: unknown })?.target, "done") };
  });
  const histories: Array<Record<string, unknown>> = [];
  try {
    const result = await harness.runner.run("slow but honest", {
      label: "worker",
      onHistory: (entries) => histories.push(...entries),
    });
    assert.equal(result, "finished during the re-wait");
    assert.equal(server.callsFor("agent.wait").length, 1, "exactly one re-armed wait");
    const waitParams = server.callsFor("agent.wait")[0]!.params;
    assert.deepEqual(waitParams.until, ["idle", "done", "blocked"]);
    const diagnostic = histories.find((entry) => entry.code === "false_settle_rewait");
    assert.ok(diagnostic, "the false settle must be surfaced as a diagnostic");
    assert.equal(server.callsFor("agent.read").length, 0, "no degraded scrape when the file arrives");
  } finally {
    await harness.close();
  }
});

test("missing output file with a false-idle wait: blocked re-check fails BLOCKED instead of scraping the prompt screen", async () => {
  // Reference §2: an unrecognized permission prompt reads as idle/done — the
  // wait resolves, the file is absent, and the agent is actually sitting on a
  // y/n prompt. The §6 ladder's re-check must catch this; returning the
  // visible screen (the permission prompt itself) would be the silent wrong
  // answer the reference warns about.
  const harness = await startHarness();
  const { server } = harness;
  // The startup readiness poll (agent.get call 1) sees a healthy launch; the
  // harvest re-check (call 2 onward) discovers the blocked truth.
  server.queueResponses("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "idle"),
  }));
  server.on("agent.get", (params) => ({
    type: "agent_info",
    agent: server.makeAgentInfo(params?.target, "blocked"),
  }));
  server.on("agent.explain", () => ({
    type: "agent_explain",
    explain: { matched: "approval chrome: 'Do you trust this folder? (y/n)'" },
  }));
  server.on("agent.read", () => ({
    type: "pane_read",
    read: {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t2",
      source: "visible",
      format: "text",
      text: "Do you trust this folder? (y/n)",
      revision: 3,
      truncated: false,
    },
  }));
  try {
    await assert.rejects(harness.runner.run("write the file please", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.herdrCode, HERDR_BLOCKED);
      const details = error.details as { explanation?: string; paneClosed?: boolean };
      assert.match(String(details.explanation), /trust this folder/);
      assert.equal(details.paneClosed, true);
      return true;
    });
    assert.equal(server.callsFor("agent.read").length, 0, "a blocked agent's screen must never be harvested as a result");
    assert.equal(server.callsFor("tab.close").length, 1);
  } finally {
    await harness.close();
  }
});

test("missing output file with an empty screen is recoverable AGENT_EMPTY_OUTPUT", async () => {
  const harness = await startHarness();
  try {
    await assert.rejects(harness.runner.run("silent agent", { label: "worker" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      assert.equal(error.recoverable, true);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("missing output file with a schema never takes the screen fallback", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.read", () => ({ text: "not schema-shaped prose" }));
  try {
    await assert.rejects(
      harness.runner.run("structured please", { label: "worker", schema: { type: "object" } }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
        assert.equal(error.recoverable, true);
        return true;
      },
    );
    assert.equal(server.callsFor("agent.read").length, 0, "a screen scrape can never satisfy a schema");
  } finally {
    await harness.close();
  }
});

test("schema pass: schema file delivered via env AND inlined in the prompt, result validated and coerced", async () => {
  const harness = await startHarness();
  const { server } = harness;
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  server.on("agent.prompt", async (params, srv) => {
    // Measured live: agents often skip reading the HERDR_FLOW_SCHEMA file and
    // write a plain string; the schema must ALSO ride inline in the prompt.
    const text = String((params as { text?: unknown })?.text);
    assert.ok(text.includes('"n"'), "the schema JSON must be inlined in the prompt");
    assert.ok(text.includes("MUST validate against it"), "with an explicit compliance demand");
    const env = srv.lastTabEnv!;
    assert.ok(env.HERDR_FLOW_SCHEMA, "schema path must be in the pane env");
    assert.ok(existsSync(env.HERDR_FLOW_SCHEMA), "schema file must exist before the agent runs");
    assert.deepEqual(JSON.parse(readFileSync(env.HERDR_FLOW_SCHEMA, "utf8")), schema);
    assert.ok(env.HERDR_FLOW_OUT, "output path must be in the pane env");
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: { n: "7" } }));
    return { status: "idle" };
  });
  try {
    const result = await harness.runner.run("count things", { label: "worker", schema });
    assert.deepEqual(result, { n: 7 }, "ajv coercion applied");
  } finally {
    await harness.close();
  }
});

test("SCHEMA_NONCOMPLIANCE halts the run (through runWorkflow), never a silent null", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult({ wrong: "shape" }));
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'strict', description: 'schema noncompliance' }
return await agent('structured', { label: 'x', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })`,
        { agent: harness.runner, persistLogs: false, agentRetries: 1 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
        assert.equal(error.recoverable, false);
        return true;
      },
    );
    assert.equal(server.callsFor("agent.prompt").length, 1, "non-recoverable: the engine must not retry it");
  } finally {
    await harness.close();
  }
});

test("abort: send_keys esc -> ctrl+c -> tab.close actually frees the tab", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", () => new Promise(() => {})); // agent mid-turn forever
  const controller = new AbortController();
  try {
    const pending = harness.runner.run("long task", { label: "worker", signal: controller.signal });
    // Let the run reach the in-flight prompt, then abort.
    while (server.callsFor("agent.prompt").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });
    const sends = server.callsFor("agent.send_keys").map((call) => call.params.keys);
    assert.deepEqual(sends, [["esc"], ["ctrl+c"]], "esc, brief wait, then ctrl+c");
    assert.equal(server.callsFor("tab.close").length, 1, "teardown must actually free the tab");
    const order = server.calls.map((call) => call.method);
    assert.ok(
      order.indexOf("tab.close") > order.lastIndexOf("agent.send_keys"),
      "tab.close comes after the interrupt keys",
    );
  } finally {
    await harness.close();
  }
});

test("the ssh option selects the destination: a host name builds an ssh transport, its absence the local one", async () => {
  const remote = new FakeRemoteMachine();
  remote.onPrompt = (_args, machine) => {
    const out = machine.lastTabEnv?.HERDR_FLOW_OUT;
    assert.ok(out);
    machine.files.set(out, JSON.stringify({ ok: true, result: "ran on linux-01" }));
    return { status: "done" };
  };
  const placed: Array<string | undefined> = [];
  const harness = await startHarness({
    transportFactory: (ssh?: string) => {
      placed.push(ssh);
      return new SshHerdrTransport({
        target: ssh ?? "unused",
        session: "flow",
        exec: remote.exec,
        serverStartDelayMs: 1,
        serverStartRetries: 5,
      });
    },
  });
  const { server } = harness;
  try {
    assert.equal(await harness.runner.run("anywhere", { label: "worker", ssh: "linux-01" }), "ran on linux-01");
    assert.deepEqual(placed, ["linux-01"], "the factory receives the ssh Host name verbatim");
    assert.equal(server.calls.length, 0, "an ssh call must not touch the local socket");
  } finally {
    await harness.close();
  }
});

test("omitting ssh keeps the call on the local socket", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult("ran locally"));
  try {
    assert.equal(await harness.runner.run("here", { label: "worker" }), "ran locally");
    assert.ok(server.callsFor("tab.create").length >= 1);
  } finally {
    await harness.close();
  }
});

test("unsupported_agent_kind maps to non-recoverable SCRIPT_VALIDATION_ERROR", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.start", MockHerdrServer.fail("unsupported_agent_kind", "unknown kind 'foo'"));
  try {
    await assert.rejects(harness.runner.run("hi", { label: "worker", kind: "foo" }), (error: unknown) => {
      assert.ok(error instanceof HerdrWorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("runner constructor requires socketPath, stateDir, and defaults.kind", async () => {
  assert.throws(() => new HerdrAgentRunner({ socketPath: "", stateDir: "/tmp/x", defaults: { kind: "codex" } }), TypeError);
  assert.throws(
    () => new HerdrAgentRunner({ socketPath: "/tmp/x.sock", stateDir: "", defaults: { kind: "codex" } }),
    TypeError,
  );
  assert.throws(
    () => new HerdrAgentRunner({ socketPath: "/tmp/x.sock", stateDir: "/tmp/x", defaults: { kind: " " } }),
    TypeError,
  );
});

test("runner constructor rejects agentStartTimeoutMs outside Herdr's (3000, 300000] bounds", async () => {
  const base = { socketPath: "/tmp/x.sock", stateDir: "/tmp/x", defaults: { kind: "codex" } };
  // Herdr requires timeout_ms > 3000 (strict) and <= 300 000 (reference §1
  // phase 2); an out-of-range value would deterministically fail every
  // agent.start server-side, so it must fail fast at construction.
  for (const bad of [3000, 0, -1, 300_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new HerdrAgentRunner({ ...base, agentStartTimeoutMs: bad }),
      RangeError,
      `agentStartTimeoutMs=${bad} must be rejected`,
    );
  }
  // Boundary-legal values are accepted.
  for (const ok of [3001, 60_000, 300_000]) {
    const runner = new HerdrAgentRunner({ ...base, agentStartTimeoutMs: ok });
    runner.close();
  }
});

test("model/effort are passed straight through to agent.start — the runner keeps no vendor model table", async () => {
  const harness = await startHarness();
  const { server } = harness;
  try {
    server.on("agent.prompt", writesResult("claude opus"));
    assert.equal(await harness.runner.run("task", { label: "worker", kind: "claude", model: "opus" }), "claude opus");
    assert.deepEqual(server.callsFor("agent.start")[0]!.params.args, ["--dangerously-skip-permissions", "--model", "opus"]);

    server.on("agent.prompt", writesResult("codex effort"));
    assert.equal(await harness.runner.run("task", { label: "worker", effort: "high" }), "codex effort");
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

test("aborting mid tab.create does not leak the tab: the late reply's tab id is closed", async () => {
  const harness = await startHarness();
  const { server } = harness;
  // The create frame reaches the server, but the reply arrives only after the
  // client has aborted — the tab exists server-side while context.tabId was
  // never set, so neither abort teardown nor the finally-block close can see it.
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  server.queueResponses("tab.create", async (params, srv) => {
    await createGate;
    srv.tabEnvs.push({ ...(params?.env ?? {}) });
    return {
      type: "tab_created",
      tab: srv.makeTab("w1", "w1:t99", params?.label, params?.focus),
      root_pane: srv.makePane("w1", "w1:t99", "w1:p99", params?.cwd, params?.focus),
    };
  });
  const controller = new AbortController();
  try {
    const pending = harness.runner.run("task", { label: "worker", signal: controller.signal });
    while (server.callsFor("tab.create").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });
    assert.equal(server.callsFor("tab.close").length, 0, "nothing to close before the late reply lands");
    releaseCreate();
    // The late reply carries the orphaned tab id; the runner must close it.
    const deadline = Date.now() + 2000;
    while (server.callsFor("tab.close").length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.callsFor("tab.close").length, 1, "the orphaned tab must be closed from the late reply");
    assert.equal(server.callsFor("tab.close")[0]!.params.tab_id, "w1:t99");
  } finally {
    await harness.close();
  }
});

test("one workspace per run: sequential calls share it, and close() closes it exactly once", async () => {
  const harness = await startHarness();
  const { server } = harness;
  server.on("agent.prompt", writesResult("first"));
  try {
    assert.equal(await harness.runner.run("call one", { label: "a" }), "first");
    server.on("agent.prompt", writesResult("second"));
    assert.equal(await harness.runner.run("call two", { label: "b" }), "second");

    // Exactly one workspace for the whole run; one tab per call inside it.
    assert.equal(server.callsFor("workspace.create").length, 1);
    const tabs = server.callsFor("tab.create");
    assert.equal(tabs.length, 2);
    assert.deepEqual(
      tabs.map((call) => call.params.workspace_id),
      ["w1", "w1"],
    );
    assert.deepEqual(
      tabs.map((call) => call.params.label),
      ["a", "b"],
    );
    // Each call's tab was torn down; the workspace is still alive until close().
    assert.equal(server.callsFor("tab.close").length, 2);
    assert.equal(server.callsFor("workspace.close").length, 0);

    await harness.runner.close();
    await harness.runner.close(); // idempotent
    assert.equal(server.callsFor("workspace.close").length, 1, "close() closes the run's workspace exactly once");
    assert.equal(server.callsFor("workspace.close")[0]!.params.workspace_id, "w1");
  } finally {
    await harness.close();
  }
});

test("concurrent first calls race into ONE workspace.create, not one each", async () => {
  const harness = await startHarness();
  const { server } = harness;
  // Concurrency-safe compliant agent: each prompt writes ITS OWN call's output
  // file (matched via the agent name's call-index suffix against the tab env),
  // not whichever tab happened to be created last.
  server.on("agent.prompt", async (params, srv) => {
    const callIndex = String((params as { target?: unknown })?.target).match(/-(\d+)$/)?.[1];
    const env = srv.tabEnvs.find((entry) => entry.HERDR_FLOW_CALL === callIndex);
    assert.ok(env?.HERDR_FLOW_OUT, "each call's tab env must carry its own HERDR_FLOW_OUT");
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: "fanout" }));
    return { status: "done" };
  });
  try {
    const [a, b] = await Promise.all([
      harness.runner.run("left", { label: "left" }),
      harness.runner.run("right", { label: "right" }),
    ]);
    assert.equal(a, "fanout");
    assert.equal(b, "fanout");
    assert.equal(server.callsFor("workspace.create").length, 1, "fan-out must share the memoized workspace");
    assert.equal(server.callsFor("tab.create").length, 2);
  } finally {
    await harness.close();
  }
});

// ── Workspace labels (workflow-named sidebars) ────────────────────────────────

test("keepWorkspace leaves tabs and the workspace open after close()", async () => {
  const harness = await startHarness({ keepWorkspace: true, workspaceLabel: "PR 412 reviews · ab12" });
  const { server } = harness;
  server.on("agent.prompt", writesResult("kept"));
  try {
    assert.equal(await harness.runner.run("review", { label: "reviewer" }), "kept");
    assert.equal(server.callsFor("tab.close").length, 0, "--keep must not close the agent tab");
    await harness.runner.close();
    assert.equal(server.callsFor("workspace.close").length, 0, "--keep must not close the workspace");
    assert.equal(server.callsFor("workspace.create")[0]!.params.label, "PR 412 reviews · ab12");
  } finally {
    await harness.close();
  }
});

test("keepWorkspace still closes the tab when the call is aborted", async () => {
  const harness = await startHarness({ keepWorkspace: true });
  const { server } = harness;
  server.on("agent.prompt", () => new Promise(() => {}));
  const controller = new AbortController();
  try {
    const pending = harness.runner.run("long task", { label: "worker", signal: controller.signal });
    while (server.callsFor("agent.prompt").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });
    assert.equal(server.callsFor("tab.close").length, 1, "abort still frees the cancelled tab");
  } finally {
    await harness.close();
  }
});

test("workspaceLabel threads into workspace.create; absent -> the flow/<runId> fallback", async () => {
  const harness = await startHarness({ workspaceLabel: "auth_refactor · ab12" });
  const { server } = harness;
  server.on("agent.prompt", writesResult("labeled"));
  try {
    const result = await harness.runner.run("task", { label: "worker" });
    assert.equal(result, "labeled");
    assert.equal(
      server.callsFor("workspace.create")[0]!.params.label,
      "auth_refactor · ab12",
      "the sidebar label must lead with the workflow's name",
    );
    // Tab (agent) labels are unchanged by the workspace label.
    assert.equal(server.callsFor("tab.create")[0]!.params.label, "worker");
  } finally {
    await harness.close();
  }
  // The fallback is exercised end-to-end by the happy-path test above
  // (workspace.create label "flow/runhappy1" with no workspaceLabel set).
});

// ── Broken-kind guard: cline can never settle (no idle rule) ─────────────────

test("kind cline at the call site is rejected before ANY socket work (local)", async () => {
  const harness = await startHarness();
  const { server } = harness;
  try {
    await assert.rejects(
      harness.runner.run("task", { label: "clined", kind: "cline" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /cline/);
        assert.match(error.message, /no idle rule/);
        return true;
      },
    );
    assert.equal(server.calls.length, 0, "the guard must fire before any pane/socket traffic");
    // The same guard fires from the engine's hash path.
    assert.throws(
      () => harness.runner.callIdentity({ kind: "cline" }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
  } finally {
    await harness.close();
  }
});

test("kind cline on an ssh placement is rejected before any transport is built", async () => {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-cline-"));
  let transportsBuilt = 0;
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "codex" },
    transportFactory: () => {
      transportsBuilt++;
      throw new Error("transportFactory must never be reached for a rejected kind");
    },
  });
  try {
    await assert.rejects(
      runner.run("task", { label: "remote-clined", kind: "cline", ssh: "far" }),
      (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
    assert.equal(transportsBuilt, 0);
    assert.equal(server.calls.length, 0);
  } finally {
    await runner.close();
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a cline DEFAULT kind is rejected at construction, before any pane work", async () => {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-cline-default-"));
  try {
    assert.throws(
      () =>
        new HerdrAgentRunner({
          socketPath: server.socketPath,
          stateDir,
          defaults: { kind: "cline" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /cline/);
        return true;
      },
    );
  } finally {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the guard normalizes kinds exactly as herdr does: "Cline", "CLINE", " cline ", "cline.exe" all rejected', async () => {
  // Herdr's server validates agent.start kinds through parse_agent_label,
  // which trims, lowercases, and strips launcher suffixes FIRST (herdr
  // src/detect/mod.rs normalized_agent_lookup_name) — so these spellings
  // would all launch a real cline agent and hang every prompt wait. An
  // exact-match guard would let every one of them through.
  assert.equal(normalizeAgentKind(" Cline.EXE "), "cline");
  assert.equal(normalizeAgentKind("cline.js"), "cline");
  assert.equal(normalizeAgentKind("claude"), "claude");
  // Only ONE suffix is stripped, same as herdr's `break`.
  assert.equal(normalizeAgentKind("cline.exe.exe"), "cline.exe");

  const harness = await startHarness();
  const { server } = harness;
  try {
    for (const spelling of ["Cline", "CLINE", " cline ", "cline.exe", "Cline.exe"]) {
      await assert.rejects(
        harness.runner.run("task", { label: "clined", kind: spelling }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError, `${JSON.stringify(spelling)} must be rejected`);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          return true;
        },
      );
      assert.throws(
        () => harness.runner.callIdentity({ kind: spelling }),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        `callIdentity(${JSON.stringify(spelling)}) must be rejected`,
      );
    }
    assert.equal(server.calls.length, 0, "every spelling must be rejected before any socket traffic");
    // Normalization must not over-reject: a kind that merely CONTAINS cline is fine.
    assert.doesNotThrow(() => harness.runner.callIdentity({ kind: "clinex" }));
  } finally {
    await harness.close();
  }
});

// ── Budget unit: one agent call per completed call (SPEC D8) ─────────────────

test("a completed call reports usage total=1: budget's unit is agent calls, never a token estimate", async () => {
  const harness = await startHarness();
  harness.server.on("agent.prompt", writesResult("counted"));
  const usages: Array<Record<string, number>> = [];
  try {
    const value = await harness.runner.run("do the thing", {
      label: "worker",
      kind: "claude",
      sessionName: "workflow:runusage worker",
      onUsage: (usage) => usages.push({ ...usage }),
    });
    assert.equal(value, "counted");
    // total=1 = one agent call. A zero total would make the engine substitute
    // a JSON-length token ESTIMATE (workflow.ts recordTokens), silently
    // turning budget/phase budgets into pseudo-token units — the SKILL and
    // SPEC D8 promise agent-call units.
    assert.deepEqual(usages, [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 }]);
  } finally {
    await harness.close();
  }
});
