/**
 * Fleet/runtime configuration: fleet.toml parsing and the [runtime.<kind>]
 * resolution rules (SPEC D4, D12, D15).
 *
 * The script says WHAT it wants (`model: "opus"`, `effort: "high"`); this
 * config says what that means for each agent CLI — launch args appended to
 * `agent.start` and env set on the call's tab. We never hold a table of any
 * CLI's flags ourselves (D14): a vendor flag rename is a one-line edit to the
 * user's fleet.toml, not a release of ours.
 *
 * Shape (all sections optional; an EMPTY config is the implicit default):
 *
 *   [defaults]
 *   kind = "claude"            # agent CLI when a call names none
 *   model = "sonnet"           # implicit model, resolved per kind, inherits silently when unmapped
 *   effort = "medium"          # implicit effort, same rule
 *   on_blocked = "fail"        # "fail" | "escalate" ("answer" is rejected: not yet supported, Q8)
 *
 *   [runtime.<kind>]
 *   permission = ["--flag"]    # args ALWAYS appended to agent.start for this kind
 *   model.<name> = ["--model", "x"]         # array => launch args
 *   effort.<name> = { env = { K = "v" } }   # table => tab env (and/or args)
 *
 *   [[machine]]
 *   name = "build-mac"
 *   transport = "build-mac"    # "local" (default) | "ssh://user@host" | plain ssh alias
 *   herdr_bin = "/opt/homebrew/bin/herdr"   # REQUIRED for remote machines (D13: never PATH)
 *   slots = 4                  # declared capacity (D12: capacity is declared, not measured)
 *   tags = ["mac"]
 *   kinds = ["claude", "codex"]             # agent CLIs installed there (omitted = any)
 *   repos = ["/path/to/checkout"]           # repos this machine can work (D12)
 *
 * Load order: an explicit --fleet path (missing file = error), else
 * $HERDR_PLUGIN_CONFIG_DIR/fleet.toml when present, else this plugin's
 * CONVENTIONAL config dir (<herdr config dir>/plugins/config/herdrflow.engine
 * — so internal standalone execution sees the same fleet.toml a Herdr-invoked
 * action sees), else the implicit default (single local
 * machine, kind claude, on_blocked fail) — D12: multi-machine is in the
 * model from day one, opt-in for the user.
 *
 * Resolution rule (D4/D1): an EXPLICIT value (from the script) that has no
 * [runtime.<kind>] mapping is a SCRIPT_VALIDATION_ERROR — an option we can't
 * resolve is a validation error, not a silent drop. An IMPLICIT value (from
 * [defaults]) that has no mapping inherits silently: the CLI just runs its own
 * default.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { WorkflowError, WorkflowErrorCode } from "../engine/errors.js";

/** This plugin's manifest id (herdr-plugin.toml). Names its config dir under Herdr. */
export const PLUGIN_ID = "herdrflow.engine";

/**
 * Herdr's own config dir, mirrored exactly for the platforms the plugin
 * supports (linux/macos — herdr src/config/io.rs config_dir):
 * $XDG_CONFIG_HOME/herdr when set, else ~/.config/herdr. Everything that
 * computes a path herdr also computes (session sockets, plugin config dirs)
 * MUST go through this — hardcoding ~/.config silently diverges from a herdr
 * running with XDG_CONFIG_HOME set. (Per the XDG spec an empty value counts
 * as unset.)
 */
export function herdrConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "herdr");
  return path.join(os.homedir(), ".config", "herdr");
}

/**
 * This plugin's config dir by Herdr's convention (herdr src/plugin_paths.rs
 * plugin_config_dir: <config dir>/plugins/config/<id>; our id is all
 * lowercase/dot so the path component is the id verbatim). `herdr plugin
 * config-dir herdrflow.engine` prints the same path.
 */
export function pluginConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(herdrConfigDir(env), "plugins", "config", PLUGIN_ID);
}

/** A fleet.toml that cannot be accepted: unparseable, mis-shaped, or naming an unsupported policy. */
export class FleetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetConfigError";
  }
}

/**
 * Blocked-call policy (SPEC D15). "answer" exists in the vocabulary but is
 * rejected at config-load time until Q8 (what produces the answer) is settled —
 * auto-answering a permission prompt is the most dangerous thing this engine
 * could do, so it must not be configurable before it is designed.
 */
export type OnBlockedPolicy = "fail" | "escalate";

/** One resolved model/effort mapping: launch args and/or tab-level env. */
export interface RuntimeDelivery {
  args: string[];
  env: Record<string, string>;
}

/** The [runtime.<kind>] section, normalized. */
export interface RuntimeConfig {
  /** Args ALWAYS appended to agent.start for this kind (e.g. permission bypass). */
  permission: string[];
  /** model name -> delivery. */
  model: Record<string, RuntimeDelivery>;
  /** effort name -> delivery. */
  effort: Record<string, RuntimeDelivery>;
}

/** One [[machine]] entry. */
export interface MachineConfig {
  name: string;
  /** "local", or the ssh target ("user@host" from an ssh:// URL, or a plain alias). */
  transport: "local" | { ssh: string };
  /** Absolute herdr binary path on that machine (required for remote — D13). */
  herdrBin?: string;
  /** Declared concurrency capacity (D12). */
  slots?: number;
  tags: string[];
  /** Agent CLIs installed there; undefined = no restriction declared. */
  kinds?: string[];
  repos: string[];
}

export interface FleetConfig {
  defaults: {
    kind: string;
    model?: string;
    effort?: string;
    onBlocked: OnBlockedPolicy;
  };
  /** kind -> [runtime.<kind>] section. */
  runtimes: Record<string, RuntimeConfig>;
  machines: MachineConfig[];
  /** The file this config was parsed from; undefined for the implicit default. */
  source?: string;
}

/** What one agent call's model/tier/effort resolve to for its kind. */
export interface ResolvedRuntime {
  /** agent.start args (model args, then effort args, then permission args). */
  args: string[];
  /** Tab-level env the pane's shell — and therefore the agent — inherits. */
  env: Record<string, string>;
}

export const LOCAL_MACHINE_NAME = "local";
export const DEFAULT_KIND = "claude";

/** The implicit fleet when no config file exists: one local machine, no runtime tables. */
export function defaultFleetConfig(): FleetConfig {
  return {
    defaults: { kind: DEFAULT_KIND, onBlocked: "fail" },
    runtimes: {},
    machines: [{ name: LOCAL_MACHINE_NAME, transport: "local", tags: [], repos: [] }],
  };
}

/**
 * Load the fleet config: explicit path (must exist), else
 * `$HERDR_PLUGIN_CONFIG_DIR/fleet.toml` when present (Herdr-invoked; the
 * injected dir is authoritative), else — standalone — the conventional
 * plugin config dir's fleet.toml, else the implicit default.
 */
export function loadFleetConfig(options: { fleetPath?: string; env?: NodeJS.ProcessEnv } = {}): FleetConfig {
  const env = options.env ?? process.env;
  if (options.fleetPath) {
    const file = path.resolve(options.fleetPath);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new FleetConfigError(
        `fleet config ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseFleetToml(text, file);
  }
  const injected = env.HERDR_PLUGIN_CONFIG_DIR;
  if (injected && injected.trim() !== "") {
    const file = path.join(injected, "fleet.toml");
    if (existsSync(file)) return parseFleetToml(readFileSync(file, "utf8"), file);
  } else {
    // Standalone/internal invocation (no Herdr-injected env): the conventional
    // plugin config dir loads the same fleet.toml a Herdr-invoked action would
    // — the file the authoring skill tells authors to read via
    // `herdr plugin config-dir`.
    const file = path.join(pluginConfigDir(env), "fleet.toml");
    if (existsSync(file)) return parseFleetToml(readFileSync(file, "utf8"), file);
  }
  return defaultFleetConfig();
}

/** Parse and validate fleet.toml text. Throws FleetConfigError on any problem. */
export function parseFleetToml(text: string, source?: string): FleetConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new FleetConfigError(
      `fleet config${source ? ` ${source}` : ""} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Unknown top-level keys are errors, not silent drops — the same rule the
  // script contract applies to agent() options (D1).
  assertKnownKeys(raw, ["defaults", "runtime", "machine"], "top level");

  const fleet = defaultFleetConfig();
  fleet.source = source;

  if (raw.defaults !== undefined) {
    const defaults = asTable(raw.defaults, "[defaults]");
    assertKnownKeys(defaults, ["kind", "model", "effort", "on_blocked"], "[defaults]");
    if (defaults.kind !== undefined) fleet.defaults.kind = asNonEmptyString(defaults.kind, "[defaults] kind");
    if (defaults.model !== undefined) fleet.defaults.model = asNonEmptyString(defaults.model, "[defaults] model");
    if (defaults.effort !== undefined) fleet.defaults.effort = asNonEmptyString(defaults.effort, "[defaults] effort");
    if (defaults.on_blocked !== undefined) fleet.defaults.onBlocked = parseOnBlocked(defaults.on_blocked);
  }

  if (raw.runtime !== undefined) {
    const runtimes = asTable(raw.runtime, "[runtime]");
    for (const [kind, value] of Object.entries(runtimes)) {
      fleet.runtimes[kind] = parseRuntimeSection(value, kind);
    }
  }

  if (raw.machine !== undefined) {
    if (!Array.isArray(raw.machine)) {
      throw new FleetConfigError("machine must be an array of tables ([[machine]])");
    }
    fleet.machines = raw.machine.map((entry, index) => parseMachine(entry, index));
    const seen = new Set<string>();
    for (const machine of fleet.machines) {
      if (seen.has(machine.name)) {
        throw new FleetConfigError(`duplicate [[machine]] name "${machine.name}"`);
      }
      seen.add(machine.name);
    }
    if (fleet.machines.length === 0) fleet.machines = defaultFleetConfig().machines;
  }

  return fleet;
}

/**
 * Resolve one agent call's model/tier/effort through [runtime.<kind>] into the
 * concrete agent.start args and tab env (SPEC D4).
 *
 * - `model`/`tier`/`effort` in `request` are EXPLICIT (from the script — this
 *   includes a meta.phases[].model route): a name with no mapping throws a
 *   non-recoverable SCRIPT_VALIDATION_ERROR before any socket call.
 * - Absent explicit values fall back to [defaults].model / [defaults].effort,
 *   which are IMPLICIT: an unmapped implicit name inherits silently.
 * - An explicit `model` beats `tier`; a `tier` resolves through the same
 *   model.<name> table (it is a coarse model name).
 * - The kind's `permission` args are ALWAYS appended.
 */
export function resolveRuntime(
  fleet: FleetConfig,
  kind: string | undefined,
  request: { model?: string; tier?: string; effort?: string },
  agentLabel?: string,
): ResolvedRuntime {
  const resolvedKind = kind?.trim() || fleet.defaults.kind;
  const runtime = fleet.runtimes[resolvedKind];
  const args: string[] = [];
  const env: Record<string, string> = {};

  const apply = (delivery: RuntimeDelivery): void => {
    args.push(...delivery.args);
    Object.assign(env, delivery.env);
  };

  const lookup = (
    table: "model" | "effort",
    explicitName: string | undefined,
    implicitName: string | undefined,
    optionLabel: string,
  ): void => {
    if (explicitName !== undefined) {
      const delivery = runtime?.[table][explicitName];
      if (!delivery) {
        throw new WorkflowError(
          `agent${agentLabel ? ` "${agentLabel}"` : ""}: ${optionLabel} "${explicitName}" cannot be resolved for kind "${resolvedKind}" — ` +
            `no [runtime.${resolvedKind}] ${table}.${explicitName} entry in the fleet config` +
            `${fleet.source ? ` (${fleet.source})` : " (no fleet.toml is configured)"}. ` +
            "An option that cannot be resolved is a validation error, never a silent drop (SPEC D4).",
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false, agentLabel },
        );
      }
      apply(delivery);
      return;
    }
    if (implicitName !== undefined) {
      // Implicit ([defaults]) values inherit silently when unmapped: the CLI
      // simply runs its own default.
      const delivery = runtime?.[table][implicitName];
      if (delivery) apply(delivery);
    }
  };

  // Explicit model beats tier; tier is a coarse model name resolved through
  // the same table.
  lookup("model", request.model ?? request.tier, fleet.defaults.model, request.model !== undefined ? "model" : "tier/model");
  lookup("effort", request.effort, fleet.defaults.effort, "effort");
  if (runtime) args.push(...runtime.permission);
  return { args, env };
}

// ─── parsing helpers ──────────────────────────────────────────────────────────

function parseOnBlocked(value: unknown): OnBlockedPolicy {
  if (value === "fail" || value === "escalate") return value;
  if (value === "answer") {
    throw new FleetConfigError(
      'on_blocked = "answer" is not yet supported: what produces the answer is undesigned (SPEC Q8), ' +
        'and auto-answering a permission prompt is the most dangerous thing this engine could do. Use "escalate" or "fail".',
    );
  }
  throw new FleetConfigError(`on_blocked must be "fail" or "escalate"; got ${JSON.stringify(value)}`);
}

function parseRuntimeSection(value: unknown, kind: string): RuntimeConfig {
  const section = asTable(value, `[runtime.${kind}]`);
  assertKnownKeys(section, ["permission", "model", "effort"], `[runtime.${kind}]`);
  const runtime: RuntimeConfig = { permission: [], model: {}, effort: {} };
  if (section.permission !== undefined) {
    runtime.permission = asStringArray(section.permission, `[runtime.${kind}] permission`);
  }
  for (const table of ["model", "effort"] as const) {
    if (section[table] === undefined) continue;
    const entries = asTable(section[table], `[runtime.${kind}] ${table}`);
    for (const [name, delivery] of Object.entries(entries)) {
      runtime[table][name] = parseDelivery(delivery, `[runtime.${kind}] ${table}.${name}`);
    }
  }
  return runtime;
}

/** A delivery is `["--arg", ...]` or `{ args? = [...], env? = { K = "v" } }`. */
function parseDelivery(value: unknown, where: string): RuntimeDelivery {
  if (Array.isArray(value)) return { args: asStringArray(value, where), env: {} };
  const table = asTable(value, where);
  assertKnownKeys(table, ["args", "env"], where);
  const delivery: RuntimeDelivery = { args: [], env: {} };
  if (table.args !== undefined) delivery.args = asStringArray(table.args, `${where} args`);
  if (table.env !== undefined) {
    const env = asTable(table.env, `${where} env`);
    for (const [key, envValue] of Object.entries(env)) {
      if (typeof envValue !== "string") {
        throw new FleetConfigError(`${where} env.${key} must be a string (env values are always strings)`);
      }
      delivery.env[key] = envValue;
    }
  }
  return delivery;
}

function parseMachine(value: unknown, index: number): MachineConfig {
  const where = `[[machine]] #${index + 1}`;
  const table = asTable(value, where);
  assertKnownKeys(table, ["name", "transport", "herdr_bin", "slots", "tags", "kinds", "repos"], where);
  if (table.name === undefined) throw new FleetConfigError(`${where} requires a name`);
  const name = asNonEmptyString(table.name, `${where} name`);
  const transport = parseTransport(table.transport, `${where} ("${name}")`);
  const machine: MachineConfig = { name, transport, tags: [], repos: [] };
  if (table.herdr_bin !== undefined) {
    machine.herdrBin = asNonEmptyString(table.herdr_bin, `${where} herdr_bin`);
    // Absoluteness is validated HERE, at load time (SPEC D13): a relative
    // herdr_bin like "herdr" is a deterministic config typo that would
    // otherwise surface only per-call, deep inside the transport constructor,
    // after a machine slot was already reserved — and be retried identically.
    if (!path.isAbsolute(machine.herdrBin)) {
      throw new FleetConfigError(
        `${where} ("${name}") herdr_bin must be an ABSOLUTE path (got ${JSON.stringify(machine.herdrBin)}) — ` +
          "ssh runs a non-login shell with no usable PATH (SPEC D13)",
      );
    }
  }
  if (transport !== "local" && machine.herdrBin === undefined) {
    throw new FleetConfigError(
      `${where} ("${name}") is remote and must declare herdr_bin — an absolute path; ` +
        "ssh runs a non-login shell with no usable PATH (SPEC D13)",
    );
  }
  if (table.slots !== undefined) {
    const slots = table.slots;
    if (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1) {
      throw new FleetConfigError(`${where} slots must be a positive integer; got ${JSON.stringify(slots)}`);
    }
    machine.slots = slots;
  }
  if (table.tags !== undefined) machine.tags = asStringArray(table.tags, `${where} tags`);
  if (table.kinds !== undefined) machine.kinds = asStringArray(table.kinds, `${where} kinds`);
  if (table.repos !== undefined) machine.repos = asStringArray(table.repos, `${where} repos`);
  return machine;
}

/** "local" | "ssh://user@host" | plain ssh alias (anything else non-empty). */
function parseTransport(value: unknown, where: string): MachineConfig["transport"] {
  if (value === undefined) return "local";
  const text = asNonEmptyString(value, `${where} transport`);
  if (text === "local") return "local";
  if (text.startsWith("ssh://")) {
    const target = text.slice("ssh://".length);
    if (!target) throw new FleetConfigError(`${where} transport "${text}" has an empty ssh target`);
    return { ssh: target };
  }
  return { ssh: text };
}

function asTable(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FleetConfigError(`${where} must be a table`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FleetConfigError(`${where} must be a non-empty string; got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new FleetConfigError(`${where} must be an array of strings`);
  }
  return value as string[];
}

function assertKnownKeys(table: Record<string, unknown>, known: string[], where: string): void {
  for (const key of Object.keys(table)) {
    if (!known.includes(key)) {
      throw new FleetConfigError(`unknown key "${key}" in ${where} (known: ${known.join(", ")}) — fleet config is validated strictly so typos never silently drop`);
    }
  }
}
