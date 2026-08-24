/**
 * Public surface of the herdr-dynamic-workflow orchestration engine.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */

export {
  agentDefinitionKey,
  EMPTY_AGENT_TYPE_REGISTRY,
  resolveAgentType,
  type AgentTypeDefinition,
  type AgentTypeRegistry,
} from "./agent-registry.js";
export {
  type AgentCallIdentity,
  type AgentHistoryEntry,
  type AgentRunOptions,
  type AgentUsage,
  type JsonSchema,
  type WorkflowAgentRunner,
} from "./agent-runner.js";
export * from "./config.js";
export {
  classifyProviderLimit,
  isAbortError,
  isProviderUsageLimit,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export { createWorkflowLogger, type WorkflowLogger, type WorkflowLoggerOptions } from "./logger.js";
export {
  parseModelRoutingFromMeta,
  resolveModelForPhase,
  type ModelRoute,
  type ModelRoutingConfig,
} from "./model-routing.js";
export { createAgentStoreHandle, SharedStore, type AgentStoreHandle } from "./shared-store.js";
export {
  parseWorkflowScript,
  runWorkflow,
  type AgentOptions,
  type CheckpointOptions,
  type JournalEntry,
  type SharedRuntime,
  type WorkflowMeta,
  type WorkflowMetaPhase,
  type WorkflowRunOptions,
  type WorkflowRunResult,
  type WorkflowRuntimeEvent,
} from "./workflow.js";
export { createWorktree, removeWorktree, type Worktree } from "./worktree.js";
