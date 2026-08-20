/**
 * Workflow-specific error taxonomy.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 *
 * The codes and their `recoverable` flags are a load-bearing contract: a
 * recoverable failure collapses to `null` after retries are exhausted, a
 * non-recoverable one halts the run. `wrapError` is the classification seam —
 * a Herdr runner's failure vocabulary (pane died, agent kind not installed,
 * agent_pane_busy, wait timeout, blocked-on-approval) is mapped onto these
 * codes there or by throwing pre-classified WorkflowErrors from the runner.
 */

/** Stable runtime and persistence failure codes exposed to callers and UI surfaces. */
export enum WorkflowErrorCode {
  /** Agent exceeded timeout. */
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  /** Workflow was aborted by user. */
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  /** Agent limit exceeded. */
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Budget exhausted (units are host-defined — tokens, agent-seconds, …). */
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /**
   * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
   * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
   * so the run is checkpointed (paused) and replayed by resume() rather than failed.
   */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** Script validation failed. */
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A schema agent never produced a valid structured result (after repair + extraction). */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed without any assistant text output. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  /**
   * An agent()'s `model`/`tier` spec did not resolve to any known model. Never
   * silently substituted for the session default — resolution is deterministic,
   * so retrying the same spec would fail identically every time.
   */
  MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
  /** Agent execution failed. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  /** Run state persistence failed. */
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** Unknown error. */
  UNKNOWN = "UNKNOWN",
}

/** Classified workflow failure with recoverability and optional agent/provider context. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  /**
   * Whether the engine's automatic retry loop may re-attempt the call
   * (default true; only consulted when `recoverable` is also true). A failure
   * that is recoverable-but-not-retryable collapses straight to null: the
   * outcome is final for THIS run but must not halt it. The canonical case is
   * a blocked call under on_blocked = "escalate" — the worker was deliberately
   * left open (holding its pane and machine slot, SPEC D15), so re-attempting
   * the same logical call would open a duplicate worker and, on a machine at
   * capacity, park the retry forever on the very slot the escalation holds.
   */
  readonly retryable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  readonly resetHint?: string;

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options: { recoverable?: boolean; retryable?: boolean; agentLabel?: string; details?: unknown; resetHint?: string } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.retryable = options.retryable ?? true;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
  }
}

/** Narrow an unknown failure to WorkflowError. */
export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

/** Report whether an unknown failure is a provider usage-limit checkpoint condition. */
export function isProviderUsageLimit(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

/**
 * Detect a provider subscription/usage/quota/rate-limit exhaustion from free-form
 * error text, and extract the provider's human reset hint when present.
 *
 * Herdr has no SDK-level stopReason signal; a runner scraping a coding-agent
 * CLI's own quota message can use this classifier, but must only apply it to
 * text it knows is an ERROR surface, so a task whose own output merely mentions
 * "rate limit" is never misclassified. Deliberately excludes transient
 * overloaded/5xx errors, which stay recoverable and keep retrying.
 */
export function classifyProviderLimit(text: string | undefined): { matched: boolean; resetHint?: string } {
  if (!text) return { matched: false };
  const matched =
    /usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i.test(
      text,
    );
  if (!matched) return { matched: false };
  const reset = text.match(/resets?\s+(?:in|at)\s+[^.\n]+/i);
  return { matched: true, resetHint: reset?.[0]?.trim() };
}

/** Recognize abort-like Error messages without assuming a provider-specific class. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

/** Recognize timeout-like errors by name or message. */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\btimeout\b/i.test(error.message) || error.name === "TimeoutError";
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 *
 * This is the classification seam a backend rewires: anything the runner throws
 * that is not already a WorkflowError lands here. abort-like -> WORKFLOW_ABORTED,
 * timeout-like -> AGENT_TIMEOUT, provider-limit-like -> PROVIDER_USAGE_LIMIT,
 * everything else -> recoverable AGENT_EXECUTION_ERROR.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (isWorkflowError(error)) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Workflow was aborted",
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Agent timed out",
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: context?.agentLabel },
    );
  }

  // Defense-in-depth: classify a thrown provider limit here too — recoverable:false
  // so the run checkpoints (pauses) instead of being retried into the same wall
  // or silently nulled.
  if (error instanceof Error) {
    const limit = classifyProviderLimit(error.message);
    if (limit.matched) {
      return new WorkflowError(error.message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        agentLabel: context?.agentLabel,
        resetHint: limit.resetHint,
      });
    }
  }

  return new WorkflowError(
    error instanceof Error ? error.message : String(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}
