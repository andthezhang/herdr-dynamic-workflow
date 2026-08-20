/**
 * Plugin action "resume": re-run a previously journaled workflow, replaying
 * the longest-unchanged prefix of agent results from the persisted journal.
 *
 *   herdr plugin action invoke herdrflow.engine.resume -- [--run <runId>] [--cwd <path>] [--session <name>] [--kind <kind>] [--fleet <fleet.toml>]
 *
 * The journal document under <stateDir>/runs/<runId>.json carries the exact
 * script text that ran, so nothing but the run id is required — and even that
 * defaults to the most recently written journal ("resume the last run"),
 * which also keeps the manifest's argument-less "Resume last run" action useful.
 *
 * PLACEMENT resolves the same way run.js resolves it: the journal records
 * which session mode the run used (the user's own "default" session vs a
 * named worker session), and resume goes back to the same place — a
 * default-mode run re-probes the user's session (falling back to the worker
 * session), a worker-mode run goes straight to its worker session
 * (autostarting the server when needed). An explicit --session always wins.
 *
 * The fleet config is loaded the same way run.js loads it. Note SPEC D4/D6:
 * the resolved runtime args/env are part of each call's hash, so resuming
 * under an EDITED fleet config correctly re-runs the calls whose resolution
 * changed instead of replaying results produced under the old flags.
 */
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
  latestRunId,
  loadJournal,
  parseArgs,
  resolveInvocationCwd,
  resolveSessionTarget,
  resolveStateDir,
  saveJournal,
  successEnvelope,
  toResumeMap,
  upsertJournalEntry,
} from "./shared.js";

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const stateDir = resolveStateDir();
  // No --run: resume the last run (most recently written journal).
  const runId = flags.get("run") ?? latestRunId(stateDir);
  if (!runId) {
    process.stderr.write(
      "resume.js: no journaled runs to resume " +
        `(none under ${path.join(stateDir, "runs")}). ` +
        "usage: herdr plugin action invoke herdrflow.engine.resume -- " +
        "[--run <runId>] [--cwd <path>] [--session <name>] [--kind <kind>] [--fleet <fleet.toml>]\n",
    );
    process.exitCode = 2;
    return;
  }

  const doc = loadJournal(stateDir, runId);
  const invocationCwd = resolveInvocationCwd();
  const cwdFlag = flags.get("cwd");
  const cwd = cwdFlag ? path.resolve(invocationCwd, cwdFlag) : (doc.cwd ?? invocationCwd);
  const fleetPath = flags.get("fleet");
  const fleet = loadFleetConfig({
    fleetPath: fleetPath ? path.resolve(cwd, fleetPath) : undefined,
    env: process.env,
  });
  // The journal's recorded kind beats the fleet default: resume replays what ran.
  const kind = flags.get("kind") ?? doc.kind ?? fleet.defaults.kind;
  const resumeJournal = toResumeMap(doc);
  // Same sidebar label the run used: the workflow's name leads, last-4 of the
  // run id disambiguates. The journaled script already parsed once to run.
  let workspaceLabel: string | undefined;
  try {
    workspaceLabel = `${parseWorkflowScript(doc.script).meta.name} · ${runId.slice(-4)}`;
  } catch {
    // Leave the runner's flow/<runId> fallback to name the workspace.
  }

  let runner: HerdrAgentRunner;
  try {
    // Same place the run used: journals persisted before sessionMode existed
    // were always worker-session runs, so only an explicit "default" record
    // re-probes the user's own session.
    const target = await resolveSessionTarget({
      explicitSession: flags.get("session"),
      workerSession: doc.session,
      preferDefault: doc.sessionMode === "default",
    });
    doc.session = target.session;
    doc.sessionMode = target.mode;
    runner = new HerdrAgentRunner({
      socketPath: target.socketPath,
      // Sandbox-writable out-file root (codex rejects writes outside cwd and
      // $TMPDIR — see run.ts); the journal keeps using stateDir.
      stateDir: path.join(os.tmpdir(), "herdr-flow"),
      // cwd: agent tabs open in the workflow's own directory unless a call
      // overrides it (worktree isolation).
      defaults: { kind, cwd },
      workspaceLabel,
      fleet,
      session: target.session,
      // Local escalation attach commands depend on where the local socket
      // actually lives (see run.ts): no --session in default mode.
      localSessionMode: target.mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, runId, error: message })}\n`);
    process.exitCode = 1;
    return;
  }

  // Live (non-replayed) agents append to the same journal document; entries
  // are keyed by `${runId}:${index}`, so replace rather than duplicate.
  const onAgentJournal = (entry: JournalEntry): void => {
    upsertJournalEntry(doc, entry);
    saveJournal(stateDir, doc);
  };

  try {
    const outcome = await runWorkflow(doc.script, {
      agent: runner,
      runId,
      resumeFromRunId: runId,
      resumeJournal,
      // Same drift tolerance as run.ts: retry recoverable agent failures.
      agentRetries: 2,
      stateDir,
      cwd,
      onAgentJournal,
      onLog: (message) => process.stderr.write(`${message}\n`),
      onPhase: (title) => process.stderr.write(`== ${title}\n`),
    });
    process.stdout.write(`${JSON.stringify(successEnvelope(runId, outcome, { resumed: true }), null, 2)}\n`);
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
