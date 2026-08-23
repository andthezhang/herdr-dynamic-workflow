/**
 * HerdrAgentRunner ssh placement (SPEC D13, M3): a call that names an `ssh`
 * host runs the full D11 topology through SshHerdrTransport against a faked
 * ssh, while a call that omits `ssh` keeps using the local socket. Covers the
 * placement rule (the option is the host name, nothing else), the login-shell
 * herdr probe, the remote output-file contract (remote HERDR_FLOW_* paths,
 * ssh-cat harvest, remote schema write, remote HOME cwd), the worktree-
 * isolation guard, and ssh escalation (ssh attach command, workspace
 * preserved).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { HERDR_BLOCKED, HerdrAgentRunner, HerdrWorkflowError } from "../src/runner/herdr-runner.js";
import { SshHerdrTransport } from "../src/runner/ssh-transport.js";
import { LocalHerdrTransport } from "../src/runner/transport.js";
import { FakeRemoteMachine } from "./fake-ssh.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

interface Harness {
  server: MockHerdrServer;
  runner: HerdrAgentRunner;
  stateDir: string;
  /** The faked host behind one ssh target (created on demand). */
  host(target: string): FakeRemoteMachine;
  close(): Promise<void>;
}

async function startHarness(runnerOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-remote-state-"));
  const fakes = new Map<string, FakeRemoteMachine>();
  const host = (target: string): FakeRemoteMachine => {
    let fake = fakes.get(target);
    if (!fake) {
      fake = new FakeRemoteMachine();
      fakes.set(target, fake);
    }
    return fake;
  };
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "claude", cwd: "/Users/alex/Documents/Github/herdr-dynamic-workflow" },
    session: "flow",
    transportFactory: (ssh) =>
      ssh === undefined
        ? new LocalHerdrTransport({ socketPath: server.socketPath, defaultTimeoutMs: 5_000 })
        : new SshHerdrTransport({
            target: ssh,
            session: "flow",
            exec: host(ssh).exec,
            serverStartDelayMs: 1,
            serverStartRetries: 5,
          }),
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
    host,
    async close() {
      await runner.close();
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Remote agent.prompt handler that plays a compliant agent on the fake host. */
function remoteWritesResult(value: unknown, status = "done") {
  return (_args: string[], machine: FakeRemoteMachine): { status: string } => {
    const out = machine.lastTabEnv?.HERDR_FLOW_OUT;
    assert.ok(out, "tab create must inject HERDR_FLOW_OUT before the prompt");
    machine.files.set(out, JSON.stringify({ ok: true, result: value }));
    return { status };
  };
}

/** Local (mock-socket) agent.prompt handler that writes the output file. */
function localWritesResult(value: unknown) {
  return async (params: { target?: unknown } | undefined, server: MockHerdrServer) => {
    const env = server.lastTabEnv;
    assert.ok(env?.HERDR_FLOW_OUT);
    await writeFile(env.HERDR_FLOW_OUT, JSON.stringify({ ok: true, result: value }));
    return { type: "agent_prompted", agent: server.makeAgentInfo(params?.target, "done") };
  };
}

// ─── ssh placement: the full flow over ssh ────────────────────────────────────

test("ssh:'build-mac' runs the whole D11 topology over ssh and harvests the remote output file", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.onPrompt = remoteWritesResult("remote answer");
  try {
    const result = await harness.runner.run("do it over there", {
      label: "remote-worker",
      ssh: "build-mac",
      sessionName: "workflow:rrun remote-worker",
    });
    assert.equal(result, "remote answer");

    // The local socket saw NOTHING: the ssh option routed everything over ssh.
    assert.equal(harness.server.calls.length, 0, "an ssh call must not touch the local session");

    // Topology over the CLI: workspace create -> tab create -> agent start ->
    // agent get (readiness) -> agent prompt --wait -> tab close.
    assert.equal(mac.cliCallsFor("workspace", "create").length, 1);
    const tabCreate = mac.cliCallsFor("tab", "create")[0]!;
    assert.ok(tabCreate.args.includes("--no-focus"));
    assert.equal(tabCreate.args[tabCreate.args.indexOf("--label") + 1], "remote-worker");
    assert.ok(
      !tabCreate.args.includes("--cwd"),
      `an ssh tab opens in the remote HOME — the local cwd names a directory on the wrong host; got: ${tabCreate.args.join(" ")}`,
    );
    assert.equal(mac.cliCallsFor("agent", "start").length, 1);
    const promptArgs = mac.cliCallsFor("agent", "prompt")[0]!.args;
    assert.ok(promptArgs.includes("--wait"));
    assert.deepEqual(
      [promptArgs[promptArgs.indexOf("--until") + 1], "done", "blocked"].sort(),
      ["blocked", "done", "idle"].sort(),
    );
    assert.equal(mac.cliCallsFor("tab", "close").length, 1, "the remote tab is torn down in the finally");

    // The output contract lives on the REMOTE filesystem.
    const env = mac.lastTabEnv!;
    assert.ok(String(env.HERDR_FLOW_OUT).startsWith("/tmp/herdr-flow/rrun/"), `remote out path, got ${env.HERDR_FLOW_OUT}`);
    assert.equal(env.HERDR_FLOW_RUN, "rrun");
    assert.ok(mac.dirs.has("/tmp/herdr-flow/rrun"), "the remote out dir was mkdir -p'ed over ssh");

    await harness.runner.close();
    assert.equal(mac.cliCallsFor("workspace", "close").length, 1, "close() tears down the remote workspace");
    assert.ok(mac.controlExits >= 1, "close() releases the ssh ControlMaster");
  } finally {
    await harness.close();
  }
});

test("any ssh host name is a destination; herdr is found with a login-shell probe and the local socket is untouched", async () => {
  const harness = await startHarness();
  const box = harness.host("daxzy-mac");
  box.onPrompt = remoteWritesResult("found herdr");
  try {
    assert.equal(await harness.runner.run("go", { label: "w", ssh: "daxzy-mac" }), "found herdr");
    assert.ok(
      box.execs.some((exec) => String(exec.argv[exec.argv.length - 1] ?? "").includes("command -v herdr")),
      "an ssh destination probes herdr via a login shell (there is no inventory to read a path from)",
    );
    assert.equal(box.cliCallsFor("tab", "create").length, 1);
    assert.equal(harness.server.calls.length, 0, "must not fall back to the local socket");
  } finally {
    await harness.close();
  }
});

test("omitting ssh keeps the call on the local socket; the two destinations get their own transports", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.onPrompt = remoteWritesResult("ran remote");
  harness.server.on("agent.prompt", localWritesResult("ran local"));
  try {
    assert.equal(await harness.runner.run("here", { label: "a" }), "ran local");
    assert.equal(await harness.runner.run("there", { label: "b", ssh: "build-mac" }), "ran remote");
    assert.equal(harness.server.callsFor("tab.create").length, 1, "exactly one call on the local socket");
    assert.equal(mac.cliCallsFor("tab", "create").length, 1, "exactly one call over ssh");
    assert.equal(
      harness.server.callsFor("workspace.create").length,
      1,
      "one run workspace per destination (SPEC D11)",
    );
    assert.equal(mac.cliCallsFor("workspace", "create").length, 1);
  } finally {
    await harness.close();
  }
});

test("two calls on the SAME ssh host share one transport and one workspace", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.onPrompt = remoteWritesResult("ok");
  try {
    assert.equal(await harness.runner.run("one", { label: "a", ssh: "build-mac" }), "ok");
    assert.equal(await harness.runner.run("two", { label: "b", ssh: "build-mac" }), "ok");
    assert.equal(mac.cliCallsFor("tab", "create").length, 2);
    assert.equal(mac.cliCallsFor("workspace", "create").length, 1, "the run's workspace is created once per host");
  } finally {
    await harness.close();
  }
});

test("a call with a schema writes the schema file on the ssh HOST and validates the harvested result", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.onPrompt = remoteWritesResult({ verdict: "ship", confidence: 3 });
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" }, confidence: { type: "number" } },
    required: ["verdict"],
  };
  try {
    const result = await harness.runner.run("judge", {
      label: "judge",
      ssh: "build-mac",
      schema,
      sessionName: "workflow:rschema judge",
    });
    assert.deepEqual(result, { verdict: "ship", confidence: 3 });
    const env = mac.lastTabEnv!;
    assert.ok(env.HERDR_FLOW_SCHEMA!.startsWith("/tmp/herdr-flow/rschema/"), "schema path is remote");
    const written = mac.files.get(env.HERDR_FLOW_SCHEMA!);
    assert.ok(written, "the schema file was written over ssh (stdin cat)");
    assert.deepEqual(JSON.parse(written!), schema);
  } finally {
    await harness.close();
  }
});

test("remote harvest fallback: no output file and no schema falls back to agent read's raw pane text", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.paneText = "the visible answer\n";
  // Default onPrompt writes nothing; agent settles "done".
  try {
    const result = await harness.runner.run("talk to the screen", { label: "w", ssh: "build-mac" });
    assert.equal(result, "the visible answer");
    assert.equal(mac.cliCallsFor("agent", "read").length, 1);
  } finally {
    await harness.close();
  }
});

test("the kind's permission flags travel over ssh too", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  mac.onPrompt = remoteWritesResult("ok");
  try {
    await harness.runner.run("go", { label: "w", ssh: "build-mac", kind: "codex", model: "gpt-5" });
    const start = mac.cliCallsFor("agent", "start")[0]!.args;
    const argsAt = start.indexOf("--");
    assert.ok(argsAt >= 0, `agent start must forward launch args after --; got: ${start.join(" ")}`);
    assert.deepEqual(start.slice(argsAt + 1), [
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--model",
      "gpt-5",
    ]);
  } finally {
    await harness.close();
  }
});

// ─── Validation (SPEC D13) ────────────────────────────────────────────────────

test("an empty or whitespace ssh option is a validation error, never a silent fallback to local", async () => {
  const harness = await startHarness();
  try {
    for (const ssh of ["", "   "]) {
      await assert.rejects(harness.runner.run("go", { label: "w", ssh }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /is not a host name/);
        return true;
      });
    }
    assert.equal(harness.server.calls.length, 0, "rejected before touching the local socket");
  } finally {
    await harness.close();
  }
});

test("worktree isolation (call-site cwd) combined with ssh is an explicit validation error, never a silent degrade", async () => {
  const harness = await startHarness();
  try {
    await assert.rejects(
      harness.runner.run("isolated", { label: "w", ssh: "build-mac", cwd: "/tmp/worktrees/wt-1" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /worktree isolation .* not supported over ssh/i);
        return true;
      },
    );
    assert.equal(harness.host("build-mac").execs.length, 0, "rejected before any ssh traffic");

    // Without ssh the same call runs locally, honoring the worktree cwd.
    harness.server.on("agent.prompt", localWritesResult("isolated locally"));
    assert.equal(await harness.runner.run("isolated", { label: "w", cwd: "/tmp/worktrees/wt-1" }), "isolated locally");
    const tabCreate = harness.server.callsFor("tab.create")[0]!;
    assert.equal(tabCreate.params.cwd, "/tmp/worktrees/wt-1", "the worktree cwd is honored locally");
  } finally {
    await harness.close();
  }
});

// ─── ssh escalation (SPEC D15/D16) ───────────────────────────────────────────

test("escalate on an ssh host: pane left open, ssh attach command, remote workspace preserved by close()", async () => {
  const harness = await startHarness({ onBlocked: "escalate" });
  const mac = harness.host("build-mac");
  mac.onPrompt = () => ({ status: "blocked" });
  const histories: Array<Record<string, unknown>> = [];
  try {
    await assert.rejects(
      harness.runner.run("needs approval", {
        label: "worker",
        ssh: "build-mac",
        sessionName: "workflow:resc worker",
        onHistory: (entries) => histories.push(...entries),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, HERDR_BLOCKED);
        const details = error.details as Record<string, unknown>;
        assert.equal(details.paneClosed, false);
        assert.equal(details.ssh, "build-mac");
        assert.equal(
          details.attachCommand,
          `ssh -t build-mac 'bash -lc '\\''herdr --session flow agent attach flow-resc-0'\\'''`,
          "the attach command is runnable from the engine's host, through a login shell so herdr is on PATH (D16)",
        );
        return true;
      },
    );
    assert.equal(mac.cliCallsFor("tab", "close").length, 0, "the blocked remote tab is left OPEN");
    const record = histories.find((entry) => entry.code === "agent_blocked_escalated");
    assert.ok(record);
    assert.equal(record.ssh, "build-mac");

    await harness.runner.close();
    assert.equal(
      mac.cliCallsFor("workspace", "close").length,
      0,
      "close() preserves the remote workspace holding the escalated pane",
    );
  } finally {
    await harness.close();
  }
});

test("a blocked ssh call under the default fail policy tears the remote tab down", async () => {
  const harness = await startHarness();
  const mac = harness.host("build-mac");
  let calls = 0;
  mac.onPrompt = (_args, machine) => {
    calls++;
    if (calls === 1) return { status: "blocked" };
    machine.files.set(machine.lastTabEnv!.HERDR_FLOW_OUT!, JSON.stringify({ ok: true, result: "second ok" }));
    return { status: "done" };
  };
  try {
    await assert.rejects(
      harness.runner.run("one", { label: "a", ssh: "build-mac" }),
      (error: unknown) => error instanceof HerdrWorkflowError && error.herdrCode === HERDR_BLOCKED,
    );
    assert.equal(mac.cliCallsFor("tab", "close").length, 1, "fail tears the blocked remote tab down");
    assert.equal(await harness.runner.run("two", { label: "b", ssh: "build-mac" }), "second ok");
  } finally {
    await harness.close();
  }
});
