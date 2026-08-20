/**
 * Tests for src/fleet/config.ts: fleet.toml parsing (SPEC D4/D12/D15),
 * load-order resolution (--fleet > $HERDR_PLUGIN_CONFIG_DIR/fleet.toml >
 * implicit defaults), the [runtime.<kind>] resolution rules (explicit
 * unresolvable = SCRIPT_VALIDATION_ERROR, implicit unresolvable = silent
 * inherit, permission always appended), and the on_blocked policy gate
 * ("answer" rejected at load time).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import {
  defaultFleetConfig,
  FleetConfigError,
  loadFleetConfig,
  parseFleetToml,
  PLUGIN_ID,
  pluginConfigDir,
  resolveRuntime,
} from "../src/fleet/config.js";

const FULL_EXAMPLE = `
[defaults]
kind = "claude"
model = "sonnet"
effort = "medium"
on_blocked = "escalate"

[runtime.claude]
permission = ["--dangerously-skip-permissions"]
model.opus = ["--model", "opus"]
model.sonnet = ["--model", "sonnet"]
effort.high = { env = { MAX_THINKING_TOKENS = "32000" } }
effort.medium = { env = { MAX_THINKING_TOKENS = "8000" } }

[runtime.codex]
permission = ["--full-auto"]
model.opus = ["--model", "gpt-5.4"]

[[machine]]
name = "local"

[[machine]]
name = "build-mac"
transport = "build-mac"
herdr_bin = "/opt/homebrew/bin/herdr"
slots = 4
tags = ["mac", "arm64"]
kinds = ["claude", "codex"]
repos = ["/Users/alex/Documents/Github/herdr-dynamic-workflow"]
`;

test("parseFleetToml: the full SPEC D4 shape parses and normalizes", () => {
  const fleet = parseFleetToml(FULL_EXAMPLE, "/tmp/fleet.toml");
  assert.equal(fleet.defaults.kind, "claude");
  assert.equal(fleet.defaults.model, "sonnet");
  assert.equal(fleet.defaults.effort, "medium");
  assert.equal(fleet.defaults.onBlocked, "escalate");
  assert.equal(fleet.source, "/tmp/fleet.toml");

  const claude = fleet.runtimes.claude!;
  assert.deepEqual(claude.permission, ["--dangerously-skip-permissions"]);
  // Array form normalizes to {args, env:{}}.
  assert.deepEqual(claude.model.opus, { args: ["--model", "opus"], env: {} });
  // Env form normalizes to {args:[], env}.
  assert.deepEqual(claude.effort.high, { args: [], env: { MAX_THINKING_TOKENS: "32000" } });
  assert.deepEqual(fleet.runtimes.codex!.permission, ["--full-auto"]);

  assert.equal(fleet.machines.length, 2);
  const [local, mac] = fleet.machines;
  assert.equal(local!.name, "local");
  assert.equal(local!.transport, "local", "transport defaults to local");
  assert.equal(mac!.name, "build-mac");
  assert.deepEqual(mac!.transport, { ssh: "build-mac" }, "a plain alias is an ssh target");
  assert.equal(mac!.herdrBin, "/opt/homebrew/bin/herdr");
  assert.equal(mac!.slots, 4);
  assert.deepEqual(mac!.tags, ["mac", "arm64"]);
  assert.deepEqual(mac!.kinds, ["claude", "codex"]);
  assert.deepEqual(mac!.repos, ["/Users/alex/Documents/Github/herdr-dynamic-workflow"]);
});

test("parseFleetToml: ssh:// URLs strip the scheme into the ssh target", () => {
  const fleet = parseFleetToml(`
[[machine]]
name = "buildbox"
transport = "ssh://alex@buildbox.local"
herdr_bin = "/usr/local/bin/herdr"
`);
  assert.deepEqual(fleet.machines[0]!.transport, { ssh: "alex@buildbox.local" });
});

test("defaults: no config means implicit local machine, kind claude, on_blocked fail", () => {
  const fleet = defaultFleetConfig();
  assert.equal(fleet.defaults.kind, "claude");
  assert.equal(fleet.defaults.model, undefined);
  assert.equal(fleet.defaults.effort, undefined);
  assert.equal(fleet.defaults.onBlocked, "fail");
  assert.deepEqual(fleet.runtimes, {});
  assert.equal(fleet.machines.length, 1);
  assert.equal(fleet.machines[0]!.name, "local");
  assert.equal(fleet.machines[0]!.transport, "local");
  assert.equal(fleet.source, undefined);
});

test("a config file with no [[machine]] still gets the implicit local machine", () => {
  const fleet = parseFleetToml(`[defaults]\nkind = "codex"\n`);
  assert.equal(fleet.machines.length, 1);
  assert.equal(fleet.machines[0]!.name, "local");
});

test('on_blocked = "answer" is rejected at config-load time as not yet supported', () => {
  assert.throws(
    () => parseFleetToml(`[defaults]\non_blocked = "answer"\n`),
    (error: unknown) => error instanceof FleetConfigError && /answer.*not (yet )?supported/i.test(error.message),
  );
});

test("on_blocked with an unknown value is a config error", () => {
  assert.throws(
    () => parseFleetToml(`[defaults]\non_blocked = "shrug"\n`),
    (error: unknown) => error instanceof FleetConfigError && /on_blocked/.test(error.message),
  );
});

test("unknown keys are config errors, not silent drops", () => {
  assert.throws(() => parseFleetToml(`[defaults]\nknid = "claude"\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[stuff]\nx = 1\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[[machine]]\nname = "m"\nslot = 2\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[runtime.claude]\npermissions = ["-x"]\n`), FleetConfigError);
});

test("machine validation: names required and unique; remote machines require herdr_bin; slots positive int", () => {
  assert.throws(() => parseFleetToml(`[[machine]]\ntransport = "local"\n`), /name/);
  assert.throws(
    () => parseFleetToml(`[[machine]]\nname = "a"\n\n[[machine]]\nname = "a"\n`),
    /duplicate/i,
  );
  // SPEC D13: herdr_bin is declared per machine, never resolved via PATH.
  assert.throws(
    () => parseFleetToml(`[[machine]]\nname = "remote"\ntransport = "ssh://u@h"\n`),
    /herdr_bin/,
  );
  assert.throws(() => parseFleetToml(`[[machine]]\nname = "m"\nslots = 0\n`), /slots/);
  assert.throws(() => parseFleetToml(`[[machine]]\nname = "m"\nslots = 1.5\n`), /slots/);
});

test("herdr_bin must be an ABSOLUTE path, validated at LOAD time (SPEC D13), not per-call in the transport", () => {
  // A relative herdr_bin like "herdr" is a deterministic config typo. It must
  // be a FleetConfigError at parseMachine time — surfacing it lazily from
  // SshHerdrTransport's constructor happens per call, AFTER a machine slot
  // was reserved, and gets classified recoverable and retried identically.
  assert.throws(
    () => parseFleetToml(`[[machine]]\nname = "remote"\ntransport = "ssh://u@h"\nherdr_bin = "herdr"\n`),
    (error: unknown) => error instanceof FleetConfigError && /ABSOLUTE/.test((error as Error).message),
  );
  assert.throws(
    () => parseFleetToml(`[[machine]]\nname = "m"\nherdr_bin = "bin/herdr"\n`),
    /ABSOLUTE/,
    "a declared herdr_bin is validated on local machines too",
  );
  const fleet = parseFleetToml(`[[machine]]\nname = "remote"\ntransport = "ssh://u@h"\nherdr_bin = "/opt/homebrew/bin/herdr"\n`);
  assert.equal(fleet.machines[0]!.herdrBin, "/opt/homebrew/bin/herdr");
});

test("runtime delivery values reject shapes that are neither [args] nor {args?, env?}", () => {
  assert.throws(() => parseFleetToml(`[runtime.claude]\nmodel.opus = "opus"\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[runtime.claude]\nmodel.opus = [1, 2]\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[runtime.claude]\nmodel.opus = { flags = ["-m"] }\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[runtime.claude]\neffort.high = { env = { N = 5 } }\n`), FleetConfigError);
  assert.throws(() => parseFleetToml(`[runtime.claude]\npermission = "not-a-list"\n`), FleetConfigError);
});

// ─── loadFleetConfig resolution order ─────────────────────────────────────────

test("loadFleetConfig: explicit path > $HERDR_PLUGIN_CONFIG_DIR/fleet.toml > defaults", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-cfg-"));
  try {
    const explicit = path.join(dir, "explicit.toml");
    writeFileSync(explicit, `[defaults]\nkind = "codex"\n`);
    const configDir = path.join(dir, "plugin-config");
    rmSync(configDir, { recursive: true, force: true });
    // Explicit path wins even when the env dir is set.
    writeFileSync(explicit, `[defaults]\nkind = "codex"\n`);
    const fromExplicit = loadFleetConfig({ fleetPath: explicit, env: { HERDR_PLUGIN_CONFIG_DIR: dir } });
    assert.equal(fromExplicit.defaults.kind, "codex");
    assert.equal(fromExplicit.source, explicit);

    // Env dir with a fleet.toml.
    writeFileSync(path.join(dir, "fleet.toml"), `[defaults]\nkind = "pi"\n`);
    const fromEnv = loadFleetConfig({ env: { HERDR_PLUGIN_CONFIG_DIR: dir } });
    assert.equal(fromEnv.defaults.kind, "pi");
    assert.equal(fromEnv.source, path.join(dir, "fleet.toml"));

    // Env dir without a fleet.toml falls back to defaults.
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), "fleet-empty-"));
    try {
      const fallback = loadFleetConfig({ env: { HERDR_PLUGIN_CONFIG_DIR: emptyDir } });
      assert.equal(fallback.defaults.kind, "claude");
      assert.equal(fallback.source, undefined);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // No path, no env (XDG pinned to an empty dir so the machine's real
    // ~/.config/herdr can't leak in): implicit defaults.
    const emptyXdg = mkdtempSync(path.join(os.tmpdir(), "fleet-xdg-empty-"));
    try {
      const none = loadFleetConfig({ env: { XDG_CONFIG_HOME: emptyXdg } });
      assert.equal(none.defaults.kind, "claude");
      assert.equal(none.source, undefined);
    } finally {
      rmSync(emptyXdg, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFleetConfig standalone: with no injected env dir, the CONVENTIONAL plugin config dir's fleet.toml loads", () => {
  // An internal standalone entry-point gets no HERDR_PLUGIN_CONFIG_DIR
  // (Herdr injects it only for plugin-invoked processes), yet must see the
  // same fleet.toml — the file the authoring skill tells authors to read via
  // `herdr plugin config-dir herdrflow.engine`. The conventional path is
  // computed the way herdr computes it: <config dir>/plugins/config/<id>,
  // XDG_CONFIG_HOME-aware.
  const xdg = mkdtempSync(path.join(os.tmpdir(), "fleet-xdg-"));
  try {
    const conventional = pluginConfigDir({ XDG_CONFIG_HOME: xdg });
    assert.equal(conventional, path.join(xdg, "herdr", "plugins", "config", PLUGIN_ID));
    mkdirSync(conventional, { recursive: true });
    writeFileSync(path.join(conventional, "fleet.toml"), `[defaults]\nkind = "gemini"\n`);

    const loaded = loadFleetConfig({ env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(loaded.defaults.kind, "gemini");
    assert.equal(loaded.source, path.join(conventional, "fleet.toml"));

    // The Herdr-injected dir stays authoritative when present, even without
    // its own fleet.toml: injected-but-empty means "this plugin has no fleet
    // config", never a second lookup somewhere else.
    const injectedEmpty = mkdtempSync(path.join(os.tmpdir(), "fleet-injected-"));
    try {
      const viaInjected = loadFleetConfig({
        env: { XDG_CONFIG_HOME: xdg, HERDR_PLUGIN_CONFIG_DIR: injectedEmpty },
      });
      assert.equal(viaInjected.defaults.kind, "claude");
      assert.equal(viaInjected.source, undefined);
    } finally {
      rmSync(injectedEmpty, { recursive: true, force: true });
    }
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("loadFleetConfig: an explicit --fleet path that does not exist is an error, never a silent default", () => {
  assert.throws(
    () => loadFleetConfig({ fleetPath: "/nonexistent/fleet.toml", env: {} }),
    (error: unknown) => error instanceof FleetConfigError && /nonexistent/.test(error.message),
  );
});

// ─── resolveRuntime ───────────────────────────────────────────────────────────

test("resolveRuntime: explicit model + effort resolve to args/env, permission always appended", () => {
  const fleet = parseFleetToml(FULL_EXAMPLE);
  const resolved = resolveRuntime(fleet, "claude", { model: "opus", effort: "high" });
  assert.deepEqual(resolved.args, ["--model", "opus", "--dangerously-skip-permissions"]);
  assert.deepEqual(resolved.env, { MAX_THINKING_TOKENS: "32000" });
});

test("resolveRuntime: tier resolves through the model table when no explicit model is set", () => {
  const fleet = parseFleetToml(`
[runtime.codex]
model.big = ["--model", "gpt-5.4-xl"]
`);
  const resolved = resolveRuntime(fleet, "codex", { tier: "big" });
  assert.deepEqual(resolved.args, ["--model", "gpt-5.4-xl"]);
  // Explicit model beats tier.
  assert.throws(
    () => resolveRuntime(fleet, "codex", { model: "nope", tier: "big" }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
});

test("resolveRuntime: UNRESOLVABLE explicit values are SCRIPT_VALIDATION_ERROR, non-recoverable", () => {
  const fleet = parseFleetToml(FULL_EXAMPLE);
  for (const request of [{ model: "haiku9" }, { effort: "ultra" }, { tier: "gigantic" }]) {
    assert.throws(
      () => resolveRuntime(fleet, "claude", request, "worker"),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /fleet/i);
        return true;
      },
    );
  }
  // A kind with no [runtime.<kind>] section at all cannot resolve any explicit value.
  assert.throws(
    () => resolveRuntime(fleet, "pi", { model: "opus" }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
});

test("resolveRuntime: absent implicit values inherit silently — no args, no error", () => {
  // defaults.model = "sonnet" resolves for claude but has no codex entry: a
  // codex call with NO explicit model must inherit silently, not error.
  const fleet = parseFleetToml(FULL_EXAMPLE);
  const codex = resolveRuntime(fleet, "codex", {});
  assert.deepEqual(codex.args, ["--full-auto"], "only permission args; the unresolvable implicit default is skipped");
  assert.deepEqual(codex.env, {});

  // For claude the implicit defaults DO resolve.
  const claude = resolveRuntime(fleet, "claude", {});
  assert.deepEqual(claude.args, ["--model", "sonnet", "--dangerously-skip-permissions"]);
  assert.deepEqual(claude.env, { MAX_THINKING_TOKENS: "8000" });
});

test("resolveRuntime: no fleet config and no explicit values resolves to nothing at all", () => {
  const resolved = resolveRuntime(defaultFleetConfig(), "claude", {});
  assert.deepEqual(resolved.args, []);
  assert.deepEqual(resolved.env, {});
});

test("resolveRuntime: no fleet config with an explicit model is a validation error (never a silent drop)", () => {
  assert.throws(
    () => resolveRuntime(defaultFleetConfig(), "claude", { model: "opus" }, "worker"),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /opus/);
      return true;
    },
  );
});
