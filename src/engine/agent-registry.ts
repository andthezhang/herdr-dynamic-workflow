/**
 * Named agent-type definitions for `agent({ agentType })`.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT), decoupled from pi's
 * `.pi/agents/*.md` filesystem scanner: the engine only consumes a minimal
 * resolve interface, injected via WorkflowRunOptions.agentRegistry and
 * defaulting to an empty registry. The host (Herdr plugin) owns discovery —
 * how definitions are found on disk, in config, or over the wire is its call.
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */

/** A resolved agent-type definition binding role prompt, agent kind, model, and isolation. */
export interface AgentTypeDefinition {
  /** Role guidance prepended to the subagent's task prompt. */
  prompt?: string;
  /** Herdr agent kind (which coding-agent CLI backs this type, e.g. "claude", "codex"). */
  kind?: string;
  /** Model spec for this subagent. */
  model?: string;
  /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
  isolation?: "worktree";
}

/** Minimal registry seam: resolve an agentType name to its definition, or undefined. */
export interface AgentTypeRegistry {
  resolve(name: string): AgentTypeDefinition | undefined;
}

/** Registry that knows no agent types — the default when the host injects none. */
export const EMPTY_AGENT_TYPE_REGISTRY: AgentTypeRegistry = { resolve: () => undefined };

/** Resolve an agentType name to its definition, or undefined if not registered. */
export function resolveAgentType(
  name: string | undefined,
  registry: AgentTypeRegistry,
): AgentTypeDefinition | undefined {
  if (!name) return undefined;
  return registry.resolve(name);
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent definition invalidates that call's cached
 * result on a later resume.
 */
export function agentDefinitionKey(def: AgentTypeDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    prompt: def.prompt ?? null,
    kind: def.kind ?? null,
    model: def.model ?? null,
    isolation: def.isolation ?? null,
  });
}
