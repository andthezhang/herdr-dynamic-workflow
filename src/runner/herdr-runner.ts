/**
 * HerdrAgentRunner: the WorkflowAgentRunner backend that runs each agent()
 * call as a real coding-agent CLI inside a Herdr pane, per
 * docs/herdr-runtime-support.md §1 and SPEC D11 topology (one workspace
 * per run PER DESTINATION, one tab per agent call, one pane per tab, never split —
 * a fresh headless worker session has ZERO panes, so there is nothing to
 * split from):
 *
 *   workspace.create (once per runner per destination, label `flow/<runId>`,
 *   focus:false; closed again in close()) -> tab.create in it per agent call
 *   (HERDR_FLOW_* env injected, focus:false, label = the agent's label so the
 *   tab list is the run's progress view; tab/pane ids taken from the
 *   response's `tab` and `root_pane`, never predicted) -> agent.start (name
 *   `flow-<run>-<call>`, kind, pane_id; agent_pane_busy retried with backoff
 *   because the fresh tab's shell may not be at its prompt yet — measured V1)
 *   -> a client-side agent.get readiness poll until the CLI is detected and
 *   interactive (agent.start only types the launch command into the shell;
 *   herdr's own CLI polls the same way) -> agent.prompt (contract preamble +
 *   prompt, wait armed atomically on ["idle","done","blocked"]) -> harvest
 *   the HERDR_FLOW_OUT file through the §6 validation ladder (file missing ->
 *   the wait is not trusted: agent.get/agent.explain re-check first; blocked
 *   fails the call; a still-working agent means the settle was FALSE — re-arm
 *   one agent.wait and re-poll the file; only a genuinely settled agent takes
 *   the degraded agent.read source:"visible" fallback, tagged fallbackReason
 *   "output_file_missing") -> tab.close in a finally (closing the tab closes
 *   its pane).
 *
 * Launch flags (SPEC D4): the agent CLI's permission bypass is hardcoded per
 * kind (claude `--dangerously-skip-permissions`, codex `--sandbox
 * workspace-write --ask-for-approval never`), and a call's `model`/`effort`
 * are passed through verbatim as `--model` / `--effort` for the CLI to accept
 * or reject. The resulting args are folded into the engine's call hash via
 * callIdentity(). Blocked calls follow the onBlocked policy: "fail" tears
 * down; "escalate" leaves the pane open, emits an escalation record +
 * persisted pointer, and fails recoverable with the attach command.
 *
 * Where a call runs (SPEC D13) is the call's `ssh` option and nothing else:
 *
 * - `ssh: undefined` -> the LOCAL Herdr session's NDJSON socket.
 * - `ssh: "example-host"` -> that ssh destination, driven with the plain herdr
 *   CLI over ssh. The binary is found with a login-shell probe
 *   (ssh-transport.ts). There is no host inventory.
 * - One HerdrTransport (and one run workspace) per destination, created on the
 *   first call placed there. HERDR_FLOW_OUT for an ssh call is a REMOTE path
 *   (under remoteStateDir, POSIX-joined) read back through the same transport;
 *   ssh tabs open in the remote HOME, never a local path.
 * - Worktree isolation (a call-site cwd) is NOT supported over ssh: the path
 *   only exists on the engine's host, so combining it with `ssh` is
 *   SCRIPT_VALIDATION_ERROR — an explicit error, never a silent degrade.
 * - Hash identity (SPEC D6) is the engine's job: it hashes the call's `ssh`
 *   option, and this runner adds no host data to callIdentity().
 *
 * Herdr failures are mapped onto the engine's error taxonomy — pre-classified
 * WorkflowErrors for Herdr's own codes, the engine's wrapError seam for
 * everything else.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCallIdentity, AgentRunOptions, WorkflowAgentRunner } from "../engine/agent-runner.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "../engine/errors.js";
import {
  buildEnv,
  buildRemoteEnv,
  type FlowCallEnv,
  OUTPUT_CONTRACT_PREAMBLE,
  OutputFileMissingError,
  validateOutputPayload,
} from "./contract.js";
import { HerdrRpcError } from "./socket.js";
import { shellQuote, SshHerdrTransport } from "./ssh-transport.js";
import { LocalHerdrTransport, type HerdrTransport } from "./transport.js";

/**
 * A WorkflowError that also carries the Herdr-level failure code (either a
 * server error code verbatim — "agent_pane_busy", "agent_prompt_stalled",
 * "unsupported_agent_kind", … — or a runner-synthesized one like BLOCKED), so
 * callers can distinguish Herdr failure modes while the engine still sees its
 * own taxonomy.
 */
export class HerdrWorkflowError extends WorkflowError {
  readonly herdrCode: string;
  constructor(
    message: string,
    code: WorkflowErrorCode,
    herdrCode: string,
    options: { recoverable?: boolean; retryable?: boolean; agentLabel?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message, code, {
      recoverable: options.recoverable,
      retryable: options.retryable,
      agentLabel: options.agentLabel,
      details: { herdrCode, ...options.details },
    });
    this.name = "HerdrWorkflowError";
    this.herdrCode = herdrCode;
  }
}

/** Runner-synthesized Herdr code: the wait resolved `blocked` (approval/question UI). */
export const HERDR_BLOCKED = "BLOCKED";

/**
 * Agent kinds this engine can never drive: their herdr detection manifest has
 * NO settled (idle/done) rule, so an agent.prompt wait can never resolve — the
 * call would hang until timeout on every run. cline's manifest (herdr
 * src/detect/manifests/cline.toml) declares only a "blocked" rule and a
 * catch-all "working" rule.
 */
export const UNWAITABLE_KINDS: ReadonlySet<string> = new Set(["cline"]);

/**
 * Herdr's own agent-kind normalization, mirrored exactly (herdr
 * src/detect/mod.rs normalized_agent_lookup_name): trim, lowercase, strip one
 * launcher suffix. The server's agent.start validates `kind` through
 * parse_agent_label, which normalizes FIRST — so "Cline", "CLINE" and
 * "cline.exe" all launch a real cline agent. Any guard on a kind string must
 * therefore compare the normalized form, or normalization manufactures
 * effective aliases that sail past it.
 */
export function normalizeAgentKind(kind: string): string {
  let name = kind.trim().toLowerCase();
  for (const suffix of [".exe", ".cmd", ".bat", ".ps1", ".js"]) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name;
}

/**
 * SINGLE SOURCE OF TRUTH for the broken-kind guard: rejects an unwaitable
 * kind wherever it arrives — call-site `kind`, an agentType's kind, or the
 * runner's default kind — with a SCRIPT_VALIDATION_ERROR raised BEFORE any
 * pane/socket work. Both local and ssh calls pass through here via
 * resolveStartArgs; the default kind is checked at runner construction. The
 * kind is normalized the way herdr's server normalizes it
 * (normalizeAgentKind), so spellings herdr accepts as cline ("Cline",
 * "cline.exe") cannot bypass the guard.
 */
export function assertWaitableKind(kind: string, where: string, agentLabel?: string): void {
  if (!UNWAITABLE_KINDS.has(normalizeAgentKind(kind))) return;
  throw new WorkflowError(
    `${where}: agent kind "${kind}" cannot be driven by this engine — its herdr detection manifest ` +
      `has no idle rule (see herdr src/detect/manifests/${kind}.toml), so a prompt wait can never ` +
      "resolve and every call would hang until timeout. Use a different kind.",
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false, agentLabel },
  );
}

/** Default remote base dir for HERDR_FLOW_* paths (world-writable on macOS and Linux). */
export const DEFAULT_REMOTE_STATE_DIR = "/tmp/herdr-flow";

/** The agent CLI a call runs when neither the call nor the caller names one. */
export const DEFAULT_KIND = "claude";

/**
 * Permission-bypass flags appended to agent.start for the kinds this engine
 * drives headlessly. A workflow worker has no human at its pane, so a CLI that
 * stops to ask for approval hangs until the prompt wait times out — these
 * flags are the launch path, not a user setting.
 *
 * codex's pair is verified against `codex --help` after 0.147.0 dropped
 * `--full-auto`. A kind that is not listed launches bare.
 */
const PERMISSION_FLAGS: Readonly<Record<string, readonly string[]>> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
};

/**
 * Blocked-call policy (SPEC D15). "answer" exists in the vocabulary but is not
 * implemented until Q8 (what produces the answer) is settled — auto-answering
 * a permission prompt is the most dangerous thing this engine could do.
 */
export type OnBlockedPolicy = "fail" | "escalate";

/**
 * The agent.start args for one call: the kind's permission flags, then the
 * script's own `model`/`effort` passed straight through for the CLI to accept
 * or reject (SPEC D4 — this engine does not keep a table of vendor model
 * names). `tier` is a coarse model name and resolves through `--model` too.
 */
export function buildStartArgs(
  kind: string,
  request: { model?: string; tier?: string; effort?: string },
): string[] {
  const args = [...(PERMISSION_FLAGS[normalizeAgentKind(kind)] ?? [])];
  const model = request.model?.trim() || request.tier?.trim();
  if (model) args.push("--model", model);
  const effort = request.effort?.trim();
  if (effort) args.push("--effort", effort);
  return args;
}

export interface HerdrAgentRunnerOptions {
  /**
   * Path to the WORKFLOW session's socket on the LOCAL host, constructed
   * explicitly by the caller. Never HERDR_SOCKET_PATH from the environment —
   * inside a Herdr pane that points at the user's own session (reference §7).
   */
  socketPath: string;
  /**
   * State dir for LOCAL run output files: `<stateDir>/<runId>/<callIndex>.json`.
   * MUST be writable from inside the agent CLIs' sandboxes: codex
   * (workspace-write) rejects writes outside its cwd and $TMPDIR — measured
   * live, its own words: "The configured output path is outside the writable
   * sandbox" — so callers should put this under os.tmpdir(), never under
   * ~/.local/state.
   */
  stateDir: string;
  /**
   * Base dir for REMOTE run output files (SPEC Q11): the agent on an ssh host
   * writes `<remoteStateDir>/<runId>/<callIndex>.json` on ITS host, harvested
   * back over ssh. Default "/tmp/herdr-flow" — a path that exists and is
   * writable on any Unix host without knowing its $TMPDIR.
   */
  remoteStateDir?: string;
  /**
   * Per-runner defaults. `kind` is used when a call sets none. `cwd` is the
   * working directory for LOCAL agent tabs whose call sets none (normally the
   * workflow's own cwd) — without it tab.create falls back to the server
   * process's home directory, where the agent cannot see the project (and,
   * measured live, claude drifted into answering inline instead of honoring
   * the output-file contract). ssh tabs never receive this local path: it
   * names a directory on the wrong filesystem.
   */
  defaults: { kind: string; cwd?: string };
  /**
   * Label for the run's workspace on every destination (SPEC D11) — the
   * sidebar name a human sees. run.js passes `<meta.name> · <last-4-of-runId>`
   * so concurrent runs stay tellable apart while truncation keeps the name
   * visible. Falls back to `flow/<runId>` when absent.
   */
  workspaceLabel?: string;
  /**
   * Leave the run's workspace and agent tabs in Herdr after close().
   * Default false: each call's tab is closed when the call finishes, and
   * close() tears down the workspace. Abort still frees the aborted tab.
   */
  keepWorkspace?: boolean;
  /**
   * What a blocked worker does (SPEC D15): "fail" (default) tears the pane
   * down with the call; "escalate" leaves it open for a human and prints the
   * attach command.
   */
  onBlocked?: OnBlockedPolicy;
  /**
   * The worker session's name, used both to print human-runnable commands
   * (`herdr --session <name> agent attach <agent>`) in escalation records and
   * as the session driven over ssh. Defaults to the socket path's session
   * directory name (~/.config/herdr/sessions/<NAME>/herdr.sock).
   */
  session?: string;
  /**
   * Where socketPath's LOCAL session actually lives (run.js/resume.js pass
   * the resolved placement mode): "default" means socketPath is the USER'S
   * OWN default session — reachable with plain `herdr` and NOT with
   * `--session <name>` — while "worker" (the default) means the named worker
   * session at ~/.config/herdr/sessions/<session>/. Escalation attach
   * commands for local calls depend on this: in "default" mode the
   * blocked pane is in the user's own session, so the printed command must
   * omit --session (a `herdr --session flow …` command would target a
   * different — typically not even running — session). ssh hosts are
   * unaffected: they are always driven under the named worker session.
   */
  localSessionMode?: "default" | "worker";
  /**
   * Test seam: build the transport for one destination — `undefined` for the
   * local session, else the call's ssh target. Defaults to LocalHerdrTransport
   * (socketPath) and SshHerdrTransport (target + session) respectively.
   */
  transportFactory?: (ssh: string | undefined) => HerdrTransport;
  /** Per-request socket timeout for ordinary calls (ms). Default 30 000. */
  requestTimeoutMs?: number;
  /** Default agent.prompt wait timeout when the call carries none (ms). Default 900 000. */
  promptWaitTimeoutMs?: number;
  /** agent.start timeout_ms (Herdr requires > 3000 and <= 300 000). Default 60 000. */
  agentStartTimeoutMs?: number;
  /** Max agent_pane_busy retries after the initial agent.start attempt. Default 3. */
  paneBusyRetries?: number;
  /** Base backoff between agent_pane_busy retries (ms, scales linearly). Default 1 000. */
  paneBusyDelayMs?: number;
  /**
   * Poll interval while waiting for a started agent to become interactive
   * (ms). agent.start only types the launch command into the pane's shell and
   * returns immediately with launch_pending — readiness is a client-side
   * agent.get poll, exactly like herdr's own CLI (src/cli/agent.rs
   * wait_for_named_agent, 100ms cadence). Default 100.
   */
  agentReadyPollMs?: number;
  /** How long to wait for the output file to appear after the wait settled (ms). Default 1 500. */
  outputSettleMs?: number;
  /** Pause between esc and ctrl+c during abort teardown (ms). Default 250. */
  abortSettleMs?: number;
}

interface CallContext {
  label: string;
  runId: string;
  callIndex: number;
  /** The call's ssh target, or undefined for the local session (SPEC D13). */
  ssh?: string;
  transport?: HerdrTransport;
  tabId?: string;
  paneId?: string;
  agentName?: string;
  /**
   * Set when the "escalate" policy claimed this call's tab: the blocked worker
   * is deliberately left OPEN for a human, so the finally-block teardown must
   * NOT close it (SPEC D15).
   */
  escalated?: boolean;
  /** Set when the call's AbortSignal fired; finally still closes the tab. */
  aborted?: boolean;
}

const USAGE_ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
/**
 * The budget unit this backend reports: ONE per completed agent call. Herdr
 * has no token signal for a PTY agent (§8), and the engine treats a zero
 * total as "no report" and substitutes a JSON-length token ESTIMATE
 * (workflow.ts recordTokens) — which would silently turn `budget`/`phase`
 * budgets into a meaningless pseudo-token unit. Reporting total=1 makes
 * spent() count agent calls, the unit SPEC D8 promises ("budget counts
 * agents and wall-clock, not tokens") and the authoring skill documents.
 */
const USAGE_ONE_CALL = { ...USAGE_ZERO, total: 1 };
const OUTPUT_POLL_MS = 25;

export class HerdrAgentRunner implements WorkflowAgentRunner {
  private readonly socketPath: string;
  private readonly stateDir: string;
  private readonly remoteStateDir: string;
  private readonly defaultKind: string;
  private readonly defaultCwd?: string;
  private readonly workspaceLabel?: string;
  private readonly keepWorkspace: boolean;
  private readonly transportFactory?: (ssh: string | undefined) => HerdrTransport;
  private readonly requestTimeoutMs: number;
  private readonly promptWaitTimeoutMs: number;
  private readonly agentStartTimeoutMs: number;
  private readonly paneBusyRetries: number;
  private readonly paneBusyDelayMs: number;
  private readonly agentReadyPollMs: number;
  private readonly outputSettleMs: number;
  private readonly abortSettleMs: number;
  private readonly onBlocked: OnBlockedPolicy;
  /** Worker session name for human-runnable attach commands in escalations. */
  private readonly session: string;
  private readonly localSessionMode: "default" | "worker";
  /** One transport per destination key, created lazily on the first call there. */
  private readonly transports = new Map<string, HerdrTransport>();
  /**
   * Blocked workers left open by the escalate policy, per destination. While a
   * destination has any, close() must NOT close its workspace — the escalated
   * panes live in it, and tearing it down would kill exactly the workers a
   * human was told to go answer.
   */
  private readonly escalations = new Map<string, number>();
  /** Monotonic across every run() on this runner: unique names and out paths. */
  private callSeq = 0;
  private readonly fallbackRunId = `r${Date.now().toString(36)}`;
  /**
   * The run's ONE workspace per destination (SPEC D11), created lazily on the
   * first agent call placed there and memoized as a promise so concurrent
   * fan-out calls share a single workspace.create instead of racing to mint
   * one each. Reset on failure so a later call can retry; the resolved ids
   * are kept for close().
   */
  private readonly workspacePromises = new Map<string, Promise<string>>();
  private readonly workspaceIds = new Map<string, string>();
  private closed = false;

  constructor(options: HerdrAgentRunnerOptions) {
    if (typeof options?.socketPath !== "string" || !options.socketPath.trim()) {
      throw new TypeError(
        "HerdrAgentRunner requires an explicit socketPath (never taken from HERDR_SOCKET_PATH — reference §7).",
      );
    }
    if (typeof options.stateDir !== "string" || !options.stateDir.trim()) {
      throw new TypeError("HerdrAgentRunner requires stateDir: where run output files are written.");
    }
    if (typeof options.defaults?.kind !== "string" || !options.defaults.kind.trim()) {
      throw new TypeError('HerdrAgentRunner requires defaults.kind: the coding-agent CLI to run when a call names none.');
    }
    if (options.agentStartTimeoutMs !== undefined) {
      // Herdr validates agent.start timeout_ms server-side (> 3000 and
      // <= 300 000, reference §1 phase 2). An out-of-range value is a
      // deterministic config error that would otherwise fail EVERY launch with
      // a generic recoverable RPC error — fail fast here instead.
      const value = options.agentStartTimeoutMs;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 3000 || value > 300_000) {
        throw new RangeError(
          `HerdrAgentRunner agentStartTimeoutMs must be > 3000 and <= 300000 (Herdr's agent.start timeout_ms bounds); got ${String(value)}`,
        );
      }
    }
    this.socketPath = options.socketPath;
    this.stateDir = options.stateDir;
    this.remoteStateDir = options.remoteStateDir?.trim() || DEFAULT_REMOTE_STATE_DIR;
    this.defaultKind = options.defaults.kind.trim();
    this.defaultCwd = options.defaults.cwd?.trim() || undefined;
    this.workspaceLabel = options.workspaceLabel?.trim() || undefined;
    this.keepWorkspace = options.keepWorkspace === true;
    this.transportFactory = options.transportFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.promptWaitTimeoutMs = options.promptWaitTimeoutMs ?? 900_000;
    this.agentStartTimeoutMs = options.agentStartTimeoutMs ?? 60_000;
    this.paneBusyRetries = options.paneBusyRetries ?? 3;
    this.paneBusyDelayMs = options.paneBusyDelayMs ?? 1_000;
    this.agentReadyPollMs = options.agentReadyPollMs ?? 100;
    this.outputSettleMs = options.outputSettleMs ?? 1_500;
    this.abortSettleMs = options.abortSettleMs ?? 250;
    this.onBlocked = options.onBlocked ?? "fail";
    this.session = options.session?.trim() || path.basename(path.dirname(options.socketPath));
    this.localSessionMode = options.localSessionMode ?? "worker";
    // Broken-kind guard, config route (call routes are guarded in
    // resolveStartArgs): the default kind (runner option, --kind, or the
    // invoke object's kind — the plugin entry points fold them into
    // defaults.kind) fails fast at construction, before any pane/socket work.
    assertWaitableKind(this.defaultKind, "default agent kind");
  }

  /**
   * Runner-provided identity data (SPEC D4/D6): the agent.start args this
   * call's kind/model/tier/effort produce, folded into the engine's call hash
   * so a change to the launch flags invalidates the cached calls that used
   * them. Throws SCRIPT_VALIDATION_ERROR for an unwaitable kind (before any
   * socket call — the engine hashes before it runs).
   *
   * A call that names NO kind additionally contributes the runner's DEFAULT
   * kind (SPEC D6: identity is the kind plus the resolved flags). The engine
   * hashes only the script-visible kind (call site / agentType), so without
   * this the CLI that actually runs an implicit-kind call would be invisible to
   * the resume hash — resuming under a different default kind (`resume.js
   * --kind codex`, or a changed HerdrAgentRunnerOptions.defaults.kind) would
   * silently replay one CLI's result as the other's.
   *
   * Host identity is deliberately NOT contributed here (SPEC D6): the engine
   * already hashes the call's `ssh` option.
   */
  callIdentity(call: AgentCallIdentity): unknown {
    const args = this.resolveStartArgs(call, undefined);
    const identity: Record<string, unknown> = {};
    if (!call.kind?.trim()) identity.kind = this.defaultKind;
    if (args.length > 0) identity.args = args;
    return Object.keys(identity).length === 0 ? undefined : identity;
  }

  /** The call's agent.start args, guarding the kind on the way through. */
  private resolveStartArgs(
    call: { kind?: string; model?: string; tier?: string; effort?: string },
    agentLabel: string | undefined,
  ): string[] {
    const kind = call.kind?.trim() || this.defaultKind;
    // Broken-kind guard, call routes: every call — local or over ssh, hashed
    // via callIdentity or executed via run() — builds its args here first,
    // before any transport or socket work.
    assertWaitableKind(kind, agentLabel ? `agent "${agentLabel}"` : "agent call", agentLabel);
    return buildStartArgs(kind, call);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<unknown> {
    const label = options.label ?? "agent";
    const signal = options.signal;
    this.throwIfAborted(signal, label);

    const kind = options.kind?.trim() || this.defaultKind;
    // The kind's permission flags plus the script's model/effort (SPEC D4).
    // The same call feeds callIdentity(), so these args are already part of
    // the engine's call hash when the engine drives this runner.
    const startArgs = this.resolveStartArgs(
      { kind, model: options.model, tier: options.tier, effort: options.effort },
      label,
    );
    // Where the call runs: validated BEFORE any transport is built, so a bad
    // ssh option never opens a connection.
    const ssh = this.resolveSshTarget(options, label);
    const runId = runIdFromSessionName(options.sessionName) ?? this.fallbackRunId;
    const callIndex = this.callSeq++;

    const context: CallContext = {
      label,
      runId,
      callIndex,
      ...(ssh !== undefined ? { ssh } : {}),
      agentName: buildAgentName(runId, callIndex),
    };
    try {
      const transport = this.transportFor(ssh);
      context.transport = transport;
      const hasSchema = options.schema != null;
      // HERDR_FLOW_* paths live on the WORKER's host (SPEC Q11): local calls
      // under stateDir, ssh calls under remoteStateDir (POSIX paths), both
      // prepared through that host's own transport.
      const env = ssh
        ? buildRemoteEnv(this.remoteStateDir, runId, callIndex, hasSchema)
        : buildEnv(this.stateDir, runId, callIndex, hasSchema);
      // TRUNCATE the out path (creating its parent dirs in the same round
      // trip) rather than merely mkdir -p'ing them: `<runId>/<callIndex>` is
      // only unique per RUNNER INSTANCE (callSeq starts at 0), so a resume —
      // a fresh runner reusing the crashed run's runId against the same
      // persistent stateDir/remoteStateDir — collides with the previous
      // execution's output files. Without this wipe, a false settle or a
      // contract-violating agent would harvest the PREVIOUS run's stale
      // payload as this call's result (or halt with a spurious
      // SCHEMA_NONCOMPLIANCE). An empty file reads as "not there yet"
      // (readOutputFile ignores whitespace-only content).
      await transport.writeTextFile(env.HERDR_FLOW_OUT, "");
      if (hasSchema && env.HERDR_FLOW_SCHEMA) {
        await transport.writeTextFile(env.HERDR_FLOW_SCHEMA, JSON.stringify(options.schema, null, 2));
      }

      const opened = await this.openTab(context, env, options, signal);
      context.tabId = opened.tabId;
      context.paneId = opened.paneId;
      await this.startAgent(context, kind, startArgs, signal);
      const status = await this.promptAgent(context, prompt, options, signal);
      if (status === "blocked") throw await this.raiseBlocked(context, options);
      const value = await this.harvest(env.HERDR_FLOW_OUT, context, options);
      // Budget unit: one agent call (see USAGE_ONE_CALL — a zero total would
      // make the engine substitute a token estimate, breaking SPEC D8's unit).
      options.onUsage?.({ ...USAGE_ONE_CALL });
      return value;
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation is best-effort keystrokes (§8): esc to stop the turn,
        // a brief settle, ctrl+c to kill the CLI. tab.close in the finally
        // below then actually frees the tab and its pane. An explicit abort
        // outranks both escalate and keepWorkspace: the user asked for teardown.
        context.aborted = true;
        if (context.escalated) {
          context.escalated = false;
          this.releaseEscalation(destinationKey(ssh));
        }
        if (context.paneId) await this.abortTeardown(context);
        throw new WorkflowError(`agent "${label}" aborted`, WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
          agentLabel: label,
        });
      }
      throw this.mapError(error, context);
    } finally {
      // Escalated blocked calls keep their tab (and pane, and agent) alive for
      // the human the escalation points at — SPEC D15. keepWorkspace does the
      // same for finished tabs (so a review workspace is not empty), except
      // abort still tears the cancelled tab down.
      const keepTab = context.escalated || (this.keepWorkspace && !context.aborted);
      if (context.tabId && !keepTab && context.transport) {
        await this.closeTab(context.transport, context.tabId);
      }
    }
  }

  /**
   * Close each destination's run workspace (tearing down any leftover
   * tabs/panes with it) and then every transport. Idempotent; workspace
   * teardown is best-effort so a dead server never turns shutdown into a crash.
   *
   * EXCEPT for destinations where the escalate policy left blocked workers
   * open, or when keepWorkspace is set: those tabs live in that destination's
   * workspace, and closing it would kill exactly the panes a human was told to
   * keep (SPEC D15, keepWorkspace). Those workspaces are left alive (only the
   * transports close — which severs no panes) and remain findable by their
   * workspace label (the caller's workspaceLabel, else `flow/<runId>`).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const [key, promise] of this.workspacePromises) {
        if (this.keepWorkspace || (this.escalations.get(key) ?? 0) > 0) continue;
        const transport = this.transports.get(key);
        if (!transport) continue;
        const workspaceId = this.workspaceIds.get(key) ?? (await promise.catch(() => undefined));
        if (workspaceId) await this.closeWorkspace(transport, workspaceId);
      }
    } catch {
      // Best-effort; a workspace (or a server) may already be gone.
    } finally {
      for (const transport of this.transports.values()) {
        try {
          await transport.close();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  // ── Destination (SPEC D13): local socket or one ssh host ───────────────────

  /**
   * The call's ssh target, or undefined for the local session. `ssh` is an
   * ssh destination — a name `ssh` already accepts — and nothing
   * else: there is no inventory to look it up in, so a blank one is an author
   * error rather than a silent fall back to local.
   *
   * A call-site cwd (worktree isolation) cannot travel: the path only exists
   * on the engine's host, so combining it with `ssh` is an explicit validation
   * error, not a silent degrade.
   */
  private resolveSshTarget(options: AgentRunOptions, label: string): string | undefined {
    const fail = (message: string): never => {
      throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false, agentLabel: label });
    };
    if (options.ssh === undefined) return undefined;
    const target = typeof options.ssh === "string" ? options.ssh.trim() : "";
    if (!target) {
      return fail(
        `agent "${label}": ssh ${JSON.stringify(options.ssh)} is not a host name — pass a name ` +
          "`ssh` already accepts, or omit ssh to run on this computer.",
      );
    }
    if (options.cwd !== undefined) {
      return fail(
        `agent "${label}": worktree isolation (a call-site cwd) is not supported over ssh — ` +
          `${options.cwd} only exists on this computer. Drop the isolation or drop ssh: "${target}".`,
      );
    }
    return target;
  }

  private releaseEscalation(key: string): void {
    const count = this.escalations.get(key) ?? 0;
    this.escalations.set(key, Math.max(0, count - 1));
  }

  /** The destination's transport, created on the first call there (SPEC D13). */
  private transportFor(ssh: string | undefined): HerdrTransport {
    const key = destinationKey(ssh);
    const existing = this.transports.get(key);
    if (existing) return existing;
    const created = this.transportFactory
      ? this.transportFactory(ssh)
      : ssh === undefined
        ? new LocalHerdrTransport({ socketPath: this.socketPath, defaultTimeoutMs: this.requestTimeoutMs })
        : new SshHerdrTransport({
            target: ssh,
            session: this.session,
            requestTimeoutMs: this.requestTimeoutMs,
          });
    this.transports.set(key, created);
    return created;
  }

  // ── Phase 1: topology (SPEC D11 — workspace per run per destination) ───────

  /**
   * The run's single workspace ON THIS DESTINATION, created once and shared by
   * every call placed there. No per-call abort signal on purpose: the
   * workspace is a RUN-scoped resource, and cancelling it with the first
   * call's signal would fail every concurrent caller sharing the memoized
   * promise.
   */
  private ensureWorkspace(key: string, transport: HerdrTransport, runId: string): Promise<string> {
    const existing = this.workspacePromises.get(key);
    if (existing) return existing;
    const created = transport
      .request(
        "workspace.create",
        // The sidebar label leads with the WORKFLOW's name when the caller
        // provided one (run.js: `<meta.name> · <last4>`); `flow/<runId>` is
        // the label for library users who set none. Same label on every
        // destination, including ssh workers.
        { label: this.workspaceLabel ?? `flow/${runId}`, focus: false },
        {
          timeoutMs: this.requestTimeoutMs,
          // If the reply arrives only after we timed out, the workspace
          // exists server-side but its id never reached us — close the
          // orphan from the late reply, the only place that id will appear.
          // (The ssh transport cannot deliver late replies; its orphans are
          // bounded by the session's workspace labels.)
          onLateResult: (late) => {
            const orphanId = (late as { workspace?: { workspace_id?: unknown } })?.workspace?.workspace_id;
            if (typeof orphanId === "string" && orphanId) void this.closeWorkspace(transport, orphanId);
          },
        },
      )
      .then((result) => {
        const workspaceId = (result as { workspace?: { workspace_id?: unknown } })?.workspace?.workspace_id;
        if (typeof workspaceId !== "string" || !workspaceId) {
          throw new HerdrWorkflowError(
            "workspace.create returned no workspace id",
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            "workspace_create_no_id",
            { recoverable: true },
          );
        }
        this.workspaceIds.set(key, workspaceId);
        return workspaceId;
      });
    // Reset the memo on failure so a later call can retry, while every
    // caller of THIS attempt still sees the failure.
    created.catch(() => {
      if (this.workspacePromises.get(key) === created) this.workspacePromises.delete(key);
    });
    this.workspacePromises.set(key, created);
    return created;
  }

  private async openTab(
    context: CallContext,
    env: FlowCallEnv,
    options: AgentRunOptions,
    signal?: AbortSignal,
  ): Promise<{ tabId: string; paneId: string }> {
    const transport = context.transport!;
    const workspaceId = await this.ensureWorkspace(destinationKey(context.ssh), transport, context.runId);
    this.throwIfAborted(signal, context.label);
    const tabEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) tabEnv[key] = value;
    // Call-site cwd (an isolated worktree) wins locally; otherwise the runner
    // default (the workflow's cwd). An ssh tab gets NO cwd — it opens in the
    // remote HOME, because every path we know names a directory on this host.
    const cwd = context.ssh ? undefined : (options.cwd ?? this.defaultCwd);
    const result = (await transport.request(
      "tab.create",
      {
        workspace_id: workspaceId,
        ...(cwd ? { cwd } : {}),
        focus: false,
        // The tab label carries the agent's identity so the tab list is the
        // run's progress view (SPEC D11/D16).
        ...(options.label ? { label: options.label } : {}),
        env: tabEnv,
      },
      {
        timeoutMs: this.requestTimeoutMs,
        signal,
        // If this request times out / aborts client-side AFTER the frame
        // reached the server, the tab exists server-side but its id never
        // reached us — context.tabId stays unset and the finally-block
        // tab.close can't run. The late reply is the only place that id will
        // ever appear; close the orphaned tab from it.
        onLateResult: (late) => {
          const orphanId = (late as { tab?: { tab_id?: unknown } })?.tab?.tab_id;
          if (typeof orphanId === "string" && orphanId) void this.closeTab(transport, orphanId);
        },
      },
    )) as { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
    // Never predict ids — always the response's `tab` + `root_pane`
    // (reference §1 phase 1; tab.create result shape measured live).
    const tabId = result?.tab?.tab_id;
    const paneId = result?.root_pane?.pane_id;
    if (typeof tabId !== "string" || !tabId || typeof paneId !== "string" || !paneId) {
      throw new HerdrWorkflowError(
        "tab.create returned no tab/root-pane id",
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        "tab_create_no_id",
        { recoverable: true },
      );
    }
    return { tabId, paneId };
  }

  // ── Phase 2: launch ────────────────────────────────────────────────────────

  private async startAgent(context: CallContext, kind: string, args: string[], signal: AbortSignal | undefined): Promise<void> {
    const transport = context.transport!;
    const name = context.agentName!;
    const paneId = context.paneId!;
    for (let attempt = 0; ; attempt++) {
      try {
        await transport.request(
          "agent.start",
          {
            name,
            kind,
            pane_id: paneId,
            // The kind's permission flags plus --model/--effort (SPEC D4).
            // Omitted entirely when empty, matching the schema's
            // skip_serializing_if.
            ...(args.length > 0 ? { args } : {}),
            timeout_ms: this.agentStartTimeoutMs,
          },
          { timeoutMs: this.agentStartTimeoutMs + this.requestTimeoutMs, signal },
        );
        break;
      } catch (error) {
        // agent_pane_busy: the fresh pane's shell may not be at its prompt yet
        // (measured V1) — retry with backoff. agent_not_ready is a PLACEMENT
        // failure (e.g. a first-launch trust prompt detected as blocked during
        // startup) and is never retried at this layer.
        if (
          error instanceof HerdrRpcError &&
          error.code === "agent_pane_busy" &&
          attempt < this.paneBusyRetries &&
          !signal?.aborted
        ) {
          await sleep(this.paneBusyDelayMs * (attempt + 1));
          continue;
        }
        throw this.mapError(error, context);
      }
    }
    try {
      await this.awaitAgentReady(transport, name, paneId, signal);
    } catch (error) {
      throw this.mapError(error, context);
    }
  }

  /**
   * agent.start only TYPES the launch command into the pane's shell and
   * returns immediately (launch_pending) — the server does not block until
   * the CLI is up. Readiness is a client-side agent.get poll, mirroring
   * herdr's own CLI (src/cli/agent.rs wait_for_named_agent): settled
   * (`idle`/`done`) + interactive_ready is started; `blocked` during startup
   * is the placement failure agent_not_ready (a first-launch trust prompt);
   * settled without launch_pending means the process exited before becoming
   * interactive. Prompting before this poll passes fails agent_not_ready
   * ("not an active named agent") — measured live on 0.8.0.
   *
   * Over the ssh transport `herdr agent start` already ran this same poll on
   * the remote host before returning, so the first probe here simply
   * confirms readiness — one cheap round trip, one code path.
   */
  private async awaitAgentReady(
    transport: HerdrTransport,
    name: string,
    paneId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.agentStartTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error(`agent readiness poll for "${name}" aborted`);
      let agent: {
        agent_status?: unknown;
        agent?: unknown;
        interactive_ready?: unknown;
        launch_pending?: unknown;
      } | undefined;
      try {
        const info = (await transport.request(
          "agent.get",
          { target: name },
          { timeoutMs: this.requestTimeoutMs, signal },
        )) as { agent?: typeof agent };
        agent = info?.agent;
      } catch (error) {
        if (signal?.aborted) throw error;
        // The name may not resolve while the launch is still pending; fall
        // back to the pane id like the herdr CLI does, and keep polling on
        // lookup errors.
        try {
          const info = (await transport.request(
            "agent.get",
            { target: paneId },
            { timeoutMs: this.requestTimeoutMs, signal },
          )) as { agent?: typeof agent };
          agent = info?.agent;
        } catch {
          agent = undefined;
        }
      }
      if (agent) {
        const status = typeof agent.agent_status === "string" ? agent.agent_status : undefined;
        if (status === "blocked") {
          throw new HerdrRpcError(
            "agent.start",
            "agent_not_ready",
            `agent ${name} is blocked during startup and is not ready for prompts`,
          );
        }
        // The detected kind (AgentInfo.agent) is deliberately NOT compared
        // against the requested kind: the server accepts kind ALIASES
        // ("claude-code", "cursor-agent", "devin-cli", …, herdr
        // src/detect/mod.rs lookup_agent) but reports the CANONICAL detection
        // label ("claude", "cursor", …), so a raw equality check fails every
        // alias deterministically. Herdr's own CLI normalizes through its
        // alias table before comparing — a table we must not duplicate (SPEC
        // D14). The server already rejected unsupported kinds at agent.start
        // (unsupported_agent_kind), and this pane is a fresh tab the runner
        // itself launched into, so whatever gets detected IS the requested
        // CLI under its canonical name.
        if (status === "idle" || status === "done") {
          if (agent.interactive_ready === true) return;
          if (agent.launch_pending !== true) {
            throw new HerdrRpcError("agent.start", "agent_start_failed", "agent process exited before becoming interactive");
          }
        }
        // "working"/"unknown" (or settled-but-pending): still starting up.
      }
      if (Date.now() >= deadline) {
        throw new HerdrRpcError(
          "agent.start",
          "timeout",
          `agent ${name} did not become interactive within ${this.agentStartTimeoutMs}ms`,
        );
      }
      await sleep(this.agentReadyPollMs);
    }
  }

  // ── Phase 3: the turn ──────────────────────────────────────────────────────

  private async promptAgent(context: CallContext, prompt: string, options: AgentRunOptions, signal?: AbortSignal): Promise<string | undefined> {
    const transport = context.transport!;
    const agentName = context.agentName!;
    const text = this.buildPromptText(prompt, options.instructions, options.schema);
    // Prompt + wait in ONE request (closes the fast-agent working->idle race);
    // always all three settled states — a headless session reports `done`, not
    // `idle`, essentially forever (reference §2).
    const waitTimeoutMs = options.timeoutMs ?? this.promptWaitTimeoutMs;
    const params = {
      target: agentName,
      text,
      wait: { until: ["idle", "done", "blocked"], timeout_ms: waitTimeoutMs },
    };
    const requestOptions = { timeoutMs: waitTimeoutMs + this.requestTimeoutMs, signal };
    let retriedAfterStall = false;
    for (;;) {
      try {
        // Success shape: {type:"agent_prompted", agent: AgentInfo} — the
        // settled status is agent.agent_status (schema/response.rs).
        const result = (await transport.request("agent.prompt", params, requestOptions)) as {
          agent?: { agent_status?: unknown };
        };
        const status = result?.agent?.agent_status;
        return typeof status === "string" ? status : undefined;
      } catch (error) {
        // agent_prompt_stalled: the keystroke landed somewhere that did not
        // start a turn (unrecognized modal, composer not ready). Universal
        // policy (reference §5): esc, retry exactly once, then fail recoverable.
        if (error instanceof HerdrRpcError && error.code === "agent_prompt_stalled" && !retriedAfterStall && !signal?.aborted) {
          retriedAfterStall = true;
          await this.sendKeys(context, ["esc"], signal);
          continue;
        }
        throw error;
      }
    }
  }

  private buildPromptText(prompt: string, instructions?: string, schema?: AgentRunOptions["schema"]): string {
    const parts = [OUTPUT_CONTRACT_PREAMBLE];
    if (schema != null) {
      // Reproduce the schema inline. The preamble only points at the
      // HERDR_FLOW_SCHEMA file, and (measured live) agents often skip reading
      // it and write `result` as a plain string — a SCHEMA_NONCOMPLIANCE halt.
      // Inlining removes the extra hop without changing the §6 preamble.
      parts.push(
        `The JSON Schema from HERDR_FLOW_SCHEMA is reproduced here; \`result\` MUST validate against it:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
      );
    }
    if (instructions?.trim()) parts.push(instructions.trim());
    parts.push(prompt);
    return parts.join("\n\n");
  }

  // ── Phase 4: harvest ───────────────────────────────────────────────────────

  private async harvest(outPath: string, context: CallContext, options: AgentRunOptions): Promise<unknown> {
    const transport = context.transport!;
    const agentName = context.agentName!;
    const label = context.label;
    const raw = await this.readOutputFile(transport, outPath);
    if (raw !== undefined) {
      return validateOutputPayload(raw, { schema: options.schema ?? undefined, agentLabel: label });
    }
    // File missing after the wait resolved → do not trust the wait (reference
    // §6 ladder step 1, §2). Herdr's blocked detection is strict, so a false
    // `idle`/`done` — an unrecognized permission prompt — is the primary
    // silent-wrong-answer source: without this re-check the degraded fallback
    // would happily return the y/n prompt's own screen text as the "result".
    // Re-read agent.get (and agent.explain for diagnostics); if the agent is
    // actually blocked, apply the blocked policy; only when it is genuinely
    // settled take the degraded path.
    let probe = await this.probeAgent(context, options.signal);
    if (probe.status === "blocked") throw await this.raiseBlocked(context, options, probe.explanation);
    if (probe.status === "working" || probe.status === "unknown") {
      // FALSE SETTLE (measured live with claude on 0.8.0): screen detection
      // can flap through a settled state mid-turn, resolving the prompt wait
      // while the agent is demonstrably still working — tearing down here
      // would kill it mid-answer. Re-arm one full wait and re-poll the file
      // before judging.
      options.onHistory?.([
        {
          type: "diagnostic",
          code: "false_settle_rewait",
          message: "prompt wait resolved but the agent is still working; re-arming the wait",
          agent: agentName,
          ...(probe.status !== undefined ? { agentStatus: probe.status } : {}),
        },
      ]);
      const waitTimeoutMs = options.timeoutMs ?? this.promptWaitTimeoutMs;
      try {
        await transport.request(
          "agent.wait",
          { target: agentName, until: ["idle", "done", "blocked"], timeout_ms: waitTimeoutMs },
          { timeoutMs: waitTimeoutMs + this.requestTimeoutMs, signal: options.signal },
        );
      } catch {
        // A failed re-wait falls through to the file re-poll and re-probe:
        // the file is still the source of truth.
      }
      const retried = await this.readOutputFile(transport, outPath);
      if (retried !== undefined) {
        return validateOutputPayload(retried, { schema: options.schema ?? undefined, agentLabel: label });
      }
      probe = await this.probeAgent(context, options.signal);
      if (probe.status === "blocked") throw await this.raiseBlocked(context, options, probe.explanation);
    }
    // Degraded fallback — only when no schema is in play (a screen scrape can
    // never satisfy a schema; SCHEMA_NONCOMPLIANCE must never be papered over).
    // Deliberately source:"visible": measured working headless, never triggers
    // the alt-screen mouse-scroll path, cannot return agent_not_idle (§6).
    if (options.schema == null) {
      try {
        // {type:"pane_read", read: PaneReadResult} — the text is read.text.
        const read = (await transport.request(
          "agent.read",
          { target: agentName, source: "visible", format: "text", strip_ansi: true },
          { timeoutMs: this.requestTimeoutMs, signal: options.signal },
        )) as { read?: { text?: unknown } };
        const text = typeof read?.read?.text === "string" ? read.read.text.trim() : "";
        if (text) {
          options.onHistory?.([
            {
              type: "harvest",
              fallbackReason: "output_file_missing",
              source: "visible",
              agent: agentName,
              ...(probe.status !== undefined ? { agentStatus: probe.status } : {}),
            },
          ]);
          return text;
        }
      } catch {
        // Fall through to the missing-output error below.
      }
    }
    throw new OutputFileMissingError(outPath, label);
  }

  /**
   * Best-effort state re-check after a missing output file: agent.get for the
   * settled status, agent.explain for the detection rationale (diagnostics).
   * Failures return {} — an unreachable/gone agent falls through to the
   * degraded path rather than masking the harvest outcome.
   */
  private async probeAgent(context: CallContext, signal?: AbortSignal): Promise<{ status?: string; explanation?: string }> {
    const transport = context.transport!;
    const agentName = context.agentName!;
    let status: string | undefined;
    let explanation: string | undefined;
    try {
      // {type:"agent_info", agent: AgentInfo} — status is agent.agent_status.
      const info = (await transport.request(
        "agent.get",
        { target: agentName },
        { timeoutMs: this.requestTimeoutMs, signal },
      )) as { agent?: { agent_status?: unknown } };
      const value = info?.agent?.agent_status;
      if (typeof value === "string") status = value;
    } catch {
      // Best-effort.
    }
    try {
      // {type:"agent_explain", explain: <detection-rationale JSON>}.
      const explain = (await transport.request(
        "agent.explain",
        { target: agentName },
        { timeoutMs: this.requestTimeoutMs, signal },
      )) as { explain?: unknown };
      const value = explain?.explain;
      if (typeof value === "string" && value.trim()) explanation = value.trim();
      else if (value !== undefined && value !== null) explanation = JSON.stringify(value);
    } catch {
      // Best-effort.
    }
    return { status, explanation };
  }

  /**
   * Apply the onBlocked policy (SPEC D15) to a call whose worker stopped to
   * ask a human something. Both policies fail the call recoverable with the
   * distinct HERDR_BLOCKED code; they differ in what happens to the pane, and
   * `paneClosed` in the error's details always reflects reality:
   *
   * - "fail" (default): the run()-level finally tears the tab down (killing
   *   the blocked agent with its pane) before the caller sees this error, so
   *   `paneClosed: true` and the tab/pane ids are diagnostics only.
   * - "escalate": the tab is deliberately left OPEN (context.escalated
   *   suppresses the finally teardown, and close() then leaves that
   *   destination's workspace alive), an escalation record is emitted through
   *   onHistory, a pointer is persisted at
   *   `<stateDir>/<runId>/escalation-<call>.json` on the ENGINE's host, and
   *   the error message carries the human-runnable attach command — `herdr
   *   --session <session> agent attach <agent>` locally, wrapped in `ssh -t
   *   <target> '…'` for an ssh worker (a view of other hosts is a printed
   *   command, not a screen — SPEC D16).
   */
  private async raiseBlocked(
    context: CallContext,
    options: AgentRunOptions,
    explanation?: string,
  ): Promise<HerdrWorkflowError> {
    const identity = {
      ...(context.ssh !== undefined ? { ssh: context.ssh } : {}),
      tabId: context.tabId,
      paneId: context.paneId,
      agentName: context.agentName,
      ...(explanation !== undefined ? { explanation } : {}),
    };
    if (this.onBlocked !== "escalate") {
      return new HerdrWorkflowError(
        `agent "${context.label}" is blocked on an approval/question prompt (agent ${context.agentName}, pane ${context.paneId}; the tab is torn down with this failure)`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        HERDR_BLOCKED,
        { recoverable: true, agentLabel: context.label, details: { ...identity, paneClosed: true } },
      );
    }

    context.escalated = true;
    const key = destinationKey(context.ssh);
    this.escalations.set(key, (this.escalations.get(key) ?? 0) + 1);
    const attachCommand = this.attachCommand(context);
    const escalation: Record<string, unknown> = {
      type: "escalation",
      code: "agent_blocked_escalated",
      runId: context.runId,
      callIndex: context.callIndex,
      label: context.label,
      session: this.session,
      workspaceId: this.workspaceIds.get(key),
      attachCommand,
      ...identity,
    };
    // Persisted pointer in the run's LOCAL state dir so a human — or a later
    // resume — can find the open pane after this process exits, wherever the
    // pane itself lives. Best-effort: a failed write must not mask the
    // blocked outcome itself.
    const escalationPath = path.join(this.stateDir, context.runId, `escalation-${context.callIndex}.json`);
    try {
      await mkdir(path.dirname(escalationPath), { recursive: true });
      await writeFile(escalationPath, `${JSON.stringify(escalation, null, 2)}\n`);
      escalation.escalationPath = escalationPath;
    } catch {
      // Best-effort.
    }
    options.onHistory?.([{ ...escalation }]);
    return new HerdrWorkflowError(
      `agent "${context.label}" is blocked on an approval/question prompt and was left OPEN for escalation ` +
        `(agent ${context.agentName}, pane ${context.paneId}, host ${context.ssh ?? "local"}). Answer it with: ${attachCommand}`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      HERDR_BLOCKED,
      {
        // Recoverable (the run goes on; the call collapses to null) but NOT
        // retryable: the escalated worker deliberately keeps its pane (D15),
        // so an engine retry would open a duplicate worker for the same
        // logical call while a human is still answering the first.
        recoverable: true,
        retryable: false,
        agentLabel: context.label,
        details: {
          ...identity,
          paneClosed: false,
          attachCommand,
          ...(escalation.escalationPath !== undefined ? { escalationPath } : {}),
        },
      },
    );
  }

  /**
   * The human-runnable command that opens the blocked worker's pane (D16).
   * Local calls: in "default" localSessionMode the pane lives in the user's
   * OWN session, so the command must omit --session — with it, herdr would
   * target the (typically not running) worker session and the printed
   * escalation instruction would be unfollowable. ssh workers always run under
   * the named worker session, mode or no mode, and reach herdr through a login
   * shell because plain `ssh host 'herdr …'` has no PATH (SPEC D13).
   */
  private attachCommand(context: CallContext): string {
    const attach = `agent attach ${context.agentName}`;
    if (context.ssh === undefined) {
      return this.localSessionMode === "default"
        ? `herdr ${attach}`
        : `herdr --session ${this.session} ${attach}`;
    }
    return `ssh -t ${context.ssh} ${shellQuote(`bash -lc ${shellQuote(`herdr --session ${this.session} ${attach}`)}`)}`;
  }

  /**
   * Poll for the output file for up to outputSettleMs after the wait
   * resolved — through the call's transport, because the file lives on the
   * worker's host (SPEC Q11).
   */
  private async readOutputFile(transport: HerdrTransport, outPath: string): Promise<string | undefined> {
    const deadline = Date.now() + this.outputSettleMs;
    for (;;) {
      const raw = await transport.readTextFile(outPath);
      if (raw !== undefined && raw.trim()) return raw;
      if (Date.now() >= deadline) return undefined;
      await sleep(Math.min(OUTPUT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  // ── Phase 5 + cancellation: teardown ───────────────────────────────────────

  private async abortTeardown(context: CallContext): Promise<void> {
    await this.sendKeys(context, ["esc"]);
    await sleep(this.abortSettleMs);
    await this.sendKeys(context, ["ctrl+c"]);
  }

  /** Best-effort key delivery; teardown paths must not fail on a dead agent. */
  private async sendKeys(context: CallContext, keys: string[], signal?: AbortSignal): Promise<void> {
    try {
      await context.transport!.request(
        "agent.send_keys",
        { target: context.agentName!, keys },
        { timeoutMs: this.requestTimeoutMs, signal },
      );
    } catch {
      // Best-effort.
    }
  }

  private async closeTab(transport: HerdrTransport, tabId: string): Promise<void> {
    try {
      // No signal here on purpose: the tab (and with it the agent's pane)
      // must be freed even when the call was aborted.
      await transport.request("tab.close", { tab_id: tabId }, { timeoutMs: this.requestTimeoutMs });
    } catch {
      // Best-effort; the tab may already be gone.
    }
  }

  private async closeWorkspace(transport: HerdrTransport, workspaceId: string): Promise<void> {
    try {
      await transport.request("workspace.close", { workspace_id: workspaceId }, { timeoutMs: this.requestTimeoutMs });
    } catch {
      // Best-effort; the workspace may already be gone.
    }
  }

  // ── Validation and error mapping ───────────────────────────────────────────

  private throwIfAborted(signal: AbortSignal | undefined, label: string): void {
    if (signal?.aborted) {
      throw new WorkflowError(`agent "${label}" aborted`, WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: true,
        agentLabel: label,
      });
    }
  }

  /**
   * Map a Herdr failure onto the engine's taxonomy (reference §1 failure
   * table + §5). Herdr RPC codes get pre-classified WorkflowErrors carrying
   * the code as `herdrCode`; everything else goes through the engine's
   * wrapError seam (which classifies abort-like, timeout-like, and
   * provider-limit-like errors itself).
   */
  private mapError(error: unknown, context: CallContext): WorkflowError {
    if (error instanceof WorkflowError) return error;
    if (error instanceof HerdrRpcError) {
      const details = {
        ...(context.ssh !== undefined ? { ssh: context.ssh } : {}),
        tabId: context.tabId,
        paneId: context.paneId,
        agentName: context.agentName,
      };
      const base = { agentLabel: context.label, details };
      switch (error.code) {
        case "unsupported_agent_kind":
          // Deterministic author error: retrying the same kind fails identically.
          return new HerdrWorkflowError(
            `agent "${context.label}": unsupported agent kind (${error.message})`,
            WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
            error.code,
            { recoverable: false, ...base },
          );
        case "remote_command_too_large":
          // Synthesized by SshHerdrTransport: the prompt (plus preamble and
          // inlined schema) exceeds the remote kernel's per-argument exec
          // limit. Deterministic per call — retrying the same prompt fails
          // identically — and only a script edit can shrink it.
          return new HerdrWorkflowError(
            `agent "${context.label}": ${error.message}`,
            WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
            error.code,
            { recoverable: false, ...base },
          );
        case "timeout":
          return new HerdrWorkflowError(
            `agent "${context.label}" timed out: ${error.message}`,
            WorkflowErrorCode.AGENT_TIMEOUT,
            error.code,
            { recoverable: true, ...base },
          );
        case "agent_prompt_stalled":
          return new HerdrWorkflowError(
            `agent "${context.label}": prompt produced no state change even after an esc retry (${error.message})`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            error.code,
            { recoverable: true, ...base },
          );
        case "agent_not_ready":
          // Placement-level failure, NOT a retryable agent error (reference §1
          // phase 2): the cause (e.g. a first-launch trust prompt) is
          // deterministic per (host, kind, repo), so an engine-level retry
          // replays it identically and a recoverable classification would then
          // silently collapse the call to null. Non-recoverable surfaces the
          // placement problem to the operator instead.
          return new HerdrWorkflowError(
            `agent "${context.label}": placement failed — agent not ready (likely a first-launch trust prompt; ${error.message})`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            error.code,
            { recoverable: false, ...base },
          );
        default:
          // agent_pane_busy (retries exhausted), agent_name_taken,
          // agent_not_running, agent_not_idle, unknown codes: recoverable —
          // the engine may retry the whole call or collapse it to null.
          return new HerdrWorkflowError(
            `agent "${context.label}": herdr call failed with ${error.code}: ${error.message}`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            error.code,
            { recoverable: true, ...base },
          );
      }
    }
    return wrapError(error, { agentLabel: context.label });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map key for one destination's transport, workspace, and escalation count. */
function destinationKey(ssh: string | undefined): string {
  return ssh === undefined ? "local" : `ssh:${ssh}`;
}

/** Extract the engine's runId from `workflow:<runId> <label>` session names. */
function runIdFromSessionName(sessionName: string | undefined): string | undefined {
  const match = sessionName?.match(/^workflow:(\S+)\s/);
  return match?.[1];
}

/**
 * Build an agent.start name: `flow-<run>-<call>`, fitted to Herdr's
 * `[a-z][a-z0-9_-]{0,31}` constraint (the run part is sanitized and trimmed;
 * the call index — the uniqueness carrier — is always kept whole).
 */
function buildAgentName(runId: string, callIndex: number): string {
  const suffix = `-${callIndex}`;
  const budget = 32 - "flow-".length - suffix.length;
  const base = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, Math.max(1, budget));
  const name = `flow-${base || "run"}${suffix}`;
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : `flow-run${suffix}`.slice(0, 32);
}
