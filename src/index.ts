/**
 * herdr-dynamic-workflow — public package surface.
 *
 * Engine (src/engine): `runWorkflow` / `parseWorkflowScript` (script + meta
 * parsing), the `WorkflowError` taxonomy, the `WorkflowAgentRunner` seam,
 * agent-type registry, shared store, model routing, worktrees.
 *
 * Runner (src/runner): `HerdrAgentRunner` (the Herdr pane backend for the
 * seam), `HerdrWorkflowError` and the socket-client error types, and the §6
 * output-file contract helpers.
 *
 * Fleet (src/fleet): fleet.toml parsing and the [runtime.<kind>] resolution
 * rules (SPEC D4/D12/D15).
 */
export * from "./engine/index.js";
export * from "./fleet/config.js";
export * from "./runner/index.js";
