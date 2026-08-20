/**
 * SshHerdrTransport: drive a REMOTE machine's Herdr session with the plain
 * `herdr` CLI over ssh (SPEC D13 — "local machines use the socket; remote
 * machines use plain herdr over SSH").
 *
 * Ground rules, all measured against herdr 0.8.0 and its Rust source:
 *
 * - The CLI prints the SAME result shapes as the socket, wrapped in one JSON
 *   frame per command: `{"id":"cli:workspace:create","result":{...}}` on
 *   stdout for success, `{"id":"cli:...","error":{"code","message"}}` on
 *   stderr with exit code 1 for a server-side error (src/cli.rs
 *   print_response). Two deliberate CLI exceptions (src/cli/agent.rs):
 *   `agent read` prints the RAW pane text (no frame; print_read_response) and
 *   `agent explain --json` prints the RAW explain JSON — this transport wraps
 *   both back into the socket's `{read:{text}}` / `{explain}` result shapes so
 *   the runner sees one protocol.
 * - `herdr agent start` BLOCKS until the named agent is interactive (the CLI
 *   runs its own wait_for_named_agent readiness poll) — a superset of the
 *   socket's launch_pending behavior, so the runner's own agent.get readiness
 *   poll simply succeeds immediately afterwards.
 * - The herdr binary is the machine's DECLARED ABSOLUTE PATH, never PATH:
 *   `ssh host 'cmd'` runs a non-login shell with no usable PATH (D13).
 * - HERDR_SOCKET_PATH / HERDR_CLIENT_SOCKET_PATH are explicitly unset in the
 *   remote command (`env -u`) so a stray remote environment can never point
 *   the CLI at the wrong session (reference §7).
 * - Every remote token is single-quote shell-escaped; prompts with quotes,
 *   newlines, or `$` travel intact.
 * - Connections are REUSED via OpenSSH ControlMaster (-o ControlMaster=auto
 *   -o ControlPath=... -o ControlPersist=60): an agent call is minutes, but
 *   the readiness poll and harvest are many small commands and a fresh ssh
 *   handshake per command would dominate them.
 * - The transport ensures the worker session's server is RUNNING before the
 *   first request: a cheap `workspace list` probe; on `server_not_running`
 *   (the CLI's own code for nothing-listening-on-the-socket, covering
 *   connection-refused and no-socket alike) it starts one headless —
 *   `nohup <bin> --session <s> server >/dev/null 2>&1 &` — and re-probes with
 *   backoff. NOTE (measured live on build-mac): an autostarted server may
 *   asynchronously RESTORE persisted workspaces from the session's previous
 *   life. Harmless to the runner — it only ever drives ids it minted — but a
 *   `workspace list` shortly after autostart can show leftovers of an earlier
 *   run alongside (or after) freshly created state.
 * - `onLateResult` is NOT supported over ssh: when a request times out the CLI
 *   process is killed, and any id the command minted server-side is
 *   unrecoverable. Orphaned tabs/workspaces are bounded by the run's
 *   workspace teardown.
 *
 * The exec function is INJECTED (SshExecFn) so tests fake ssh entirely; the
 * default spawns the local `ssh` binary.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HerdrRequestTimeoutError, HerdrRpcError, HerdrTransportError } from "./socket.js";
import type { HerdrTransport, HerdrTransportRequestOptions } from "./transport.js";

/** One ssh invocation: `ssh <argv...>`, optionally fed stdin. */
export interface SshExecRequest {
  /** Arguments passed to `ssh` (options, target, remote command). */
  argv: string[];
  /** Piped to the remote command's stdin, then closed. */
  stdin?: string;
  /** Kill the ssh process after this many ms; the result carries timedOut. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SshExecResult {
  /** ssh's exit code (255 = ssh-level failure); null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed by the timeout. */
  timedOut?: boolean;
}

export type SshExecFn = (request: SshExecRequest) => Promise<SshExecResult>;

/**
 * Cap on one remote command string. The whole `env -u ... herdr ...` command
 * is a SINGLE argv element to the remote `$SHELL -c` (and the prompt inside
 * it a single herdr argv token), so Linux's per-argument exec limit
 * (MAX_ARG_STRLEN = 128 KiB) bounds it; 8 KiB headroom covers quoting and
 * whatever the remote shell prepends.
 */
export const MAX_REMOTE_COMMAND_BYTES = 128 * 1024 - 8 * 1024;

export interface SshHerdrTransportOptions {
  /** ssh destination: an alias from ssh config or user@host. */
  target: string;
  /** ABSOLUTE path of the herdr binary on the remote machine (D13: never PATH). */
  herdrBin: string;
  /** The worker session name on the remote machine. */
  session: string;
  /** Machine name, for error messages. Defaults to the ssh target. */
  machineName?: string;
  /** Injected ssh runner (tests fake this). Defaults to spawning `ssh`. */
  exec?: SshExecFn;
  /** Default per-request timeout (ms). Default 30 000. */
  requestTimeoutMs?: number;
  /**
   * Directory for ControlMaster sockets. Default `~/.ssh/herdr-flow` (created
   * 0700). NOT os.tmpdir(): on macOS that expands to /var/folders/… and the
   * resulting ControlPath exceeds the 104-byte sun_path cap — ssh refuses it
   * with "ControlPath too long" (measured live against build-mac).
   */
  controlDir?: string;
  /** ControlPersist seconds for the shared master connection. Default 60. */
  controlPersistSeconds?: number;
  /** Server-start probe retries after launching the session server. Default 20. */
  serverStartRetries?: number;
  /** Delay between server-start probes (ms). Default 500. */
  serverStartDelayMs?: number;
}

export class SshHerdrTransport implements HerdrTransport {
  private readonly target: string;
  private readonly herdrBin: string;
  private readonly session: string;
  private readonly machineName: string;
  private readonly exec: SshExecFn;
  private readonly requestTimeoutMs: number;
  private readonly controlDir: string;
  private readonly controlPersistSeconds: number;
  private readonly serverStartRetries: number;
  private readonly serverStartDelayMs: number;
  /**
   * Memoized session-server readiness, shared by concurrent first requests so
   * fan-out probes (and possibly starts) the server once. Reset on failure so
   * a later request can retry.
   */
  private readyPromise?: Promise<void>;
  private closed = false;

  constructor(options: SshHerdrTransportOptions) {
    if (typeof options?.target !== "string" || !options.target.trim()) {
      throw new TypeError("SshHerdrTransport requires an ssh target (alias or user@host).");
    }
    if (typeof options.herdrBin !== "string" || !path.isAbsolute(options.herdrBin.trim())) {
      throw new TypeError(
        `SshHerdrTransport requires an ABSOLUTE herdr_bin path (got ${JSON.stringify(options.herdrBin)}) — ` +
          "ssh runs a non-login shell with no usable PATH (SPEC D13).",
      );
    }
    if (typeof options.session !== "string" || !options.session.trim()) {
      throw new TypeError("SshHerdrTransport requires the worker session name.");
    }
    this.target = options.target.trim();
    this.herdrBin = options.herdrBin.trim();
    this.session = options.session.trim();
    this.machineName = options.machineName?.trim() || this.target;
    this.exec = options.exec ?? createDefaultSshExec();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.controlDir = options.controlDir ?? path.join(os.homedir(), ".ssh", "herdr-flow");
    this.controlPersistSeconds = options.controlPersistSeconds ?? 60;
    this.serverStartRetries = options.serverStartRetries ?? 20;
    this.serverStartDelayMs = options.serverStartDelayMs ?? 500;
    if (options.exec === undefined) {
      // Real ssh: the ControlPath directory must exist before the first
      // connection, private to the user (control sockets grant session
      // access). Injected execs never touch the filesystem.
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    }
  }

  async request(method: string, params: Record<string, unknown> = {}, options: HerdrTransportRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new HerdrTransportError("ssh herdr transport is closed");
    await this.ensureSessionServer();
    return this.rawRequest(method, params, options);
  }

  async readTextFile(filePath: string): Promise<string | undefined> {
    // No herdr involved: plain `cat` on the remote host. Non-zero exit
    // (missing, unreadable) is "not there", matching the local transport.
    try {
      const result = await this.run(`cat ${shellQuote(filePath)}`, { timeoutMs: this.requestTimeoutMs });
      return result.code === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    const dir = path.posix.dirname(filePath);
    const result = await this.run(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(filePath)}`, {
      stdin: content,
      timeoutMs: this.requestTimeoutMs,
    });
    if (result.code !== 0) {
      throw new HerdrTransportError(
        `writing ${filePath} on ${this.machineName} failed (exit ${String(result.code)}): ${snippet(result.stderr)}`,
      );
    }
  }

  async ensureDir(dirPath: string): Promise<void> {
    const result = await this.run(`mkdir -p ${shellQuote(dirPath)}`, { timeoutMs: this.requestTimeoutMs });
    if (result.code !== 0) {
      throw new HerdrTransportError(
        `mkdir -p ${dirPath} on ${this.machineName} failed (exit ${String(result.code)}): ${snippet(result.stderr)}`,
      );
    }
  }

  /**
   * Best-effort: ask the ControlMaster to exit so no background ssh outlives
   * the run (ControlPersist would otherwise keep it for its idle window).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.exec({
        argv: [...this.controlArgs(), "-O", "exit", this.target],
        timeoutMs: 5_000,
      });
    } catch {
      // Best-effort; the master may never have been established.
    }
  }

  // ── Session-server bootstrap ───────────────────────────────────────────────

  /**
   * No per-call abort signal on purpose (mirroring the runner's
   * ensureWorkspace): the session server is a MACHINE-scoped resource whose
   * bootstrap promise is shared by every concurrent request. Cancelling it
   * with the FIRST caller's signal would reject the memoized promise with an
   * "aborted" error and fail every sibling call parked on it — errors the
   * engine then misclassifies as WORKFLOW_ABORTED. Bootstrap is bounded by
   * its own timeouts (requestTimeoutMs per probe, serverStartRetries ×
   * serverStartDelayMs overall); an aborted caller still fails fast, in
   * rawRequest, once the shared bootstrap settles.
   */
  private ensureSessionServer(): Promise<void> {
    if (!this.readyPromise) {
      const attempt = this.probeOrStartServer();
      attempt.catch(() => {
        if (this.readyPromise === attempt) this.readyPromise = undefined;
      });
      this.readyPromise = attempt;
    }
    return this.readyPromise;
  }

  private async probeOrStartServer(): Promise<void> {
    try {
      await this.rawRequest("workspace.list", {}, {});
      return;
    } catch (error) {
      if (!isServerNotRunning(error)) throw error;
    }
    // Nothing is listening on the session socket: start a headless server.
    // nohup + full redirection so ssh's channel closes immediately instead of
    // waiting on the server's lifetime.
    const start = await this.run(
      `env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH nohup ${shellQuote(this.herdrBin)} --session ${shellQuote(this.session)} server </dev/null >/dev/null 2>&1 &`,
      { timeoutMs: this.requestTimeoutMs },
    );
    if (start.code !== 0) {
      throw new HerdrTransportError(
        `starting the herdr session server on ${this.machineName} failed (exit ${String(start.code)}): ${snippet(start.stderr)}`,
      );
    }
    for (let attempt = 0; ; attempt++) {
      await sleep(this.serverStartDelayMs);
      try {
        await this.rawRequest("workspace.list", {}, {});
        return;
      } catch (error) {
        if (!isServerNotRunning(error) || attempt >= this.serverStartRetries) throw error;
      }
    }
  }

  // ── Request plumbing ───────────────────────────────────────────────────────

  private async rawRequest(method: string, params: Record<string, unknown>, options: HerdrTransportRequestOptions): Promise<unknown> {
    const cliArgs = buildHerdrCliArgs(method, params);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const command = this.herdrCommand(cliArgs);
    // The whole remote command travels as ONE argv element (ssh hands it to
    // the remote `$SHELL -c` as a single string, and the prompt inside it is
    // again a single herdr argv token), so it is capped by the remote
    // kernel's per-argument exec limit — 128 KiB MAX_ARG_STRLEN on Linux.
    // Exceeding it would surface as an opaque E2BIG/exit-code failure that
    // only remote placements hit; fail it here with a diagnosable,
    // deterministic error instead (the runner maps this code to a
    // non-recoverable SCRIPT_VALIDATION_ERROR).
    if (Buffer.byteLength(command, "utf8") > MAX_REMOTE_COMMAND_BYTES) {
      throw new HerdrRpcError(
        method,
        "remote_command_too_large",
        `remote herdr command for "${method}" on ${this.machineName} is ${Buffer.byteLength(command, "utf8")} bytes, ` +
          `over the ~128 KiB per-argument exec limit of the remote host (${MAX_REMOTE_COMMAND_BYTES} after headroom). ` +
          "Shrink the prompt/schema or place the call on a local machine.",
      );
    }
    const result = await this.run(command, {
      timeoutMs,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new Error(`herdr request "${method}" aborted`);
    if (result.timedOut) throw new HerdrRequestTimeoutError(method, timeoutMs);
    return this.parseCliResult(method, result);
  }

  private async run(remoteCommand: string, options: { stdin?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<SshExecResult> {
    return this.exec({
      argv: [...this.controlArgs(), this.target, remoteCommand],
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  private controlArgs(): string[] {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${path.join(this.controlDir, "cm-%C")}`,
      "-o",
      `ControlPersist=${this.controlPersistSeconds}`,
    ];
  }

  /** `env -u ... <herdrBin> --session <s> <cli args...>`, fully shell-quoted. */
  private herdrCommand(cliArgs: string[]): string {
    return ["env", "-u", "HERDR_SOCKET_PATH", "-u", "HERDR_CLIENT_SOCKET_PATH", this.herdrBin, "--session", this.session, ...cliArgs]
      .map(shellQuote)
      .join(" ");
  }

  private parseCliResult(method: string, result: SshExecResult): unknown {
    if (result.code === 0) {
      // Two CLI commands print raw content instead of a frame (measured; see
      // module doc) — wrap them back into the socket's result shapes.
      if (method === "agent.read") {
        return { type: "pane_read", read: { text: result.stdout } };
      }
      if (method === "agent.explain") {
        const parsed = tryParseJson(result.stdout.trim());
        return { type: "agent_explain", explain: parsed !== undefined ? parsed : result.stdout.trim() };
      }
      const frame = findFrame(result.stdout, "result") ?? findFrame(result.stderr, "result");
      if (frame) return (frame as { result: unknown }).result;
      throw new HerdrTransportError(
        `herdr CLI on ${this.machineName} printed no result frame for "${method}": ${snippet(result.stdout || result.stderr)}`,
      );
    }
    // Error frames go to stderr (print_response), exit code 1; usage errors
    // exit 2 with plain text. Search both streams for a frame first so real
    // Herdr codes (agent_pane_busy, server_not_running, …) survive verbatim.
    const errorFrame = (findFrame(result.stderr, "error") ?? findFrame(result.stdout, "error")) as
      | { error?: { code?: unknown; message?: unknown; data?: unknown } }
      | undefined;
    if (errorFrame?.error) {
      const code = typeof errorFrame.error.code === "string" ? errorFrame.error.code : "unknown_error";
      const message = typeof errorFrame.error.message === "string" ? errorFrame.error.message : undefined;
      throw new HerdrRpcError(method, code, message, errorFrame.error.data);
    }
    // One CLI-side validation the socket does server-side: `agent start`
    // rejects an unsupported --kind BEFORE sending any request — exit 2 with
    // plain text (src/cli/agent.rs: "unsupported interactive agent kind"),
    // never an error frame. Re-synthesize the server's own code so the
    // deterministic author error keeps its non-recoverable
    // SCRIPT_VALIDATION_ERROR classification on both transports instead of
    // degrading to a generic recoverable transport error that gets retried.
    const plainText = (result.stderr || result.stdout).trim();
    if (method === "agent.start" && result.code === 2 && /unsupported interactive agent kind/.test(plainText)) {
      throw new HerdrRpcError(method, "unsupported_agent_kind", plainText);
    }
    throw new HerdrTransportError(
      `ssh ${this.target} exited ${String(result.code)} for herdr "${method}": ${snippet(result.stderr || result.stdout)}`,
    );
  }
}

/**
 * Map one socket-protocol request onto the herdr CLI's argv (flags verified
 * against herdr 0.8.0 `--help` and src/cli/{workspace,tab,pane,agent}.rs).
 * Every method the runner uses is covered; anything else is a programming
 * error, thrown loudly.
 */
export function buildHerdrCliArgs(method: string, params: Record<string, unknown>): string[] {
  switch (method) {
    case "workspace.list":
      return ["workspace", "list"];
    case "workspace.create":
      return [
        "workspace",
        "create",
        ...stringFlag("--label", params.label),
        ...stringFlag("--cwd", params.cwd),
        params.focus === true ? "--focus" : "--no-focus",
        ...envFlags(params.env),
      ];
    case "workspace.close":
      return ["workspace", "close", requireString(method, "workspace_id", params.workspace_id)];
    case "tab.create":
      return [
        "tab",
        "create",
        ...stringFlag("--workspace", params.workspace_id),
        ...stringFlag("--cwd", params.cwd),
        ...stringFlag("--label", params.label),
        params.focus === true ? "--focus" : "--no-focus",
        ...envFlags(params.env),
      ];
    case "tab.close":
      return ["tab", "close", requireString(method, "tab_id", params.tab_id)];
    case "pane.list":
      return ["pane", "list", ...stringFlag("--workspace", params.workspace_id)];
    case "pane.close":
      return ["pane", "close", requireString(method, "pane_id", params.pane_id)];
    case "agent.start": {
      const args = Array.isArray(params.args) ? (params.args as string[]) : [];
      return [
        "agent",
        "start",
        requireString(method, "name", params.name),
        "--kind",
        requireString(method, "kind", params.kind),
        "--pane",
        requireString(method, "pane_id", params.pane_id),
        ...numberFlag("--timeout", params.timeout_ms),
        ...(args.length > 0 ? ["--", ...args] : []),
      ];
    }
    case "agent.prompt": {
      const wait = params.wait as { until?: unknown; timeout_ms?: unknown } | undefined;
      return [
        "agent",
        "prompt",
        requireString(method, "target", params.target),
        requireString(method, "text", params.text),
        ...(wait ? ["--wait", ...untilFlags(wait.until), ...numberFlag("--timeout", wait.timeout_ms)] : []),
      ];
    }
    case "agent.wait":
      return [
        "agent",
        "wait",
        requireString(method, "target", params.target),
        ...untilFlags(params.until),
        ...numberFlag("--timeout", params.timeout_ms),
      ];
    case "agent.get":
      return ["agent", "get", requireString(method, "target", params.target)];
    case "agent.explain":
      return ["agent", "explain", requireString(method, "target", params.target), "--json"];
    case "agent.read":
      return [
        "agent",
        "read",
        requireString(method, "target", params.target),
        ...stringFlag("--source", params.source),
        // `--format text` implies strip_ansi in the CLI, matching the runner's
        // only read shape (source visible, text, stripped).
        ...stringFlag("--format", params.format),
      ];
    case "agent.send_keys": {
      const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
      return ["agent", "send-keys", requireString(method, "target", params.target), ...keys];
    }
    default:
      throw new HerdrTransportError(`no herdr CLI mapping for method "${method}" — add it to buildHerdrCliArgs`);
  }
}

/** Single-quote shell escaping: safe for any byte except NUL, including newlines. */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The default SshExecFn: spawn the local `ssh` binary. */
export function createDefaultSshExec(): SshExecFn {
  return (request) =>
    new Promise<SshExecResult>((resolve, reject) => {
      const child = spawn("ssh", request.argv, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        child.kill("SIGKILL");
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, request.timeoutMs);
      }
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new HerdrTransportError(`ssh could not be spawned: ${error.message}`));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
      });
      child.stdin.on("error", () => {
        // The remote command may exit without reading stdin (e.g. mkdir);
        // EPIPE here must not crash the process.
      });
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
}

function isServerNotRunning(error: unknown): boolean {
  return error instanceof HerdrRpcError && error.code === "server_not_running";
}

function stringFlag(flag: string, value: unknown): string[] {
  return typeof value === "string" && value !== "" ? [flag, value] : [];
}

function numberFlag(flag: string, value: unknown): string[] {
  return typeof value === "number" && Number.isFinite(value) ? [flag, String(value)] : [];
}

function envFlags(env: unknown): string[] {
  if (typeof env !== "object" || env === null) return [];
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") flags.push("--env", `${key}=${value}`);
  }
  return flags;
}

function untilFlags(until: unknown): string[] {
  if (!Array.isArray(until)) return [];
  return until.flatMap((status) => (typeof status === "string" ? ["--until", status] : []));
}

function requireString(method: string, name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new HerdrTransportError(`herdr "${method}" requires string param "${name}"; got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Find the first JSON object line in `text` that carries `key`. */
function findFrame(text: string, key: "result" | "error"): Record<string, unknown> | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null && key in (parsed as Record<string, unknown>)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed || "(no output)";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
