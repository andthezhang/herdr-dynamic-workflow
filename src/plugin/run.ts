/**
 * Plugin action "run": execute a workflow script against a Herdr session.
 *
 *   herdr plugin action invoke herdrflow.engine.run -- <workflow.js> [--cwd <path>] [--session <name>] [--kind claude] [--fleet <fleet.toml>]
 *
 * ZERO-CONFIG PLACEMENT: with no --session, local workers run in the USER'S
 * OWN default session when its socket is connectable — the run's workspace
 * (labeled after the workflow) appears live in their sidebar. Otherwise the
 * hidden worker session "flow" is used, its headless server autostarted if
 * needed. An explicit --session <name> always targets that named worker
 * session. Remote machines always use the named worker session either way.
 *
 * Worker-session socket paths are computed from the session name
 * (~/.config/herdr/sessions/<name>/herdr.sock) — never HERDR_SOCKET_PATH,
 * which inside a Herdr pane points at the user's own host session.
 * State (agent output files + the resume journal) lives under
 * HERDR_PLUGIN_STATE_DIR, falling back to ~/.local/state/herdr-dynamic-workflow.
 *
 * Fleet/runtime config (SPEC D4/D12/D15, docs/fleet.md): `--fleet <path>`,
 * else $HERDR_PLUGIN_CONFIG_DIR/fleet.toml when present, else (standalone)
 * the conventional plugin config dir's fleet.toml, else the implicit
 * single-local-machine default.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  HerdrAgentRunner,
  loadFleetConfig,
  parseWorkflowScript,
  runWorkflow,
  type JournalEntry,
} from "../index.js";
import {
  type JournalDocument,
  newRunId,
  parseArgs,
  resolveInvocationCwd,
  resolveSessionTarget,
  resolveStateDir,
  saveJournal,
  successEnvelope,
  upsertJournalEntry,
} from "./shared.js";

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const scriptPath = positionals[0];
  if (!scriptPath) {
    process.stderr.write(
      "usage: herdr plugin action invoke herdrflow.engine.run -- <workflow.js> " +
        "[--cwd <path>] [--session <name>] [--kind claude] [--fleet <fleet.toml>]\n",
    );
    process.exitCode = 2;
    return;
  }

  // Herdr runs plugin commands from the plugin root; workflows must instead
  // inherit the invoking pane/workspace cwd. Standalone execution keeps the
  // shell cwd for backwards compatibility.
  const invocationCwd = resolveInvocationCwd();
  const cwdFlag = flags.get("cwd");
  const cwd = cwdFlag ? path.resolve(invocationCwd, cwdFlag) : invocationCwd;
  // Fleet/runtime config (SPEC D4): --fleet path (missing file = error), else
  // $HERDR_PLUGIN_CONFIG_DIR/fleet.toml, else the implicit local default.
  // Loaded before anything else so a bad config fails fast.
  const fleetPath = flags.get("fleet");
  const fleet = loadFleetConfig({
    fleetPath: fleetPath ? path.resolve(cwd, fleetPath) : undefined,
    env: process.env,
  });
  const kind = flags.get("kind") ?? fleet.defaults.kind;
  const stateDir = resolveStateDir();
  const runId = newRunId();
  const script = await readFile(path.resolve(cwd, scriptPath), "utf8");

  // Parse meta BEFORE any session/socket work: the workspace label leads with
  // the workflow's name, and a script that fails to parse must fail with the
  // same envelope shape as any other run failure.
  let workflowName: string;
  try {
    workflowName = parseWorkflowScript(script).meta.name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, runId, error: message })}\n`);
    process.exitCode = 1;
    return;
  }
  // The sidebar workspace label: workflow name first (sidebars are 10–30 cols
  // wide, so truncation keeps the name visible), last-4 of the run id to tell
  // concurrent runs of the same workflow apart.
  const workspaceLabel = `${workflowName} · ${runId.slice(-4)}`;

  // ZERO-CONFIG VISIBILITY: user's own session when reachable, else the
  // "flow" worker session (autostarted); an explicit --session always wins.
  // Both this and the runner's construction-time validation (e.g. the broken
  // agent-kind guard) fail with the same envelope as a run failure.
  let target;
  let runner: HerdrAgentRunner;
  try {
    target = await resolveSessionTarget({ explicitSession: flags.get("session") });
    runner = new HerdrAgentRunner({
      socketPath: target.socketPath,
      // Agent output files live under the OS temp dir, NOT the plugin state
      // dir: codex's workspace-write sandbox rejects writes outside its cwd and
      // $TMPDIR (measured live), so an out path under ~/.local/state can never
      // be written by a sandboxed CLI. The journal keeps using stateDir.
      stateDir: path.join(os.tmpdir(), "herdr-flow"),
      // cwd: agent tabs open in the workflow's own directory unless a call
      // overrides it (worktree isolation).
      defaults: { kind, cwd },
      workspaceLabel,
      fleet,
      // The worker session name: remote machines are driven under it, and
      // escalation records print attach commands with it. NEVER "default" —
      // even when local placement targets the user's own session.
      session: target.session,
      // …and the MODE tells the runner where the local socket actually lives,
      // so a local escalation in default mode prints `herdr agent attach …`
      // (no --session — the pane is in the user's own session).
      localSessionMode: target.mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, runId, error: message })}\n`);
    process.exitCode = 1;
    return;
  }

  const doc: JournalDocument = {
    version: 1,
    runId,
    session: target.session,
    sessionMode: target.mode,
    kind,
    cwd,
    script,
    entries: [],
  };
  const onAgentJournal = (entry: JournalEntry): void => {
    upsertJournalEntry(doc, entry);
    saveJournal(stateDir, doc);
  };

  try {
    const outcome = await runWorkflow(script, {
      agent: runner,
      runId,
      stateDir,
      cwd,
      // Real coding-agent CLIs drift on the output contract (answer inline,
      // skip the file) — recoverable failures get a second and third try
      // instead of collapsing to null on the first flake.
      agentRetries: 2,
      onAgentJournal,
      onLog: (message) => process.stderr.write(`${message}\n`),
      onPhase: (title) => process.stderr.write(`== ${title}\n`),
    });
    process.stdout.write(`${JSON.stringify(successEnvelope(runId, outcome), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, runId, error: message })}\n`);
    process.exitCode = 1;
  } finally {
    // Async: closes the run's workspace in the target session, then the socket.
    await runner.close();
  }
}

void main();
