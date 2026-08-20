/**
 * FakeRemoteMachine: a scriptable stand-in for `ssh <target> '<command>'`
 * against a remote host running herdr, used by the SshHerdrTransport and
 * remote-runner tests. It implements SshExecFn, parses the single-quoted
 * remote command back into tokens, and emulates exactly what herdr 0.8.0's
 * CLI prints (measured live and verified against herdr src/cli*.rs):
 *
 * - success frames on stdout: `{"id":"cli:<area>:<cmd>","result":{...}}`
 * - error frames on stderr with exit 1: `{"id":"cli:...","error":{...}}`
 * - `agent read`: RAW pane text on stdout (print_read_response — no frame)
 * - `agent explain --json`: RAW explain JSON on stdout (no frame)
 * - `server_not_running` error until a `nohup ... server ... &` command runs
 * - `agent start` blocks CLI-side until the agent is ready, so its frame
 *   already carries an interactive agent
 *
 * Plus the non-herdr commands the transport issues: `cat <path>`,
 * `mkdir -p <dir>`, `mkdir -p <dir> && cat > <path>` (stdin), and the
 * ControlMaster `-O exit` teardown.
 */
import type { SshExecFn, SshExecRequest, SshExecResult } from "../src/runner/ssh-transport.js";

export interface FakeCliCall {
  /** CLI tokens after `<herdr_bin> --session <session>`. */
  args: string[];
  /** The full remote command string as received. */
  raw: string;
}

/** Split a POSIX shell command into tokens, honoring single-quote escaping. */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let inQuote = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (inQuote) {
      if (char === "'") inQuote = false;
      else current += char;
      continue;
    }
    if (char === "'") {
      inQuote = true;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      // Outside quotes a backslash escapes the next character — the `'\''`
      // sequence shellQuote emits for embedded single quotes.
      current += command[++i]!;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export class FakeRemoteMachine {
  /** Every exec request, in arrival order. */
  readonly execs: SshExecRequest[] = [];
  /** Every herdr CLI invocation, in arrival order. */
  readonly cliCalls: FakeCliCall[] = [];
  /** The remote filesystem: path -> content. */
  readonly files = new Map<string, string>();
  /** Directories mkdir -p'ed. */
  readonly dirs = new Set<string>();
  /** tab.create env captures, in order. */
  readonly tabEnvs: Array<Record<string, string>> = [];
  /** True once `... server ... &` ran (or set in the constructor). */
  serverRunning: boolean;
  /** How many server_not_running probes to serve AFTER the server start ran. */
  startupProbeFailures = 0;
  /** Count of `-O exit` teardowns received. */
  controlExits = 0;

  /** Scripted agent.prompt behavior; default settles "done" writing nothing. May be async (gating tests). */
  onPrompt?: (args: string[], machine: FakeRemoteMachine) => { status: string } | void | Promise<{ status: string } | void>;
  /** Scripted agent.get status; default "done" ready. */
  agentStatus = "done";
  /** Raw text `agent read` returns. */
  paneText = "";

  private workspaceCounter = 0;
  private tabCounter = 0;
  private paneCounter = 0;
  /** agent name -> kind, recorded at `agent start`. */
  private readonly agentKinds = new Map<string, string>();

  constructor(options: { serverRunning?: boolean } = {}) {
    this.serverRunning = options.serverRunning ?? true;
  }

  get exec(): SshExecFn {
    return async (request) => this.handle(request);
  }

  cliCallsFor(...prefix: string[]): FakeCliCall[] {
    return this.cliCalls.filter((call) => prefix.every((token, index) => call.args[index] === token));
  }

  get lastTabEnv(): Record<string, string> | undefined {
    return this.tabEnvs[this.tabEnvs.length - 1];
  }

  private async handle(request: SshExecRequest): Promise<SshExecResult> {
    this.execs.push(request);
    // ControlMaster teardown: `ssh ... -O exit <target>` has no remote command.
    if (request.argv.includes("-O")) {
      this.controlExits++;
      return ok("");
    }
    const command = request.argv[request.argv.length - 1] ?? "";

    // Server start: `env -u ... nohup <bin> --session <s> server </dev/null >/dev/null 2>&1 &`
    if (/\bnohup\b/.test(command) && /\bserver\b/.test(command) && command.trimEnd().endsWith("&")) {
      this.serverRunning = true;
      return ok("");
    }
    // Write: `mkdir -p '<dir>' && cat > '<path>'`
    const write = command.match(/^mkdir -p (.+) && cat > (.+)$/);
    if (write) {
      const dir = tokenizeShell(write[1]!)[0]!;
      const file = tokenizeShell(write[2]!)[0]!;
      this.dirs.add(dir);
      this.files.set(file, request.stdin ?? "");
      return ok("");
    }
    // Read: `cat '<path>'`
    const read = command.match(/^cat (.+)$/);
    if (read) {
      const file = tokenizeShell(read[1]!)[0]!;
      const content = this.files.get(file);
      if (content === undefined) return fail(1, `cat: ${file}: No such file or directory`);
      return ok(content);
    }
    // mkdir -p '<dir>'
    const mkdirOnly = command.match(/^mkdir -p (.+)$/);
    if (mkdirOnly) {
      this.dirs.add(tokenizeShell(mkdirOnly[1]!)[0]!);
      return ok("");
    }

    // herdr CLI: `env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH <bin> --session <s> <args...>`
    const tokens = tokenizeShell(command);
    const sessionAt = tokens.indexOf("--session");
    if (tokens[0] === "env" && sessionAt >= 0) {
      const args = tokens.slice(sessionAt + 2);
      this.cliCalls.push({ args, raw: command });
      return this.dispatchCli(args);
    }
    return fail(127, `fake remote machine: unrecognized command: ${command}`);
  }

  private async dispatchCli(args: string[]): Promise<SshExecResult> {
    const id = `cli:${args[0] ?? "?"}:${args[1] ?? "?"}`;
    if (!this.serverRunning) {
      return errFrame(id, "server_not_running", "no herdr server is running at the session socket");
    }
    if (this.startupProbeFailures > 0) {
      this.startupProbeFailures--;
      return errFrame(id, "server_not_running", "the session server is still coming up");
    }
    const area = args[0];
    const cmd = args[1];
    if (area === "workspace" && cmd === "list") {
      return frame(id, { type: "workspace_list", workspaces: [] });
    }
    if (area === "workspace" && cmd === "create") {
      const workspaceId = `w${++this.workspaceCounter}`;
      const tabId = `${workspaceId}:t${++this.tabCounter}`;
      const paneId = `${workspaceId}:p${++this.paneCounter}`;
      return frame(id, {
        type: "workspace_created",
        workspace: { workspace_id: workspaceId, number: this.workspaceCounter, focused: false },
        tab: { tab_id: tabId, workspace_id: workspaceId },
        root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId },
      });
    }
    if (area === "workspace" && cmd === "close") return frame(id, { type: "ok" });
    if (area === "tab" && cmd === "create") {
      const env: Record<string, string> = {};
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === "--env") {
          const [key, ...rest] = args[i + 1]!.split("=");
          env[key!] = rest.join("=");
        }
      }
      this.tabEnvs.push(env);
      const workspaceId = args[args.indexOf("--workspace") + 1] ?? "w1";
      const tabId = `${workspaceId}:t${++this.tabCounter}`;
      const paneId = `${workspaceId}:p${++this.paneCounter}`;
      return frame(id, {
        type: "tab_created",
        tab: { tab_id: tabId, workspace_id: workspaceId },
        root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId },
      });
    }
    if (area === "tab" && cmd === "close") return frame(id, { type: "ok" });
    if (area === "pane" && cmd === "list") return frame(id, { type: "pane_list", panes: [] });
    if (area === "pane" && cmd === "close") return frame(id, { type: "ok" });
    if (area === "agent" && cmd === "start") {
      const kindAt = args.indexOf("--kind");
      if (kindAt >= 0 && args[2]) this.agentKinds.set(args[2], args[kindAt + 1]!);
      // The CLI blocks through its own readiness poll and prints a READY agent.
      return frame(id, { type: "agent_started", agent: this.agentInfo(args[2]), argv: ["fake"] });
    }
    if (area === "agent" && cmd === "get") {
      return frame(id, { type: "agent_info", agent: this.agentInfo(args[2]) });
    }
    if (area === "agent" && cmd === "wait") {
      return frame(id, { type: "agent_info", agent: this.agentInfo(args[2]) });
    }
    if (area === "agent" && cmd === "prompt") {
      const outcome = await this.onPrompt?.(args, this);
      return frame(id, {
        type: "agent_prompted",
        agent: this.agentInfo(args[2], outcome && "status" in (outcome as object) ? (outcome as { status: string }).status : this.agentStatus),
      });
    }
    if (area === "agent" && cmd === "send-keys") return frame(id, { type: "ok" });
    if (area === "agent" && cmd === "read") return ok(this.paneText);
    if (area === "agent" && cmd === "explain") {
      return ok(`${JSON.stringify({ agent: "claude", state: this.agentStatus, evaluated_rules: [] })}\n`);
    }
    return fail(2, `unknown option: ${args.join(" ")}`);
  }

  private agentInfo(name: string | undefined, status?: string): Record<string, unknown> {
    return {
      terminal_id: "term_fake_remote",
      ...(name ? { name } : {}),
      agent: (name && this.agentKinds.get(name)) ?? "claude",
      agent_status: status ?? this.agentStatus,
      interactive_ready: true,
      launch_pending: false,
      workspace_id: "w1",
      tab_id: "w1:t2",
      pane_id: "w1:p2",
    };
  }
}

function ok(stdout: string): SshExecResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(code: number, stderr: string): SshExecResult {
  return { code, stdout: "", stderr };
}

function frame(id: string, result: unknown): SshExecResult {
  return { code: 0, stdout: `${JSON.stringify({ id, result })}\n`, stderr: "" };
}

function errFrame(id: string, code: string, message: string): SshExecResult {
  return { code: 1, stdout: "", stderr: `${JSON.stringify({ id, error: { code, message } })}\n` };
}
