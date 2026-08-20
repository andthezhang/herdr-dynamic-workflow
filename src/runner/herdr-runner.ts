/**
 * HerdrAgentRunner: the WorkflowAgentRunner backend that runs each agent()
 * call as a real coding-agent CLI inside a Herdr pane, per
 * reference/herdr-runtime-support.md §1 and SPEC D11 topology (one workspace
 * per run PER MACHINE, one tab per agent call, one pane per tab, never split —
 * a fresh headless worker session has ZERO panes, so there is nothing to
 * split from):
 *
 *   workspace.create (once per runner per machine, label `flow/<runId>`,
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
 * M2 additions (SPEC D4/D12/D15): a call's model/tier/effort resolve through
 * fleet.toml's [runtime.<kind>] tables into agent.start args + tab env —
 * explicit values that cannot be resolved are SCRIPT_VALIDATION_ERROR before
 * any socket call; the resolved args/env are folded into the engine's call
 * hash via callIdentity(). Blocked calls follow the configured on_blocked
 * policy: "fail" tears down; "escalate" leaves the pane open, emits an
 * escalation record + persisted pointer, and fails recoverable with the
 * attach command.
 *
 * M3 additions (SPEC D12/D13): PLACEMENT and REMOTE MACHINES. Every call is
 * placed on exactly one fleet machine before any Herdr traffic:
 *
 * - `machine: undefined` -> the machine of least current occupancy among
 *   machines that declare the call's kind (ties break in fleet declaration
 *   order, so the implicit single-machine fleet always places "local").
 * - `machine: "name"` / `{name}` -> exactly that machine; `{tag}` -> least
 *   occupied among machines carrying the tag. Naming an unconfigured
 *   machine/tag is SCRIPT_VALIDATION_ERROR, never a silent fallback (D12).
 * - Per-machine slots are enforced with a synchronous check-and-increment
 *   (no await between reading and reserving — SPEC D5's overshoot rule) and
 *   released in the call's finally. A blocked call that ESCALATES keeps its
 *   slot: the worker still holds its pane, and D15 says escalate does not
 *   free capacity.
 * - Each machine gets one HerdrTransport: local machines the NDJSON socket,
 *   remote machines the plain herdr CLI over ssh at the machine's declared
 *   absolute herdr_bin (D13, ssh-transport.ts). HERDR_FLOW_OUT for a remote
 *   call is a REMOTE path (under remoteStateDir, POSIX-joined) read back
 *   through the same transport; remote tabs default to the machine's declared
 *   repo path (basename-matched against the workflow's cwd, else the first
 *   declared repo), else the remote HOME.
 * - Worktree isolation (a call-site cwd) is NOT supported on remote machines
 *   in this milestone: requesting it with a placement that has no local
 *   candidate is SCRIPT_VALIDATION_ERROR — an explicit error, never a silent
 *   degrade.
 * - Hash identity (SPEC D6, engine side): the engine hashes the call's
 *   `machine` OPTION — the stable machine NAME (or {tag} selector) the script
 *   asked for, with an implicit placement hashing exactly as before M3 — so
 *   existing journals keep replaying and a dynamically-chosen machine never
 *   makes the same script hash differently between runs. This runner adds no
 *   machine data to callIdentity().
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
  defaultFleetConfig,
  type FleetConfig,
  type MachineConfig,
  type OnBlockedPolicy,
  type ResolvedRuntime,
  resolveRuntime,
} from "../fleet/config.js";
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
 * kind wherever it arrives — call-site `kind`, an agentType's kind, the
 * runner/[defaults] default kind, or a fleet machine's declared `kinds` —
 * with a SCRIPT_VALIDATION_ERROR raised BEFORE any pane/socket work. Both
 * local and remote calls pass through here via resolveCallRuntime; config
 * routes are checked at runner construction. The kind is normalized the way
 * herdr's server normalizes it (normalizeAgentKind), so spellings herdr
 * accepts as cline ("Cline", "cline.exe") cannot bypass the guard.
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

export interface HerdrAgentRunnerOptions {
  /**
   * Path to the WORKFLOW session's socket on the LOCAL machine, constructed
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
   * Base dir for REMOTE run output files (SPEC Q11): the agent on a remote
   * machine writes `<remoteStateDir>/<runId>/<callIndex>.json` on ITS host,
   * harvested back over ssh. Default "/tmp/herdr-flow" — a path that exists
   * and is writable on any Unix host without knowing its $TMPDIR.
   */
  remoteStateDir?: string;
  /**
   * Per-runner defaults. `kind` is used when a call sets none. `cwd` is the
   * working directory for LOCAL agent tabs whose call sets none (normally the
   * workflow's own cwd) — without it tab.create falls back to the server
   * process's home directory, where the agent cannot see the project (and,
   * measured live, claude drifted into answering inline instead of honoring
   * the output-file contract). Remote tabs never receive this local path:
   * they default to the machine's declared repo, else the remote HOME.
   */
  defaults: { kind: string; cwd?: string };
  /**
   * Label for the run's workspace on every machine (SPEC D11) — the sidebar
   * name a human sees. run.js passes the workflow's own name
   * (`<meta.name> · <last-4-of-runId>`) so concurrent runs stay tellable
   * apart while truncation keeps the name visible. Falls back to
   * `flow/<runId>` when absent.
   */
  workspaceLabel?: string;
  /**
   * Fleet/runtime configuration (SPEC D4/D12/D15): the [runtime.<kind>]
   * tables a call's model/tier/effort resolve through into agent.start args +
   * tab env, the machine list placement draws from, and the on_blocked
   * policy. Defaults to the implicit fleet (single local machine, empty
   * runtime tables, on_blocked "fail").
   */
  fleet?: FleetConfig;
  /**
   * The worker session's name, used both to print human-runnable commands
   * (`herdr --session <name> agent attach <agent>`) in escalation records and
   * as the session driven on REMOTE machines. Defaults to the socket path's
   * session directory name (~/.config/herdr/sessions/<NAME>/herdr.sock).
   */
  session?: string;
  /**
   * Where socketPath's LOCAL session actually lives (run.js/resume.js pass
   * the resolved placement mode): "default" means socketPath is the USER'S
   * OWN default session — reachable with plain `herdr` and NOT with
   * `--session <name>` — while "worker" (the default) means the named worker
   * session at ~/.config/herdr/sessions/<session>/. Escalation attach
   * commands for local machines depend on this: in "default" mode the
   * blocked pane is in the user's own session, so the printed command must
   * omit --session (a `herdr --session flow …` command would target a
   * different — typically not even running — session). Remote machines are
   * unaffected: they are always driven under the named worker session.
   */
  localSessionMode?: "default" | "worker";
  /**
   * Test seam: build the transport for one fleet machine. Defaults to
   * LocalHerdrTransport (socketPath) for local machines and SshHerdrTransport
   * (machine.transport.ssh + machine.herdrBin + session) for remote ones.
   */
  transportFactory?: (machine: MachineConfig) => HerdrTransport;
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
  /** The fleet machine this call was placed on (SPEC D12). */
  machine: MachineConfig;
  /** True when the placed machine is reached over ssh (SPEC D13). */
  remote: boolean;
  transport?: HerdrTransport;
  tabId?: string;
  paneId?: string;
  agentName?: string;
  /**
   * Set when the on_blocked "escalate" policy claimed this call's tab: the
   * blocked worker is deliberately left OPEN for a human, so the finally-block
   * teardown must NOT close it — and the machine SLOT stays held, because the
   * worker still occupies its pane (SPEC D15: escalate does not free capacity).
   */
  escalated?: boolean;
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
  private readonly transportFactory?: (machine: MachineConfig) => HerdrTransport;
  private readonly requestTimeoutMs: number;
  private readonly promptWaitTimeoutMs: number;
  private readonly agentStartTimeoutMs: number;
  private readonly paneBusyRetries: number;
  private readonly paneBusyDelayMs: number;
  private readonly agentReadyPollMs: number;
  private readonly outputSettleMs: number;
  private readonly abortSettleMs: number;
  private readonly fleet: FleetConfig;
  private readonly onBlocked: OnBlockedPolicy;
  /** Worker session name for human-runnable attach commands in escalations. */
  private readonly session: string;
  private readonly localSessionMode: "default" | "worker";
  /** One transport per machine NAME, created lazily on first placement there. */
  private readonly transports = new Map<string, HerdrTransport>();
  /**
   * Live occupancy per machine name (SPEC D12: capacity is declared, live
   * occupancy is counted here). Incremented synchronously with the free-slot
   * check — no await between reading and reserving — and decremented in each
   * call's finally (except escalated calls, which keep holding — D15).
   *
   * KNOWN LIMITATION: this accounting is per ENGINE PROCESS, not per machine.
   * The atomic check-and-increment that SPEC D5 requires cannot await a
   * server-side agent count, so a fresh process (a resume while a previous
   * execution's escalated panes still hold their slots, or two concurrent
   * runs against one worker session) starts from zero and can oversubscribe a
   * machine's DECLARED slots. Declared capacity is a per-run concurrency
   * budget, not a cross-run admission controller.
   */
  private readonly occupancy = new Map<string, number>();
  /** Callers parked until any machine releases a slot. */
  private slotWaiters: Array<() => void> = [];
  /**
   * Blocked workers left open by the escalate policy, per machine name. While
   * a machine has any, close() must NOT close that machine's workspace — the
   * escalated panes live in it, and tearing it down would kill exactly the
   * workers a human was told to go answer.
   */
  private readonly escalationsByMachine = new Map<string, number>();
  /** Monotonic across every run() on this runner: unique names and out paths. */
  private callSeq = 0;
  private readonly fallbackRunId = `r${Date.now().toString(36)}`;
  /**
   * The run's ONE workspace per machine (SPEC D11), created lazily on the
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
    this.transportFactory = options.transportFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.promptWaitTimeoutMs = options.promptWaitTimeoutMs ?? 900_000;
    this.agentStartTimeoutMs = options.agentStartTimeoutMs ?? 60_000;
    this.paneBusyRetries = options.paneBusyRetries ?? 3;
    this.paneBusyDelayMs = options.paneBusyDelayMs ?? 1_000;
    this.agentReadyPollMs = options.agentReadyPollMs ?? 100;
    this.outputSettleMs = options.outputSettleMs ?? 1_500;
    this.abortSettleMs = options.abortSettleMs ?? 250;
    this.fleet = options.fleet ?? defaultFleetConfig();
    this.onBlocked = this.fleet.defaults.onBlocked;
    this.session = options.session?.trim() || path.basename(path.dirname(options.socketPath));
    this.localSessionMode = options.localSessionMode ?? "worker";
    // Broken-kind guard, config routes (call routes are guarded in
    // resolveCallRuntime): the default kind (runner option, --kind, or the
    // fleet's [defaults].kind — run.js folds them into defaults.kind) and
    // every fleet machine's declared `kinds` fail fast at construction,
    // before any pane/socket work.
    assertWaitableKind(this.defaultKind, "default agent kind");
    for (const machine of this.fleet.machines) {
      for (const declared of machine.kinds ?? []) {
        assertWaitableKind(declared, `fleet machine "${machine.name}" declared kinds`);
      }
    }
  }

  /**
   * Runner-provided identity data (SPEC D4/D6): the RESOLVED runtime
   * args/env this call's kind/model/tier/effort map to under the fleet
   * config, folded into the engine's call hash so editing (say)
   * `[runtime.claude].model.opus` invalidates the cached calls that used it.
   * Throws SCRIPT_VALIDATION_ERROR for explicit values the config cannot
   * resolve (before any socket call — the engine hashes before it runs).
   *
   * A call that names NO kind additionally contributes the runner's DEFAULT
   * kind (SPEC D6: identity is {machine, kind} plus the resolved flags). The
   * engine hashes only the script-visible kind (call site / agentType), so
   * without this the CLI that actually runs an implicit-kind call would be
   * invisible to the resume hash — resuming under a different default kind
   * (`resume.js --kind codex`, or a changed [defaults].kind /
   * HerdrAgentRunnerOptions.defaults.kind) would silently replay one CLI's
   * result as the other's.
   *
   * Returns undefined when nothing resolves AND the call carries its own
   * kind — the hash then matches the pre-fleet format byte for byte, so
   * journals written without fleet config keep replaying for explicit-kind
   * calls.
   *
   * Machine identity is deliberately NOT contributed here (SPEC D6): the
   * engine already hashes the call's `machine` option — the stable machine
   * NAME (or selector) the script asked for — and an implicit placement must
   * keep hashing exactly as it did before multi-machine landed, or every
   * pre-M3 journal would stop replaying.
   */
  callIdentity(call: AgentCallIdentity): unknown {
    const resolved = this.resolveCallRuntime(call, undefined);
    const identity: Record<string, unknown> = {};
    if (!call.kind?.trim()) identity.kind = this.defaultKind;
    if (resolved.args.length > 0 || Object.keys(resolved.env).length > 0) {
      identity.args = resolved.args;
      identity.env = resolved.env;
    }
    return Object.keys(identity).length === 0 ? undefined : identity;
  }

  /** Resolve a call's runtime args/env through the fleet config (SPEC D4). */
  private resolveCallRuntime(
    call: { kind?: string; model?: string; tier?: string; effort?: string },
    agentLabel: string | undefined,
  ): ResolvedRuntime {
    const kind = call.kind?.trim() || this.defaultKind;
    // Broken-kind guard, call routes: every call — local or remote, hashed via
    // callIdentity or executed via run() — resolves its runtime here first,
    // before any placement, slot, or socket work.
    assertWaitableKind(kind, agentLabel ? `agent "${agentLabel}"` : "agent call", agentLabel);
    return resolveRuntime(this.fleet, kind, { model: call.model, tier: call.tier, effort: call.effort }, agentLabel);
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<unknown> {
    const label = options.label ?? "agent";
    const signal = options.signal;
    this.throwIfAborted(signal, label);

    const kind = options.kind?.trim() || this.defaultKind;
    // Resolve model/tier/effort through [runtime.<kind>] into agent.start args
    // + tab env (SPEC D4). Throws SCRIPT_VALIDATION_ERROR for explicit values
    // the fleet config cannot resolve — before any socket call; absent
    // implicit values inherit silently. The same resolution feeds
    // callIdentity(), so these args/env are already part of the engine's call
    // hash when the engine drives this runner.
    const runtime = this.resolveCallRuntime(
      { kind, model: options.model, tier: options.tier, effort: options.effort },
      label,
    );
    // Placement candidates (SPEC D12): validated BEFORE any slot is reserved
    // or transport touched, so a bad machine/tag never holds capacity.
    const candidates = this.resolvePlacementCandidates(options.machine, kind, label, options.cwd);
    const runId = runIdFromSessionName(options.sessionName) ?? this.fallbackRunId;
    const callIndex = this.callSeq++;

    // Reserve one slot on the least-occupied candidate (waits when every
    // candidate is at declared capacity; released in the finally below).
    const machine = await this.acquireMachine(candidates, signal, label);
    const remote = machine.transport !== "local";
    const context: CallContext = {
      label,
      runId,
      callIndex,
      machine,
      remote,
      agentName: buildAgentName(runId, callIndex),
    };
    try {
      const transport = this.transportFor(machine);
      context.transport = transport;
      const hasSchema = options.schema != null;
      // HERDR_FLOW_* paths live on the WORKER's machine (SPEC Q11): local
      // calls under stateDir, remote calls under remoteStateDir (POSIX
      // paths), both prepared through the machine's own transport.
      const env = remote
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

      const opened = await this.openTab(context, env, runtime.env, options, signal);
      context.tabId = opened.tabId;
      context.paneId = opened.paneId;
      await this.startAgent(context, kind, runtime.args, signal);
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
        // outranks an escalation: the user asked for teardown.
        if (context.escalated) {
          context.escalated = false;
          this.releaseEscalation(machine.name);
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
      // the human the escalation points at — SPEC D15 — and keep their machine
      // slot, because the worker still occupies the pane.
      if (context.tabId && !context.escalated && context.transport) {
        await this.closeTab(context.transport, context.tabId);
      }
      if (!context.escalated) this.releaseMachine(machine.name);
    }
  }

  /**
   * Close each machine's run workspace (tearing down any leftover tabs/panes
   * with it) and then every transport. Idempotent; workspace teardown is
   * best-effort so a dead server never turns shutdown into a crash.
   *
   * EXCEPT for machines where the escalate policy left blocked workers open:
   * their tabs live in that machine's workspace, and closing it would kill
   * exactly the panes the escalation records told a human to go attach to
   * (SPEC D15). Those workspaces are left alive (only the transports close —
   * which severs no panes) and remain findable by their workspace label
   * (the caller's workspaceLabel, else `flow/<runId>`).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const [machineName, promise] of this.workspacePromises) {
        if ((this.escalationsByMachine.get(machineName) ?? 0) > 0) continue;
        const transport = this.transports.get(machineName);
        if (!transport) continue;
        const workspaceId = this.workspaceIds.get(machineName) ?? (await promise.catch(() => undefined));
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

  // ── Placement (SPEC D12): machine selection and slot accounting ────────────

  /**
   * Resolve a call's `machine:` option to its candidate machines, validating
   * strictly (naming an unconfigured machine or tag is SCRIPT_VALIDATION_ERROR,
   * never a silent fallback — SPEC D12):
   *
   * - undefined       -> every machine that declares the kind
   * - "name" / {name} -> exactly that machine (which must declare the kind)
   * - {tag}           -> the machines carrying that tag that declare the kind
   *
   * A call-site cwd (worktree isolation) narrows candidates to LOCAL machines:
   * the path only exists on the engine's host, and this milestone does not
   * ship worktrees across ssh — a placement left with no local candidate is
   * an explicit validation error, not a silent degrade.
   */
  private resolvePlacementCandidates(
    machineOption: AgentRunOptions["machine"],
    kind: string,
    label: string,
    cwd: string | undefined,
  ): MachineConfig[] {
    const machines = this.fleet.machines;
    const configured = machines.map((entry) => entry.name).join(", ");
    const fail = (message: string): never => {
      throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false, agentLabel: label });
    };
    const source = this.fleet.source ? `fleet config: ${this.fleet.source}` : "no fleet.toml is configured";

    let base: MachineConfig[];
    let selector: string;
    if (machineOption === undefined) {
      base = machines;
      selector = "any machine";
    } else {
      const record = typeof machineOption === "object" && machineOption !== null ? (machineOption as Record<string, unknown>) : undefined;
      const name = typeof machineOption === "string" ? machineOption : typeof record?.name === "string" ? (record.name as string) : undefined;
      const tag = typeof record?.tag === "string" ? (record.tag as string) : undefined;
      if (name !== undefined) {
        const found = machines.find((entry) => entry.name === name);
        if (!found) {
          fail(
            `agent "${label}": machine "${name}" is not in the fleet (configured machines: ${configured}; ${source}). ` +
              "Naming an unconfigured machine is a validation error, never a silent fallback to local (SPEC D12).",
          );
        }
        base = [found!];
        selector = `machine "${name}"`;
      } else if (tag !== undefined) {
        base = machines.filter((entry) => entry.tags.includes(tag));
        if (base.length === 0) {
          fail(
            `agent "${label}": no fleet machine carries tag "${tag}" (configured machines: ${configured}; ${source}). ` +
              "Naming an unconfigured tag is a validation error, never a silent fallback to local (SPEC D12).",
          );
        }
        selector = `tag "${tag}"`;
      } else {
        return fail(
          `agent "${label}": machine ${JSON.stringify(machineOption)} does not name a machine ` +
            `(use a machine name string, {name: "..."}, or {tag: "..."}; configured machines: ${configured})`,
        );
      }
    }

    // A machine can only run kinds it declares (an omitted `kinds` declares no
    // restriction — SPEC D12).
    const kindEligible = base.filter((entry) => !entry.kinds || entry.kinds.includes(kind));
    if (kindEligible.length === 0) {
      fail(
        `agent "${label}": no machine matching ${selector} declares kind "${kind}" ` +
          `(considered: ${base.map((entry) => entry.name).join(", ")}; ${source})`,
      );
    }

    // A machine can only work repos it has (SPEC D12): a REMOTE machine that
    // declares `repos` is eligible only when one of them basename-matches the
    // workflow's own cwd — the same match remoteCwd() uses to pick the remote
    // tab's directory — because placing there would otherwise silently run
    // the agent in an unrelated checkout (or HOME). An omitted/empty `repos`
    // declares no restriction, mirroring `kinds`; local machines always
    // qualify (the workflow's cwd is by definition on the engine's host); and
    // with no workflow cwd there is no repo to require.
    const wantedRepo = this.defaultCwd ? path.basename(this.defaultCwd) : undefined;
    const repoEligible =
      wantedRepo === undefined
        ? kindEligible
        : kindEligible.filter(
            (entry) =>
              entry.transport === "local" ||
              entry.repos.length === 0 ||
              entry.repos.some((repo) => path.posix.basename(repo) === wantedRepo),
          );
    if (repoEligible.length === 0) {
      fail(
        `agent "${label}": no machine matching ${selector} declares a repo matching "${wantedRepo}" ` +
          `(a machine can only work repos it has — SPEC D12; considered: ` +
          `${kindEligible.map((entry) => `${entry.name} [${entry.repos.join(", ") || "no repos"}]`).join("; ")}; ${source})`,
      );
    }

    if (cwd === undefined) return repoEligible;
    const local = repoEligible.filter((entry) => entry.transport === "local");
    if (local.length === 0) {
      fail(
        `agent "${label}": worktree isolation (a call-site cwd) is not supported on remote machines in this ` +
          `milestone, and ${selector} leaves no local machine to place it on (considered: ` +
          `${repoEligible.map((entry) => entry.name).join(", ")}). Drop the isolation or place the call locally.`,
      );
    }
    return local;
  }

  /**
   * Reserve one slot on the least-occupied candidate. The free-slot check and
   * the increment are SYNCHRONOUS (no await between them — SPEC D5's atomic
   * check-and-increment rule), so a parallel() fan-out can never overshoot a
   * machine's declared slots. Ties break in fleet declaration order, keeping
   * single-machine (and quiet multi-machine) placement deterministic. When
   * every candidate is at capacity the call parks until any slot releases.
   */
  private async acquireMachine(candidates: MachineConfig[], signal: AbortSignal | undefined, label: string): Promise<MachineConfig> {
    for (;;) {
      this.throwIfAborted(signal, label);
      let best: MachineConfig | undefined;
      let bestCount = Infinity;
      for (const machine of candidates) {
        const used = this.occupancy.get(machine.name) ?? 0;
        if (used >= (machine.slots ?? Infinity)) continue;
        if (used < bestCount) {
          best = machine;
          bestCount = used;
        }
      }
      if (best) {
        this.occupancy.set(best.name, (this.occupancy.get(best.name) ?? 0) + 1);
        return best;
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.slotWaiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  private releaseMachine(machineName: string): void {
    const used = this.occupancy.get(machineName) ?? 0;
    this.occupancy.set(machineName, Math.max(0, used - 1));
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }

  private releaseEscalation(machineName: string): void {
    const count = this.escalationsByMachine.get(machineName) ?? 0;
    this.escalationsByMachine.set(machineName, Math.max(0, count - 1));
  }

  /** The machine's transport, created on first placement there (SPEC D13). */
  private transportFor(machine: MachineConfig): HerdrTransport {
    const existing = this.transports.get(machine.name);
    if (existing) return existing;
    const created = this.transportFactory
      ? this.transportFactory(machine)
      : machine.transport === "local"
        ? new LocalHerdrTransport({ socketPath: this.socketPath, defaultTimeoutMs: this.requestTimeoutMs })
        : new SshHerdrTransport({
            target: machine.transport.ssh,
            // Validated non-empty for remote machines at fleet-config load.
            herdrBin: machine.herdrBin!,
            session: this.session,
            machineName: machine.name,
            requestTimeoutMs: this.requestTimeoutMs,
          });
    this.transports.set(machine.name, created);
    return created;
  }

  /**
   * Working directory for a REMOTE call's tab: the machine's declared repo
   * (basename-matched against the workflow's own cwd when both exist, else
   * the machine's first declared repo), else undefined — the remote HOME.
   * The engine's local default cwd is never sent across: it names a path on
   * the wrong filesystem.
   */
  private remoteCwd(machine: MachineConfig): string | undefined {
    if (machine.repos.length === 0) return undefined;
    if (this.defaultCwd) {
      const wanted = path.basename(this.defaultCwd);
      const matched = machine.repos.find((repo) => path.posix.basename(repo) === wanted);
      if (matched) return matched;
    }
    return machine.repos[0];
  }

  // ── Phase 1: topology (SPEC D11 — workspace per run per machine) ───────────

  /**
   * The run's single workspace ON THIS MACHINE, created once and shared by
   * every call placed there. No per-call abort signal on purpose: the
   * workspace is a RUN-scoped resource, and cancelling it with the first
   * call's signal would fail every concurrent caller sharing the memoized
   * promise.
   */
  private ensureWorkspace(machine: MachineConfig, transport: HerdrTransport, runId: string): Promise<string> {
    const existing = this.workspacePromises.get(machine.name);
    if (existing) return existing;
    const created = transport
      .request(
        "workspace.create",
        // The sidebar label leads with the WORKFLOW's name when the caller
        // provided one (run.js: `<meta.name> · <last4>`); `flow/<runId>` is
        // the label for library users who set none. Same label on every
        // machine, including remote workers.
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
        this.workspaceIds.set(machine.name, workspaceId);
        return workspaceId;
      });
    // Reset the memo on failure so a later call can retry, while every
    // caller of THIS attempt still sees the failure.
    created.catch(() => {
      if (this.workspacePromises.get(machine.name) === created) this.workspacePromises.delete(machine.name);
    });
    this.workspacePromises.set(machine.name, created);
    return created;
  }

  private async openTab(
    context: CallContext,
    env: FlowCallEnv,
    runtimeEnv: Record<string, string>,
    options: AgentRunOptions,
    signal?: AbortSignal,
  ): Promise<{ tabId: string; paneId: string }> {
    const transport = context.transport!;
    const workspaceId = await this.ensureWorkspace(context.machine, transport, context.runId);
    this.throwIfAborted(signal, context.label);
    // Resolved [runtime.<kind>] env (SPEC D4's second delivery mechanism —
    // agent.start accepts no environment of its own, so effort-style settings
    // ride on the tab, whose shell the agent inherits) merged under the
    // HERDR_FLOW_* contract env, which always wins on a name collision.
    const tabEnv: Record<string, string> = { ...runtimeEnv };
    for (const [key, value] of Object.entries(env)) if (value !== undefined) tabEnv[key] = value;
    // Call-site cwd (an isolated worktree) wins on LOCAL placements;
    // otherwise the runner default (the workflow's cwd). Remote placements
    // resolve against the machine's declared repos instead — the local paths
    // do not exist there. Never send a local path to a remote tab.
    const cwd = context.remote ? this.remoteCwd(context.machine) : (options.cwd ?? this.defaultCwd);
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
            // The resolved [runtime.<kind>] args (model/effort/permission,
            // SPEC D4). Omitted entirely when empty, matching the schema's
            // skip_serializing_if and keeping pre-fleet call shapes identical.
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
   * Apply the configured on_blocked policy (SPEC D15) to a call whose worker
   * stopped to ask a human something. Both policies fail the call recoverable
   * with the distinct HERDR_BLOCKED code; they differ in what happens to the
   * pane, and `paneClosed` in the error's details always reflects reality:
   *
   * - "fail" (default): the run()-level finally tears the tab down (killing
   *   the blocked agent with its pane) before the caller sees this error, so
   *   `paneClosed: true` and the tab/pane ids are diagnostics only.
   * - "escalate": the tab is deliberately left OPEN (context.escalated
   *   suppresses the finally teardown AND the slot release — the worker still
   *   occupies its pane, D15 — and close() then leaves that machine's
   *   workspace alive), an escalation record is emitted through onHistory,
   *   a pointer is persisted at `<stateDir>/<runId>/escalation-<call>.json`
   *   on the ENGINE's machine, and the error message carries the
   *   human-runnable attach command — `herdr --session <session> agent attach
   *   <agent>` locally, wrapped in `ssh -t <target> '…'` for a remote machine
   *   (a fleet view is a printed command, not a screen — SPEC D16).
   *
   * ("answer" is rejected at config-load time — see fleet/config.ts.)
   */
  private async raiseBlocked(
    context: CallContext,
    options: AgentRunOptions,
    explanation?: string,
  ): Promise<HerdrWorkflowError> {
    const identity = {
      machine: context.machine.name,
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
    this.escalationsByMachine.set(context.machine.name, (this.escalationsByMachine.get(context.machine.name) ?? 0) + 1);
    const attachCommand = this.attachCommand(context);
    const escalation: Record<string, unknown> = {
      type: "escalation",
      code: "agent_blocked_escalated",
      runId: context.runId,
      callIndex: context.callIndex,
      label: context.label,
      session: this.session,
      workspaceId: this.workspaceIds.get(context.machine.name),
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
        `(agent ${context.agentName}, pane ${context.paneId}, machine ${context.machine.name}). Answer it with: ${attachCommand}`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      HERDR_BLOCKED,
      {
        // Recoverable (the run goes on; the call collapses to null) but NOT
        // retryable: the escalated worker deliberately keeps its pane AND its
        // machine slot (D15 — escalate does not free capacity), so an engine
        // retry would open a duplicate worker for the same logical call and,
        // on a machine at capacity, park forever waiting on the very slot
        // this escalation holds — a deadlock, measured live.
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
   * Local machines: in "default" localSessionMode the pane lives in the
   * user's OWN session, so the command must omit --session — with it, herdr
   * would target the (typically not running) worker session and the printed
   * escalation instruction would be unfollowable. Remote machines always run
   * under the named worker session, mode or no mode.
   */
  private attachCommand(context: CallContext): string {
    if (context.machine.transport === "local") {
      return this.localSessionMode === "default"
        ? `herdr agent attach ${context.agentName}`
        : `herdr --session ${this.session} agent attach ${context.agentName}`;
    }
    const remote = `${context.machine.herdrBin ?? "herdr"} --session ${this.session} agent attach ${context.agentName}`;
    return `ssh -t ${context.machine.transport.ssh} ${shellQuote(remote)}`;
  }

  /**
   * Poll for the output file for up to outputSettleMs after the wait
   * resolved — through the call's transport, because the file lives on the
   * worker's machine (SPEC Q11).
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
        machine: context.machine.name,
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
          // deterministic per (machine, kind, repo), so an engine-level retry
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
