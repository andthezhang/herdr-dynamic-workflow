/**
 * The agent-runner seam: the one interface a backend implements to power
 * `agent()` calls. Everything Pi-specific from pi-dynamic-workflows' agent.ts
 * (session creation, tool policy, structured-output repair, model registry)
 * lives BEHIND this seam and is deliberately not ported — the Herdr runner
 * replaces it with pane lifecycle (create/claim a pane, `agent.start --kind`,
 * prompt with wait, harvest the result, tear down).
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 *
 * Contract the runner must preserve:
 * - `run()` resolves to the agent's result (a string when no schema is given;
 *   a schema-satisfying value when one is) or rejects with something
 *   `wrapError` can classify (or a pre-classified WorkflowError).
 * - It honors `options.signal` — abort must actually stop the pane.
 * - It reports usage via `onUsage` when it has any signal (0 is fine).
 * - Schema validation is the RUNNER's job, not the engine's: the engine only
 *   threads `options.schema` through (and into the call hash).
 */

import type { AgentStoreHandle } from "./shared-store.js";

/**
 * A plain JSON Schema object literal. The engine treats it as opaque identity
 * data (hashed into the resume key) — validation is owned by the runner.
 */
export type JsonSchema = Record<string, unknown>;

/** Per-agent usage as reported by the backend. Units are host-defined; 0 is a valid report. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** One compact entry of a subagent's message/tool history (shape owned by the runner). */
export type AgentHistoryEntry = Record<string, unknown>;

/** Options passed to WorkflowAgentRunner.run() for a single agent call. */
export interface AgentRunOptions {
  label?: string;
  /** Identifiable name for persisted sessions, e.g. `workflow:<runId> <label>`. */
  sessionName?: string;
  /** Plain JSON Schema the result must satisfy. Validation is the runner's job. */
  schema?: JsonSchema;
  signal?: AbortSignal;
  /** Extra system guidance (agentType role prompt, phase, isolation note). */
  instructions?: string;
  /** Model spec, when the workflow pinned one (explicit > agentType > phase route). */
  model?: string;
  /** Coarse model tier name; forwarded verbatim for the runner to resolve. */
  tier?: string;
  /** Effort/thinking level name; forwarded verbatim for the runner to resolve. */
  effort?: string;
  /** Herdr agent kind — which coding-agent CLI to run (e.g. "claude", "codex"). */
  kind?: string;
  /** ssh Host name whose Herdr runs the pane. Omitted means the local Herdr. */
  ssh?: string;
  /** Working directory for the agent (e.g. an isolated worktree). */
  cwd?: string;
  /** The effective timeout the engine will enforce for this call (informational). */
  timeoutMs?: number | null;
  /** Called once with this agent's real usage. Reporting 0 is fine. */
  onUsage?: (usage: AgentUsage) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /**
   * Per-call shared-store handle (writes delta-tracked under this call's
   * deltaKey). The runner decides how its agents reach it — see the TODO seam
   * in shared-store.ts.
   */
  store?: AgentStoreHandle;
}

/**
 * The subset of one agent call's options the runner may fold extra identity
 * onto (see WorkflowAgentRunner.callIdentity): exactly the options the runner
 * resolves into launch flags (SPEC D4) rather than applying verbatim.
 */
export interface AgentCallIdentity {
  kind?: string;
  model?: string;
  tier?: string;
  effort?: string;
}

/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
  run(prompt: string, options: AgentRunOptions): Promise<unknown>;
  /**
   * Optional runner-provided identity data for the resume hash (SPEC D4/D6):
   * whatever this returns is JSON-folded into the call's identity hash, so a
   * runner that RESOLVES options into launch flags (e.g. `model: "opus"` ->
   * `["--model", "opus"]`) makes a change to that resolution invalidate the
   * cached calls that used it — the journal must never replay a result produced
   * under different resolved flags as if nothing changed.
   *
   * Returning `undefined` means "no extra identity": the hash is byte-identical
   * to one computed before this seam existed, so journals from runners without
   * it (and calls that resolve to nothing) keep replaying.
   *
   * Called BEFORE any backend work for the call; it may throw a WorkflowError
   * (SCRIPT_VALIDATION_ERROR) when an explicit option cannot be resolved —
   * an option we can't resolve is a validation error, not a silent drop.
   */
  callIdentity?(call: AgentCallIdentity): unknown;
}
