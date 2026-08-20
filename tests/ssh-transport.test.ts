/**
 * SshHerdrTransport (SPEC D13): the herdr-CLI-over-ssh transport in isolation,
 * with the ssh exec faked. Covers the method->CLI argv mapping (flags verified
 * against herdr 0.8.0), single-quote shell escaping, the env -u hygiene rule,
 * ControlMaster reuse options, frame parsing (stdout results, stderr error
 * frames, the raw agent read / agent explain outputs), the session-server
 * bootstrap (probe -> nohup start -> backoff re-probe), and the remote file
 * operations (cat / mkdir -p / stdin write).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HerdrRequestTimeoutError, HerdrRpcError, HerdrTransportError } from "../src/runner/socket.js";
import {
  buildHerdrCliArgs,
  shellQuote,
  SshHerdrTransport,
  type SshExecRequest,
  type SshExecResult,
} from "../src/runner/ssh-transport.js";
import { FakeRemoteMachine, tokenizeShell } from "./fake-ssh.js";

const BIN = "/opt/homebrew/bin/herdr";

function makeTransport(machine: FakeRemoteMachine, overrides: Record<string, unknown> = {}): SshHerdrTransport {
  return new SshHerdrTransport({
    target: "build-mac",
    herdrBin: BIN,
    session: "flow",
    machineName: "build-mac",
    exec: machine.exec,
    serverStartDelayMs: 1,
    serverStartRetries: 5,
    ...overrides,
  });
}

// ─── CLI argv mapping ─────────────────────────────────────────────────────────

test("buildHerdrCliArgs maps every runner operation onto the verified CLI flags", () => {
  assert.deepEqual(buildHerdrCliArgs("workspace.list", {}), ["workspace", "list"]);
  assert.deepEqual(buildHerdrCliArgs("workspace.create", { label: "flow/r1", focus: false }), [
    "workspace",
    "create",
    "--label",
    "flow/r1",
    "--no-focus",
  ]);
  assert.deepEqual(buildHerdrCliArgs("workspace.close", { workspace_id: "w1" }), ["workspace", "close", "w1"]);
  assert.deepEqual(
    buildHerdrCliArgs("tab.create", {
      workspace_id: "w1",
      cwd: "/Users/alex/repo",
      label: "impl:parser",
      focus: false,
      env: { HERDR_FLOW_OUT: "/tmp/herdr-flow/r1/0.json", HERDR_FLOW_CALL: "0" },
    }),
    [
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/Users/alex/repo",
      "--label",
      "impl:parser",
      "--no-focus",
      "--env",
      "HERDR_FLOW_OUT=/tmp/herdr-flow/r1/0.json",
      "--env",
      "HERDR_FLOW_CALL=0",
    ],
  );
  assert.deepEqual(buildHerdrCliArgs("tab.close", { tab_id: "w1:t2" }), ["tab", "close", "w1:t2"]);
  assert.deepEqual(buildHerdrCliArgs("pane.list", {}), ["pane", "list"]);
  assert.deepEqual(buildHerdrCliArgs("pane.list", { workspace_id: "w1" }), ["pane", "list", "--workspace", "w1"]);
  assert.deepEqual(buildHerdrCliArgs("pane.close", { pane_id: "w1:p2" }), ["pane", "close", "w1:p2"]);
  assert.deepEqual(
    buildHerdrCliArgs("agent.start", {
      name: "flow-r1-0",
      kind: "claude",
      pane_id: "w1:p2",
      args: ["--model", "opus", "--dangerously-skip-permissions"],
      timeout_ms: 60000,
    }),
    // `herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]`
    ["agent", "start", "flow-r1-0", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000", "--", "--model", "opus", "--dangerously-skip-permissions"],
  );
  assert.deepEqual(
    buildHerdrCliArgs("agent.start", { name: "a", kind: "codex", pane_id: "p", timeout_ms: 5000 }),
    ["agent", "start", "a", "--kind", "codex", "--pane", "p", "--timeout", "5000"],
    "no agent args: no trailing --",
  );
  assert.deepEqual(
    buildHerdrCliArgs("agent.prompt", {
      target: "flow-r1-0",
      text: "do the thing",
      wait: { until: ["idle", "done", "blocked"], timeout_ms: 900000 },
    }),
    // `herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]`
    ["agent", "prompt", "flow-r1-0", "do the thing", "--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "900000"],
  );
  assert.deepEqual(
    buildHerdrCliArgs("agent.wait", { target: "a", until: ["idle", "done", "blocked"], timeout_ms: 1000 }),
    ["agent", "wait", "a", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "1000"],
  );
  assert.deepEqual(buildHerdrCliArgs("agent.get", { target: "a" }), ["agent", "get", "a"]);
  assert.deepEqual(buildHerdrCliArgs("agent.explain", { target: "a" }), ["agent", "explain", "a", "--json"]);
  assert.deepEqual(
    buildHerdrCliArgs("agent.read", { target: "a", source: "visible", format: "text", strip_ansi: true }),
    ["agent", "read", "a", "--source", "visible", "--format", "text"],
  );
  assert.deepEqual(buildHerdrCliArgs("agent.send_keys", { target: "a", keys: ["esc", "ctrl+c"] }), [
    "agent",
    "send-keys",
    "a",
    "esc",
    "ctrl+c",
  ]);
  assert.throws(() => buildHerdrCliArgs("events.subscribe", {}), HerdrTransportError, "unmapped methods are loud");
  assert.throws(() => buildHerdrCliArgs("tab.close", {}), HerdrTransportError, "missing required params are loud");
});

// ─── Shell escaping and command hygiene ───────────────────────────────────────

test("shellQuote survives single quotes, newlines, $ and backticks", () => {
  const nasty = `it's a "test"\nwith $VAR and \`cmd\` and 'quotes'`;
  assert.equal(tokenizeShell(`x ${shellQuote(nasty)} y`)[1], nasty);
});

test("remote command: absolute herdr_bin, --session, env -u hygiene, and full quoting of the prompt", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  const prompt = `line one\nline 'two' with "$HOME" & stuff`;
  await transport.request("agent.prompt", { target: "a", text: prompt, wait: { until: ["done"], timeout_ms: 5 } });

  const call = machine.cliCallsFor("agent", "prompt")[0]!;
  assert.equal(call.args[2], "a");
  assert.equal(call.args[3], prompt, "the prompt round-trips through shell quoting intact");
  const tokens = tokenizeShell(call.raw);
  assert.deepEqual(
    tokens.slice(0, 5),
    ["env", "-u", "HERDR_SOCKET_PATH", "-u", "HERDR_CLIENT_SOCKET_PATH"],
    "HERDR_*_SOCKET_PATH are always unset for the remote herdr (reference §7)",
  );
  assert.equal(tokens[5], BIN, "the machine's declared absolute herdr_bin, never PATH (D13)");
  assert.deepEqual(tokens.slice(6, 8), ["--session", "flow"]);
  await transport.close();
});

test("ssh argv carries BatchMode and ControlMaster reuse options", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine, { controlDir: "/tmp/ctl", controlPersistSeconds: 60 });
  await transport.request("agent.get", { target: "a" });
  const argv = machine.execs[0]!.argv;
  const options: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "-o") options.push(argv[i + 1]!);
  assert.ok(options.includes("BatchMode=yes"));
  assert.ok(options.includes("ControlMaster=auto"));
  assert.ok(options.includes("ControlPersist=60"));
  assert.ok(options.some((option) => option.startsWith("ControlPath=/tmp/ctl/")), "ControlPath under the configured dir");
  assert.equal(argv[argv.length - 2], "build-mac", "the target precedes the remote command");
  await transport.close();
});

test("close() asks the ControlMaster to exit so no ssh outlives the run", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  await transport.request("agent.get", { target: "a" });
  await transport.close();
  assert.equal(machine.controlExits, 1);
  await assert.rejects(transport.request("agent.get", { target: "a" }), HerdrTransportError);
});

// ─── Frame parsing ────────────────────────────────────────────────────────────

test("success frames yield the socket-identical result; error frames become HerdrRpcError with the code verbatim", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  const created = (await transport.request("workspace.create", { label: "flow/r1", focus: false })) as {
    type: string;
    workspace: { workspace_id: string };
  };
  assert.equal(created.type, "workspace_created");
  assert.equal(created.workspace.workspace_id, "w1");

  const failing: SshExecRequest[] = [];
  const rpcFail = makeTransport(machine, {
    exec: async (request: SshExecRequest): Promise<SshExecResult> => {
      failing.push(request);
      if (tokenizeShell(String(request.argv[request.argv.length - 1])).includes("start")) {
        return {
          code: 1,
          stdout: "",
          stderr: `${JSON.stringify({ id: "cli:agent:start", error: { code: "agent_pane_busy", message: "target pane is not an available shell" } })}\n`,
        };
      }
      return machine.exec(request);
    },
  });
  await assert.rejects(
    rpcFail.request("agent.start", { name: "a", kind: "claude", pane_id: "p" }),
    (error: unknown) => {
      assert.ok(error instanceof HerdrRpcError);
      assert.equal(error.code, "agent_pane_busy", "Herdr codes survive the CLI round trip verbatim");
      return true;
    },
  );
  await transport.close();
  await rpcFail.close();
});

test("agent.read wraps the CLI's raw pane text back into {read:{text}}; agent.explain wraps the raw JSON into {explain}", async () => {
  const machine = new FakeRemoteMachine();
  machine.paneText = "visible pane text\nsecond line";
  const transport = makeTransport(machine);
  const read = (await transport.request("agent.read", { target: "a", source: "visible", format: "text", strip_ansi: true })) as {
    read: { text: string };
  };
  assert.equal(read.read.text, "visible pane text\nsecond line");
  const explain = (await transport.request("agent.explain", { target: "a" })) as { explain: { agent: string } };
  assert.equal(explain.explain.agent, "claude", "explain JSON is parsed and rewrapped in the socket shape");
  await transport.close();
});

test("a non-zero exit with no error frame (ssh-level failure) is a transport error carrying the output", async () => {
  const transport = makeTransport(new FakeRemoteMachine(), {
    exec: async (): Promise<SshExecResult> => ({ code: 255, stdout: "", stderr: "ssh: connect to host build-mac port 22: Connection refused" }),
  });
  await assert.rejects(transport.request("agent.get", { target: "a" }), (error: unknown) => {
    assert.ok(error instanceof HerdrTransportError);
    assert.match(error.message, /Connection refused/);
    return true;
  });
});

test("an exec timeout surfaces as the TimeoutError-named HerdrRequestTimeoutError (AGENT_TIMEOUT classification)", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine, {
    exec: async (request: SshExecRequest): Promise<SshExecResult> => {
      const command = String(request.argv[request.argv.length - 1]);
      if (tokenizeShell(command).includes("prompt")) return { code: null, stdout: "", stderr: "", timedOut: true };
      return machine.exec(request);
    },
  });
  await assert.rejects(
    transport.request("agent.prompt", { target: "a", text: "x", wait: { until: ["done"], timeout_ms: 10 } }, { timeoutMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof HerdrRequestTimeoutError);
      assert.equal(error.name, "TimeoutError");
      return true;
    },
  );
});

// ─── Session-server bootstrap ─────────────────────────────────────────────────

test("first request probes the session server; when it is not running it is started headless (nohup ... server ... &) and re-probed", async () => {
  const machine = new FakeRemoteMachine({ serverRunning: false });
  const transport = makeTransport(machine);
  const result = (await transport.request("agent.get", { target: "a" })) as { type: string };
  assert.equal(result.type, "agent_info");

  // Probe (fails server_not_running) -> start -> probe again -> real request.
  const probe = machine.cliCallsFor("workspace", "list");
  assert.ok(probe.length >= 2, "a cheap workspace list probe runs before and after the start");
  const start = machine.execs.find((exec) => /\bnohup\b/.test(String(exec.argv[exec.argv.length - 1])));
  assert.ok(start, "the server is started with nohup");
  const startCommand = String(start!.argv[start!.argv.length - 1]);
  assert.match(startCommand, new RegExp(`'${BIN}' --session 'flow' server`), "absolute bin + session name");
  assert.match(startCommand, />\/dev\/null 2>&1 &$/, "fully detached so the ssh channel closes immediately");
  assert.match(startCommand, /env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH/, "env hygiene on the server too");
  await transport.close();
});

test("the readiness re-probe backs off through server_not_running until the server is up", async () => {
  const machine = new FakeRemoteMachine({ serverRunning: false });
  const transport = makeTransport(machine);
  // After the nohup start flips serverRunning, still fail 3 probes (slow start).
  const originalExec = machine.exec;
  const exec = async (request: SshExecRequest): Promise<SshExecResult> => {
    const command = String(request.argv[request.argv.length - 1]);
    if (/\bnohup\b/.test(command)) {
      machine.startupProbeFailures = 3;
    }
    return originalExec(request);
  };
  const slow = makeTransport(machine, { exec });
  const result = (await slow.request("workspace.create", { label: "x", focus: false })) as { type: string };
  assert.equal(result.type, "workspace_created");
  assert.ok(machine.cliCallsFor("workspace", "list").length >= 4, "kept probing until the server answered");
  await transport.close();
});

test("session readiness is memoized: later requests skip the probe", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  await transport.request("agent.get", { target: "a" });
  await transport.request("agent.get", { target: "a" });
  assert.equal(machine.cliCallsFor("workspace", "list").length, 1, "exactly one probe for many requests");
  await transport.close();
});

test("bootstrap ignores per-call abort signals: one caller's timeout/abort must not fail concurrent siblings", async () => {
  // The session-server bootstrap is memoized and shared by every concurrent
  // request on the machine. It must run WITHOUT the first caller's signal
  // (like the runner's ensureWorkspace): otherwise call A aborting mid-boot
  // rejects the shared promise with an "aborted" error, sibling B fails too,
  // and the engine misclassifies B as WORKFLOW_ABORTED.
  const machine = new FakeRemoteMachine();
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
  let probes = 0;
  const transport = makeTransport(machine, {
    exec: async (request: SshExecRequest): Promise<SshExecResult> => {
      const command = String(request.argv[request.argv.length - 1]);
      if (tokenizeShell(command).includes("list") && probes++ === 0) await probeGate; // slow bootstrap probe
      return machine.exec(request);
    },
  });
  const controllerA = new AbortController();
  const callA = transport.request("agent.get", { target: "a" }, { signal: controllerA.signal });
  const callB = transport.request("agent.get", { target: "b" });
  callA.catch(() => {}); // A is expected to fail once ITS OWN signal is checked
  controllerA.abort(); // per-call timeout fires while the shared bootstrap is in flight
  releaseProbe();
  const resultB = (await callB) as { type: string };
  assert.equal(resultB.type, "agent_info", "the sibling call must survive A's abort");
  await assert.rejects(callA, /abort/i, "A itself still fails on its own signal");
  await transport.close();
});

test("agent.start's CLI-side exit-2 'unsupported interactive agent kind' keeps the server's error code over ssh", async () => {
  // The herdr CLI validates --kind client-side and exits 2 with plain text —
  // no error frame (src/cli/agent.rs). The transport must re-synthesize the
  // server's own code so the runner classifies it as the same non-recoverable
  // SCRIPT_VALIDATION_ERROR the local socket path produces, instead of a
  // generic recoverable transport error that gets retried.
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine, {
    exec: async (request: SshExecRequest): Promise<SshExecResult> => {
      const command = String(request.argv[request.argv.length - 1]);
      if (tokenizeShell(command).includes("start")) {
        return { code: 2, stdout: "", stderr: "unsupported interactive agent kind: clanker\n" };
      }
      return machine.exec(request);
    },
  });
  await assert.rejects(
    transport.request("agent.start", { name: "a", kind: "clanker", pane_id: "p" }),
    (error: unknown) => {
      assert.ok(error instanceof HerdrRpcError);
      assert.equal(error.code, "unsupported_agent_kind", "one error taxonomy across both transports");
      return true;
    },
  );
  await transport.close();
});

test("a prompt that would exceed the remote per-argument exec limit fails deterministically, before any ssh attempt", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  const huge = "x".repeat(150_000); // > 128 KiB MAX_ARG_STRLEN
  await assert.rejects(
    transport.request("agent.prompt", { target: "a", text: huge, wait: { until: ["done"], timeout_ms: 5 } }),
    (error: unknown) => {
      assert.ok(error instanceof HerdrRpcError);
      assert.equal(error.code, "remote_command_too_large");
      assert.match(error.message, /128 KiB/);
      return true;
    },
  );
  assert.equal(machine.cliCallsFor("agent", "prompt").length, 0, "the oversized command never went over the wire");
  await transport.close();
});

test("a failed bootstrap resets the memo so a later request retries", async () => {
  const machine = new FakeRemoteMachine();
  let refuse = true;
  const transport = makeTransport(machine, {
    exec: async (request: SshExecRequest): Promise<SshExecResult> => {
      if (refuse) return { code: 255, stdout: "", stderr: "ssh: Connection refused" };
      return machine.exec(request);
    },
  });
  await assert.rejects(transport.request("agent.get", { target: "a" }), HerdrTransportError);
  refuse = false;
  const result = (await transport.request("agent.get", { target: "a" })) as { type: string };
  assert.equal(result.type, "agent_info", "the machine coming back up heals the transport");
  await transport.close();
});

// ─── Remote file operations ───────────────────────────────────────────────────

test("readTextFile is `cat` over ssh (undefined when missing); writeTextFile is mkdir -p + stdin cat; ensureDir is mkdir -p", async () => {
  const machine = new FakeRemoteMachine();
  const transport = makeTransport(machine);
  assert.equal(await transport.readTextFile("/tmp/herdr-flow/r1/0.json"), undefined, "missing file reads as undefined");

  const content = `{"ok":true,"result":"it's done"}`;
  await transport.writeTextFile("/tmp/herdr-flow/r1/0.schema.json", content);
  assert.equal(machine.files.get("/tmp/herdr-flow/r1/0.schema.json"), content, "content travels via stdin, quoting-proof");
  assert.ok(machine.dirs.has("/tmp/herdr-flow/r1"), "parent dir created");

  assert.equal(await transport.readTextFile("/tmp/herdr-flow/r1/0.schema.json"), content);

  await transport.ensureDir("/tmp/herdr-flow/r2");
  assert.ok(machine.dirs.has("/tmp/herdr-flow/r2"));
  await transport.close();
});

// ─── Constructor validation ───────────────────────────────────────────────────

test("herdr_bin must be absolute (D13) and target/session non-empty", () => {
  assert.throws(() => new SshHerdrTransport({ target: "host", herdrBin: "herdr", session: "s" }), /ABSOLUTE/);
  assert.throws(() => new SshHerdrTransport({ target: " ", herdrBin: BIN, session: "s" }), /target/);
  assert.throws(() => new SshHerdrTransport({ target: "host", herdrBin: BIN, session: "" }), /session/);
});
