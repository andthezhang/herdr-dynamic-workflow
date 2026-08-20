/**
 * HerdrAgentRunner remote placement (SPEC D12/D13, M3): agent calls placed on
 * remote fleet machines run the full D11 topology through SshHerdrTransport
 * against a faked ssh, while local calls keep using the socket. Covers the
 * placement rules (implicit least-occupancy, exact name, {tag}, kind
 * filtering, strict validation), per-machine slot enforcement (atomic
 * check+increment, release in finally, escalate holds), the remote
 * output-file contract (remote HERDR_FLOW_* paths, ssh-cat harvest, remote
 * schema write, repo-derived cwd), and remote escalation (ssh attach command,
 * workspace preserved).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { parseFleetToml } from "../src/fleet/config.js";
import { HERDR_BLOCKED, HerdrAgentRunner, HerdrWorkflowError } from "../src/runner/herdr-runner.js";
import { SshHerdrTransport } from "../src/runner/ssh-transport.js";
import { LocalHerdrTransport } from "../src/runner/transport.js";
import { FakeRemoteMachine } from "./fake-ssh.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

const FLEET_TOML = `
[defaults]
kind = "claude"

[[machine]]
name = "local"
slots = 2

[[machine]]
name = "build-mac"
transport = "build-mac"
herdr_bin = "/opt/homebrew/bin/herdr"
slots = 2
tags = ["mac", "remote"]
kinds = ["claude", "codex"]
repos = ["/Users/alex/repos/herdr-dynamic-workflow", "/Users/alex/repos/other"]

[[machine]]
name = "linux-box"
transport = "ssh://alex@linux-box"
herdr_bin = "/usr/local/bin/herdr"
slots = 1
tags = ["remote"]
kinds = ["codex"]
`;

interface Harness {
  server: MockHerdrServer;
  runner: HerdrAgentRunner;
  stateDir: string;
  /** The faked remote host per machine name (created on demand). */
  machine(name: string): FakeRemoteMachine;
  close(): Promise<void>;
}

async function startHarness(fleetToml: string = FLEET_TOML, runnerOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const server = await MockHerdrServer.start();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-remote-state-"));
  const fakes = new Map<string, FakeRemoteMachine>();
  const machine = (name: string): FakeRemoteMachine => {
    let fake = fakes.get(name);
    if (!fake) {
      fake = new FakeRemoteMachine();
      fakes.set(name, fake);
    }
    return fake;
  };
  const runner = new HerdrAgentRunner({
    socketPath: server.socketPath,
    stateDir,
    defaults: { kind: "claude", cwd: "/Users/alex/Documents/Github/herdr-dynamic-workflow" },
    fleet: parseFleetToml(fleetToml, "test://fleet.toml"),
    session: "flow",
    transportFactory: (config) =>
      config.transport === "local"
        ? new LocalHerdrTransport({ socketPath: server.socketPath, defaultTimeoutMs: 5_000 })
        : new SshHerdrTransport({
            target: config.transport.ssh,
            herdrBin: config.herdrBin!,
            session: "flow",
            machineName: config.name,
            exec: machine(config.name).exec,
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
    machine,
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

// ─── Explicit remote placement: the full flow over ssh ────────────────────────

test("machine:'build-mac' runs the whole D11 topology over ssh and harvests the remote output file", async () => {
  const harness = await startHarness();
  const mac = harness.machine("build-mac");
  mac.onPrompt = remoteWritesResult("remote answer");
  try {
    const result = await harness.runner.run("do it over there", {
      label: "remote-worker",
      machine: "build-mac",
      sessionName: "workflow:rrun remote-worker",
    });
    assert.equal(result, "remote answer");

    // The local socket saw NOTHING: placement routed everything over ssh.
    assert.equal(harness.server.calls.length, 0, "a remote call must not touch the local session");

    // Topology over the CLI: workspace create -> tab create -> agent start ->
    // agent get (readiness) -> agent prompt --wait -> tab close.
    assert.equal(mac.cliCallsFor("workspace", "create").length, 1);
    const tabCreate = mac.cliCallsFor("tab", "create")[0]!;
    assert.ok(tabCreate.args.includes("--no-focus"));
    assert.equal(tabCreate.args[tabCreate.args.indexOf("--label") + 1], "remote-worker");
    assert.equal(
      tabCreate.args[tabCreate.args.indexOf("--cwd") + 1],
      "/Users/alex/repos/herdr-dynamic-workflow",
      "remote cwd is the machine's declared repo (basename-matched against the workflow's cwd), never the local path",
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

test("a remote call with a schema writes the schema file on the REMOTE machine and validates the harvested result", async () => {
  const harness = await startHarness();
  const mac = harness.machine("build-mac");
  mac.onPrompt = remoteWritesResult({ verdict: "ship", confidence: 3 });
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" }, confidence: { type: "number" } },
    required: ["verdict"],
  };
  try {
    const result = await harness.runner.run("judge", {
      label: "judge",
      machine: "build-mac",
      schema,
      sessionName: "workflow:rschema judge",
    });
    assert.deepEqual(result, { verdict: "ship", confidence: 3 });
    const env = harness.machine("build-mac").lastTabEnv!;
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
  const mac = harness.machine("build-mac");
  mac.paneText = "the visible answer\n";
  // Default onPrompt writes nothing; agent settles "done".
  try {
    const result = await harness.runner.run("talk to the screen", { label: "w", machine: "build-mac" });
    assert.equal(result, "the visible answer");
    assert.equal(mac.cliCallsFor("agent", "read").length, 1);
  } finally {
    await harness.close();
  }
});

test("a machine with no declared repos opens the remote tab in HOME (no --cwd), never the engine's local cwd", async () => {
  const harness = await startHarness();
  const linux = harness.machine("linux-box");
  linux.onPrompt = remoteWritesResult("from home");
  try {
    const result = await harness.runner.run("task", { label: "w", machine: "linux-box", kind: "codex" });
    assert.equal(result, "from home");
    const tabCreate = linux.cliCallsFor("tab", "create")[0]!;
    assert.ok(!tabCreate.args.includes("--cwd"), `no --cwd for a repo-less machine; got: ${tabCreate.args.join(" ")}`);
  } finally {
    await harness.close();
  }
});

// ─── Placement rules (SPEC D12 + Q3 minimal) ──────────────────────────────────

test("implicit placement picks the machine of least current occupancy among kind-eligible machines", async () => {
  const harness = await startHarness();
  const mac = harness.machine("build-mac");
  let releaseLocal!: () => void;
  const localGate = new Promise<void>((resolve) => (releaseLocal = resolve));
  harness.server.on("agent.prompt", async (params, server) => {
    await localGate;
    const env = server.lastTabEnv!;
    await writeFile(String(env.HERDR_FLOW_OUT), JSON.stringify({ ok: true, result: "ran local" }));
    return { type: "agent_prompted", agent: server.makeAgentInfo((params as { target?: unknown })?.target, "done") };
  });
  mac.onPrompt = remoteWritesResult("ran remote");
  try {
    // Both calls start before either finishes: the first ties 0-0 and takes
    // "local" (fleet declaration order); the second sees local at 1 vs
    // build-mac at 0 and goes remote.
    const first = harness.runner.run("call one", { label: "a" });
    const second = harness.runner.run("call two", { label: "b" });
    const secondResult = await second;
    releaseLocal();
    const firstResult = await first;
    assert.equal(firstResult, "ran local");
    assert.equal(secondResult, "ran remote");
    assert.equal(harness.server.callsFor("tab.create").length, 1, "one call placed on the local socket");
    assert.equal(mac.cliCallsFor("tab", "create").length, 1, "one call placed over ssh");
  } finally {
    releaseLocal();
    await harness.close();
  }
});

test("{tag} places on a machine carrying the tag; an unconfigured tag or machine is SCRIPT_VALIDATION_ERROR", async () => {
  const harness = await startHarness();
  const mac = harness.machine("build-mac");
  mac.onPrompt = remoteWritesResult("tagged");
  try {
    assert.equal(await harness.runner.run("go", { label: "w", machine: { tag: "mac" } }), "tagged");
    assert.equal(mac.cliCallsFor("tab", "create").length, 1);

    await assert.rejects(harness.runner.run("go", { label: "w", machine: { tag: "gpu" } }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /tag "gpu"/);
      return true;
    });
    await assert.rejects(harness.runner.run("go", { label: "w", machine: "not-a-machine" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /not in the fleet/);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("kind filtering: implicit placement skips machines that do not declare the kind; an explicit mismatch is a validation error", async () => {
  // Local declares only claude here, so a codex call MUST place remotely.
  const fleet = FLEET_TOML.replace('name = "local"\nslots = 2', 'name = "local"\nslots = 2\nkinds = ["claude"]');
  const harness = await startHarness(fleet);
  const mac = harness.machine("build-mac");
  mac.onPrompt = remoteWritesResult("codex ran remote");
  try {
    assert.equal(await harness.runner.run("task", { label: "w", kind: "codex" }), "codex ran remote");
    assert.equal(harness.server.calls.length, 0, "local (claude-only) was never considered for a codex call");

    await assert.rejects(harness.runner.run("task", { label: "w", kind: "claude", machine: "linux-box" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /declares kind "claude"/);
      return true;
    });
  } finally {
    await harness.close();
  }
});

test("repo filtering (D12): a remote machine can only work repos it has — placement filters on the declared repos", async () => {
  // build-mac declares only an unrelated repo; the workflow's cwd basename is
  // "herdr-dynamic-workflow". Explicitly naming it is a validation error
  // (never a silent placement into the wrong checkout), and implicit
  // placement skips it in favor of the unrestricted local machine.
  const fleet = FLEET_TOML.replace(
    'repos = ["/Users/alex/repos/herdr-dynamic-workflow", "/Users/alex/repos/other"]',
    'repos = ["/Users/alex/repos/unrelated-project"]',
  );
  const harness = await startHarness(fleet);
  const mac = harness.machine("build-mac");
  try {
    await assert.rejects(harness.runner.run("go", { label: "w", machine: "build-mac" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /repo matching "herdr-dynamic-workflow"/);
      assert.match(error.message, /unrelated-project/, "the error lists what the machine actually declares");
      return true;
    });
    assert.equal(mac.execs.length, 0, "rejected before any ssh traffic");

    // Implicit placement: the repo-mismatched machine is simply not a candidate.
    harness.server.on("agent.prompt", localWritesResult("stayed local"));
    assert.equal(await harness.runner.run("go", { label: "w" }), "stayed local");
    assert.equal(mac.cliCallsFor("tab", "create").length, 0, "never placed on the machine lacking the repo");

    // A machine with NO declared repos stays unrestricted (mirrors `kinds`).
    const linux = harness.machine("linux-box");
    linux.onPrompt = remoteWritesResult("repo-less ok");
    assert.equal(await harness.runner.run("go", { label: "w", kind: "codex", machine: "linux-box" }), "repo-less ok");
  } finally {
    await harness.close();
  }
});

test("worktree isolation (call-site cwd) with a remote-only placement is an explicit validation error, never a silent degrade", async () => {
  const harness = await startHarness();
  try {
    await assert.rejects(
      harness.runner.run("isolated", { label: "w", machine: "build-mac", cwd: "/tmp/worktrees/wt-1" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /worktree isolation .* not supported on remote machines/i);
        return true;
      },
    );
    assert.equal(harness.machine("build-mac").execs.length, 0, "rejected before any ssh traffic");

    // With an implicit placement the same call lands on the LOCAL machine —
    // isolation restricts candidates instead of erroring when local exists.
    harness.server.on("agent.prompt", localWritesResult("isolated locally"));
    assert.equal(await harness.runner.run("isolated", { label: "w", cwd: "/tmp/worktrees/wt-1" }), "isolated locally");
    const tabCreate = harness.server.callsFor("tab.create")[0]!;
    assert.equal(tabCreate.params.cwd, "/tmp/worktrees/wt-1", "the worktree cwd is honored on the local placement");
  } finally {
    await harness.close();
  }
});

// ─── Slots (SPEC D12/D5): atomic check+increment, release in finally ──────────

test("per-machine slots are enforced: a call beyond capacity parks until a slot releases", async () => {
  const harness = await startHarness(FLEET_TOML.replace('slots = 2\ntags = ["mac", "remote"]', 'slots = 1\ntags = ["mac", "remote"]'));
  const mac = harness.machine("build-mac");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let firstPromptSeen = false;
  mac.onPrompt = async (_args, machine) => {
    if (!firstPromptSeen) {
      firstPromptSeen = true;
      await firstGate;
    }
    const out = machine.lastTabEnv?.HERDR_FLOW_OUT;
    machine.files.set(out!, JSON.stringify({ ok: true, result: "ok" }));
    return { status: "done" };
  };
  try {
    const first = harness.runner.run("one", { label: "a", machine: "build-mac" });
    const second = harness.runner.run("two", { label: "b", machine: "build-mac" });
    // Give the second call every chance to (wrongly) start.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(mac.cliCallsFor("tab", "create").length, 1, "the second call must wait for the single slot");
    releaseFirst();
    assert.equal(await first, "ok");
    assert.equal(await second, "ok");
    assert.equal(mac.cliCallsFor("tab", "create").length, 2, "the parked call ran after the slot released");
    const order = mac.cliCalls.map((call) => call.args.slice(0, 2).join(" "));
    assert.ok(
      order.indexOf("tab close") < order.lastIndexOf("tab create"),
      "the second tab opened only after the first closed (slot released in the finally)",
    );
  } finally {
    releaseFirst();
    await harness.close();
  }
});

test("a failed call releases its slot (the machine is not leaked to capacity)", async () => {
  const harness = await startHarness(FLEET_TOML.replace('slots = 2\ntags = ["mac", "remote"]', 'slots = 1\ntags = ["mac", "remote"]'));
  const mac = harness.machine("build-mac");
  let calls = 0;
  mac.onPrompt = (_args, machine) => {
    calls++;
    if (calls === 1) return { status: "blocked" }; // on_blocked fail -> teardown
    const out = machine.lastTabEnv?.HERDR_FLOW_OUT;
    machine.files.set(out!, JSON.stringify({ ok: true, result: "second ok" }));
    return { status: "done" };
  };
  try {
    await assert.rejects(
      harness.runner.run("one", { label: "a", machine: "build-mac" }),
      (error: unknown) => error instanceof HerdrWorkflowError && error.herdrCode === HERDR_BLOCKED,
    );
    // The slot must be free again: this would hang forever if it leaked.
    assert.equal(await harness.runner.run("two", { label: "b", machine: "build-mac" }), "second ok");
  } finally {
    await harness.close();
  }
});

// ─── Remote escalation (SPEC D15/D16) ────────────────────────────────────────

test("escalate on a remote machine: pane left open, ssh attach command, remote workspace preserved by close(), slot held", async () => {
  const fleet = `${FLEET_TOML}\n`.replace("[defaults]\nkind = \"claude\"", '[defaults]\nkind = "claude"\non_blocked = "escalate"');
  const harness = await startHarness(fleet.replace('slots = 2\ntags = ["mac", "remote"]', 'slots = 1\ntags = ["mac", "remote"]'));
  const mac = harness.machine("build-mac");
  mac.onPrompt = () => ({ status: "blocked" });
  const histories: Array<Record<string, unknown>> = [];
  try {
    await assert.rejects(
      harness.runner.run("needs approval", {
        label: "worker",
        machine: "build-mac",
        sessionName: "workflow:resc worker",
        onHistory: (entries) => histories.push(...entries),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrWorkflowError);
        assert.equal(error.herdrCode, HERDR_BLOCKED);
        const details = error.details as Record<string, unknown>;
        assert.equal(details.paneClosed, false);
        assert.equal(details.machine, "build-mac");
        assert.equal(
          details.attachCommand,
          "ssh -t build-mac '/opt/homebrew/bin/herdr --session flow agent attach flow-resc-0'",
          "the attach command is runnable from the engine's machine (D16: a fleet view is a printed command)",
        );
        return true;
      },
    );
    assert.equal(mac.cliCallsFor("tab", "close").length, 0, "the blocked remote tab is left OPEN");
    const record = histories.find((entry) => entry.code === "agent_blocked_escalated");
    assert.ok(record);
    assert.equal(record.machine, "build-mac");

    // The held slot means a second call on the 1-slot machine must park —
    // D15: escalate does not free capacity. Prove it without hanging the test
    // by checking that no second tab was created within a grace window.
    mac.onPrompt = remoteWritesResult("never runs");
    const parked = harness.runner.run("more work", { label: "parked", machine: "build-mac" });
    let settled = false;
    void parked.catch(() => {}).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(mac.cliCallsFor("tab", "create").length, 1, "the escalated worker still holds the machine's only slot");
    assert.equal(settled, false);

    await harness.runner.close();
    assert.equal(mac.cliCallsFor("workspace", "close").length, 0, "close() preserves the remote workspace holding the escalated pane");
  } finally {
    await harness.close();
  }
});
