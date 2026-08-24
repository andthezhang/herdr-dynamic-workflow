/**
 * Configuration constants for the herdr-dynamic-workflow engine.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/** Maximum concurrent agents (matches Claude Code limit). The unit here is panes, not sessions. */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Default budget if none specified (units are host-defined). */
export const DEFAULT_TOKEN_BUDGET = null;
