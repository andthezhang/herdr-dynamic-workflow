/**
 * Tests for the zero-config session resolution (src/plugin/shared.ts
 * resolveSessionTarget): default-session-first fallback order, worker-session
 * autostart via the injectable spawn seam, explicit --session precedence, the
 * resume same-place contract (sessionMode persisted in the journal), and the
 * honest success envelope (no tokenUsage — herdr has no token signal).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKER_SESSION,
  defaultSessionSocketPath,
  type JournalDocument,
  journalPath,
  latestRunId,
  loadJournal,
  resolveSessionTarget,
  saveJournal,
  sessionSocketPath,
  successEnvelope,
} from "../src/plugin/shared.js";

/** Probe fake: records every probed path; answers from a mutable truth table. */
function fakeProbe(connectable: Set<string>): { probe: (p: string) => Promise<boolean>; probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    probe: async (socketPath: string) => {
      probed.push(socketPath);
      return connectable.has(socketPath);
    },
  };
}

test("zero-config: the user's own default session wins when its socket is connectable", async () => {
  const own = defaultSessionSocketPath();
  const { probe, probed } = fakeProbe(new Set([own]));
  const spawned: string[] = [];
  const target = await resolveSessionTarget({}, { probe, spawnServer: (s) => spawned.push(s) });
  assert.deepEqual(target, { session: DEFAULT_WORKER_SESSION, socketPath: own, mode: "default" });
  // The worker session NAME stays "flow" even in default mode — remote
  // ssh hosts and attach commands must never see a session named "default".
  assert.notEqual(target.session, "default");
  assert.deepEqual(probed, [own], "a connectable default session ends resolution");
  assert.deepEqual(spawned, [], "no autostart when the default session answers");
});

test("fallback: default session unreachable, worker session already running -> worker, no spawn", async () => {
  const worker = sessionSocketPath(DEFAULT_WORKER_SESSION);
  const { probe, probed } = fakeProbe(new Set([worker]));
  const spawned: string[] = [];
  const target = await resolveSessionTarget({}, { probe, spawnServer: (s) => spawned.push(s) });
  assert.deepEqual(target, { session: "flow", socketPath: worker, mode: "worker" });
  assert.deepEqual(probed, [defaultSessionSocketPath(), worker], "default probed first, then the worker socket");
  assert.deepEqual(spawned, []);
});

test("autostart: neither socket connectable -> spawns the flow server once and waits for its socket", async () => {
  const worker = sessionSocketPath(DEFAULT_WORKER_SESSION);
  const connectable = new Set<string>();
  const { probe } = fakeProbe(connectable);
  const spawned: string[] = [];
  const target = await resolveSessionTarget(
    {},
    {
      probe,
      spawnServer: (session) => {
        spawned.push(session);
        // The server "comes up": the socket becomes connectable after spawn.
        connectable.add(worker);
      },
      autostartTimeoutMs: 500,
      pollMs: 1,
    },
  );
  assert.deepEqual(spawned, ["flow"], "exactly one spawn, of the flow worker session");
  assert.deepEqual(target, { session: "flow", socketPath: worker, mode: "worker" });
});

test("autostart failure: the socket never comes up -> a clear bounded-timeout error", async () => {
  const { probe } = fakeProbe(new Set());
  const spawned: string[] = [];
  await assert.rejects(
    resolveSessionTarget({}, { probe, spawnServer: (s) => spawned.push(s), autostartTimeoutMs: 30, pollMs: 1 }),
    /worker session "flow" server did not come up within 30ms/,
  );
  assert.deepEqual(spawned, ["flow"]);
});

test("an explicit --session always wins: named worker session, default never probed", async () => {
  const named = sessionSocketPath("myflow");
  const { probe, probed } = fakeProbe(new Set([named, defaultSessionSocketPath()]));
  const target = await resolveSessionTarget({ explicitSession: "myflow" }, { probe, spawnServer: () => {} });
  assert.deepEqual(target, { session: "myflow", socketPath: named, mode: "worker" });
  assert.ok(!probed.includes(defaultSessionSocketPath()), "explicit --session skips the default-session probe");
});

test("an explicit --session autostarts its named worker session when needed", async () => {
  const named = sessionSocketPath("myflow");
  const connectable = new Set<string>([defaultSessionSocketPath()]);
  const { probe, probed } = fakeProbe(connectable);
  const spawned: string[] = [];
  const target = await resolveSessionTarget(
    { explicitSession: "myflow" },
    {
      probe,
      spawnServer: (session) => {
        spawned.push(session);
        connectable.add(named);
      },
      autostartTimeoutMs: 500,
      pollMs: 1,
    },
  );
  assert.deepEqual(spawned, ["myflow"]);
  assert.deepEqual(target, { session: "myflow", socketPath: named, mode: "worker" });
  assert.ok(!probed.includes(defaultSessionSocketPath()));
});

test("resume, worker-mode journal (or a pre-mode journal): straight to its worker session, default never probed", async () => {
  const worker = sessionSocketPath("flow");
  const { probe, probed } = fakeProbe(new Set([worker, defaultSessionSocketPath()]));
  // preferDefault: doc.sessionMode === "default" — false for "worker" and for
  // journals persisted before sessionMode existed (undefined).
  const target = await resolveSessionTarget(
    { workerSession: "flow", preferDefault: false },
    { probe, spawnServer: () => {} },
  );
  assert.deepEqual(target, { session: "flow", socketPath: worker, mode: "worker" });
  assert.ok(!probed.includes(defaultSessionSocketPath()), "a worker-mode run must resume in its worker session");
});

test("resume, default-mode journal: re-probes the user's session and returns there", async () => {
  const own = defaultSessionSocketPath();
  const { probe } = fakeProbe(new Set([own]));
  const target = await resolveSessionTarget(
    { workerSession: "flow", preferDefault: true },
    { probe, spawnServer: () => {} },
  );
  assert.deepEqual(target, { session: "flow", socketPath: own, mode: "default" });
});

test("the journal persists sessionMode so resume can resolve the same place", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-mode-"));
  try {
    const doc: JournalDocument = {
      version: 1,
      runId: "run-mode",
      session: "flow",
      sessionMode: "default",
      kind: "claude",
      script: "return 1",
      entries: [],
    };
    saveJournal(stateDir, doc);
    assert.equal(loadJournal(stateDir, "run-mode").sessionMode, "default");
    // Pre-mode journals load with sessionMode undefined (treated as "worker").
    saveJournal(stateDir, { ...doc, runId: "run-old", sessionMode: undefined });
    assert.equal(loadJournal(stateDir, "run-old").sessionMode, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("success envelope: agentCount + durationMs, and NO tokenUsage (herdr has no token signal)", () => {
  const outcome = {
    meta: { name: "wf" },
    result: { done: true },
    phases: ["a"],
    agentCount: 3,
    durationMs: 1234,
    // Engine internals may still carry tokenUsage; the envelope must not.
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0 },
  };
  const envelope = successEnvelope("run-x", outcome);
  assert.deepEqual(Object.keys(envelope), ["ok", "runId", "workflow", "result", "phases", "agentCount", "durationMs"]);
  assert.deepEqual(envelope, {
    ok: true,
    runId: "run-x",
    workflow: "wf",
    result: { done: true },
    phases: ["a"],
    agentCount: 3,
    durationMs: 1234,
  });
  const resumed = successEnvelope("run-x", outcome, { resumed: true });
  assert.equal(resumed.resumed, true);
  assert.ok(!("tokenUsage" in resumed));
  const kept = successEnvelope("run-x", outcome, { workspace: "PR 412 · ab12", kept: true });
  assert.equal(kept.workspace, "PR 412 · ab12");
  assert.equal(kept.kept, true);
  assert.ok(!("tokenUsage" in kept));
});

test('the reserved session name "default" is rejected as a worker name (explicit --session and journal alike)', async () => {
  // herdr reserves "default" for the user's own root session (src/session.rs
  // normalize_name -> the ~/.config/herdr/herdr.sock socket, NOT
  // sessions/default/): accepting it would poll a socket herdr never creates
  // while `herdr --session default server` binds the user's personal
  // session — and over ssh it would drive another host's default session.
  const { probe, probed } = fakeProbe(new Set());
  const spawned: string[] = [];
  const deps = { probe, spawnServer: (s: string) => spawned.push(s) };
  await assert.rejects(resolveSessionTarget({ explicitSession: "default" }, deps), /reserved by herdr/);
  await assert.rejects(resolveSessionTarget({ workerSession: "default", preferDefault: false }, deps), /reserved by herdr/);
  assert.deepEqual(probed, [], "rejection must happen before any probe");
  assert.deepEqual(spawned, [], "and before any server is spawned");
});

test("socket paths honor XDG_CONFIG_HOME exactly as herdr's config_dir does", () => {
  // herdr src/config/io.rs config_dir(): $XDG_CONFIG_HOME/herdr when set,
  // else ~/.config/herdr. With XDG set and these paths hardcoded to
  // ~/.config, the default-session probe would miss the user's live session
  // and the autostart would poll a socket the spawned server never binds.
  const xdg = { XDG_CONFIG_HOME: "/custom/xdg" };
  assert.equal(defaultSessionSocketPath(xdg), path.join("/custom/xdg", "herdr", "herdr.sock"));
  assert.equal(sessionSocketPath("flow", xdg), path.join("/custom/xdg", "herdr", "sessions", "flow", "herdr.sock"));
  // Unset (and empty, per the XDG spec) falls back to ~/.config/herdr.
  for (const env of [{}, { XDG_CONFIG_HOME: "" }, { XDG_CONFIG_HOME: "   " }]) {
    assert.equal(defaultSessionSocketPath(env), path.join(os.homedir(), ".config", "herdr", "herdr.sock"));
    assert.equal(
      sessionSocketPath("flow", env),
      path.join(os.homedir(), ".config", "herdr", "sessions", "flow", "herdr.sock"),
    );
  }
});

test('latestRunId picks the most recently WRITTEN journal — resume.js\'s no-argument "last run" default', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-latest-"));
  try {
    assert.equal(latestRunId(stateDir), undefined, "no runs dir -> undefined (a clear usage error, not a crash)");
    const doc = (runId: string): JournalDocument => ({
      version: 1,
      runId,
      session: "flow",
      kind: "claude",
      script: "return 1",
      entries: [],
    });
    saveJournal(stateDir, doc("run-old"));
    saveJournal(stateDir, doc("run-new"));
    // mtime is the recency signal (journals re-save after every agent call),
    // so re-saving the OLD run makes it the last run again.
    utimesSync(journalPath(stateDir, "run-old"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    assert.equal(latestRunId(stateDir), "run-new");
    saveJournal(stateDir, doc("run-old"));
    utimesSync(journalPath(stateDir, "run-new"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    assert.equal(latestRunId(stateDir), "run-old");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
