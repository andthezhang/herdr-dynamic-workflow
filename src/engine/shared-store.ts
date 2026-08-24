/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Each agent gets a per-call handle (see `createAgentStoreHandle`) whose
 * writes are attributed to that call's run-unique deltaKey so they can be
 * journaled and replayed on resume.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause.
 *
 * `deltaKey` must be unique across every run that shares this store instance,
 * not just within one run's callSeq. A nested `workflow()` call restarts its own
 * callSeq at 0 while inheriting the parent's store (so parent and nested-run
 * agents can share state), so a bare callIndex would collide between a parent
 * agent and a concurrently-running nested-run agent that both got index 0 —
 * whichever commits its delta last would clobber the other's entry in
 * `agentDeltas`. Callers compose `deltaKey` as `${runId}:${callIndex}`, and
 * since every run (including each nested run) gets its own distinct `runId`,
 * the composite key is unique across the whole store's lifetime.
 *
 * TODO(herdr seam): pi exposed this store to subagents as two in-process MCP
 * tools (`store_put` / `store_get`) built with the Pi SDK's defineTool. That
 * half is deliberately not ported — how a Herdr-driven CLI agent reaches the
 * store (file contract, CLI subcommand, MCP bridge) is the runner's decision.
 * The engine threads a per-call `AgentStoreHandle` (put/get, delta-tracked)
 * into `AgentRunOptions.store`; the runner re-expresses it however its agents
 * call tools.
 */

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Pre-write shadow values for the CURRENT delta-key's in-progress writes,
  // so a failed retry attempt's mutations can be rolled back (see
  // `discardDelta`) instead of leaking into the live store or a later
  // successful attempt's recorded delta. Populated lazily by `trackPut` (only
  // the first write to a given key within the current delta window is
  // shadowed — later writes to the same key within the same attempt are
  // already covered by that first shadow) and cleared whenever the delta is
  // finalized, either way, via `commitDelta`/`discardDelta`.
  private readonly priorValues = new Map<string, Map<string, { existed: boolean; value: unknown }>>();

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent handles created via `createAgentStoreHandle` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    let priors = this.priorValues.get(deltaKey);
    if (!priors) {
      priors = new Map();
      this.priorValues.set(deltaKey, priors);
    }
    // Only shadow the value from BEFORE this delta window started writing to
    // this key — a second write to the same key within the same attempt must
    // not overwrite the shadow with its own (already-in-window) value.
    if (!priors.has(key)) {
      priors.set(
        key,
        this.map.has(key) ? { existed: true, value: this.map.get(key) } : { existed: false, value: undefined },
      );
    }
    this.map.set(key, value);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
    return delta;
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store (e.g. to a
   * concurrently-running sibling agent's reads, or to script code reading
   * `store.get` directly) and must not merge into the delta eventually
   * recorded when a later attempt of the SAME call succeeds — otherwise a
   * failed attempt's mutations would silently survive into the run's live
   * state while being absent from the journaled delta that resume replay
   * reconstructs from, leaving live execution and replay permanently
   * inconsistent. Each key touched during this delta window is restored to
   * whatever it held immediately before the window started (or deleted, if
   * it did not exist yet) — never to some other attempt's or caller's value.
   *
   * Per-key guard: a key is only rolled back if the store STILL holds this
   * attempt's own last write to it (checked with `Object.is` against the
   * value recorded in `delta`). If a concurrently-running sibling (a
   * different `deltaKey`, e.g. another agent in the same parallel() batch)
   * legitimately overwrote the same key AFTER this attempt wrote it but
   * BEFORE it failed, that sibling's write is left untouched — rolling back
   * unconditionally would silently erase a live, unrelated write that this
   * attempt never made and has no business undoing.
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    const priors = this.priorValues.get(deltaKey);
    for (const key of Object.keys(delta)) {
      // Someone else already overwrote this key since our last write to it —
      // leave their write in place instead of clobbering it with our rollback.
      if (!Object.is(this.map.get(key), delta[key])) continue;
      const prior = priors?.get(key);
      if (prior?.existed) this.map.set(key, prior.value);
      else this.map.delete(key);
    }
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   */
  applyDelta(delta: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(delta)) {
      this.map.set(k, v);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.map.set(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.priorValues.clear();
  }
}

/**
 * Per-call view of the shared store handed to the agent runner. Writes are
 * attributed to `deltaKey` (run-unique `${runId}:${callIndex}`) so the delta
 * can be journaled with the call's result and replayed additively on resume.
 */
export interface AgentStoreHandle {
  /** Write a value; tracked under this call's deltaKey for delta journaling. */
  put(key: string, value: unknown): void;
  /** Read a value previously written by any agent in this run. */
  get(key: string): { found: boolean; value: unknown };
}

/**
 * Create the per-agent store handle that attributes writes to `deltaKey`
 * (see the `SharedStore` class doc for why the bare callIndex alone is not
 * enough once a nested `workflow()` call shares this store).
 */
export function createAgentStoreHandle(store: SharedStore, deltaKey: string): AgentStoreHandle {
  return {
    put(key: string, value: unknown): void {
      store.trackPut(key, value, deltaKey);
    },
    get(key: string): { found: boolean; value: unknown } {
      const found = store.has(key);
      return { found, value: found ? store.get(key) : null };
    },
  };
}
