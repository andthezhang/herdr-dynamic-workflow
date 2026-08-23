/**
 * Tests for the plugin persistence glue (src/plugin/shared.ts) — the layer
 * production resume actually depends on: saveJournal/loadJournal round trips,
 * toResumeMap's engine-compatible `${runId}:${index}` keys (including the
 * legacy no-runId fallback), upsertJournalEntry's replace-not-duplicate
 * contract, and — the load-bearing part — that a journal persisted through
 * this glue really replays through runWorkflow's resume path, so a key-format
 * drift between the engine and the plugin cannot stay green.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type JournalEntry, runWorkflow } from "../src/engine/workflow.js";
import {
  type JournalDocument,
  journalEntryKey,
  journalPath,
  loadJournal,
  newRunId,
  formatWorkspaceLabel,
  parseArgs,
  resolveInvocationCwd,
  saveJournal,
  toResumeMap,
  upsertJournalEntry,
} from "../src/plugin/shared.js";

function tempStateDir(): { stateDir: string; cleanup: () => void } {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-flow-plugin-"));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

function docWith(entries: JournalEntry[], runId = "run-doc"): JournalDocument {
  return { version: 1, runId, session: "flow", kind: "codex", script: "return 1", entries };
}

test("saveJournal/loadJournal round-trips a journal document", () => {
  const { stateDir, cleanup } = tempStateDir();
  try {
    const doc = docWith([
      { index: 0, runId: "run-doc", hash: "h0", result: "first", storeDelta: { k: "v" } },
      { index: 1, runId: "run-doc-nested1", hash: "h1", result: { ok: true } },
    ]);
    saveJournal(stateDir, doc);
    const loaded = loadJournal(stateDir, "run-doc");
    assert.deepEqual(loaded, doc);
    // Stored where resume expects it: <stateDir>/runs/<runId>.json.
    assert.equal(journalPath(stateDir, "run-doc"), path.join(stateDir, "runs", "run-doc.json"));
    assert.ok(readFileSync(journalPath(stateDir, "run-doc"), "utf8").includes('"version": 1'));
  } finally {
    cleanup();
  }
});

test("loadJournal rejects a non-v1 or malformed document", () => {
  const { stateDir, cleanup } = tempStateDir();
  try {
    saveJournal(stateDir, { ...docWith([]), version: 2 as unknown as 1, runId: "bad-version" });
    assert.throws(() => loadJournal(stateDir, "bad-version"), /not a v1 journal document/);
  } finally {
    cleanup();
  }
});

test("toResumeMap uses the engine's `${runId}:${index}` keys, with the legacy doc.runId fallback", () => {
  const doc = docWith([
    { index: 0, runId: "run-doc", hash: "h0", result: "a" },
    // Legacy entry persisted before JournalEntry.runId existed.
    { index: 1, hash: "h1", result: "b" },
    // Nested-frame entry: its own runId must win over the document's.
    { index: 0, runId: "run-doc-nested1", hash: "h2", result: "c" },
  ]);
  const map = toResumeMap(doc);
  assert.deepEqual(
    [...map.keys()].sort(),
    ["run-doc-nested1:0", "run-doc:0", "run-doc:1"].sort(),
  );
  assert.equal(map.get("run-doc:1")?.result, "b", "a legacy entry keys under the document's own runId");
  assert.equal(map.get("run-doc-nested1:0")?.result, "c");
});

test("upsertJournalEntry replaces an existing entry instead of duplicating it", () => {
  const doc = docWith([{ index: 0, runId: "run-doc", hash: "h0", result: "old" }]);
  // Same key (including via the legacy fallback: entry without runId collides
  // with an existing doc.runId-keyed entry) -> replace.
  upsertJournalEntry(doc, { index: 0, hash: "h0-updated", result: "new" });
  assert.equal(doc.entries.length, 1, "re-journaling the same call must not duplicate it");
  assert.equal(doc.entries[0]?.result, "new");
  assert.equal(journalEntryKey(doc.entries[0]!, doc), "run-doc:0");
  // Different key -> append, order preserved.
  upsertJournalEntry(doc, { index: 1, runId: "run-doc", hash: "h1", result: "next" });
  assert.deepEqual(
    doc.entries.map((entry) => journalEntryKey(entry, doc)),
    ["run-doc:0", "run-doc:1"],
  );
});

test("a journal persisted through the plugin glue replays through runWorkflow resume (key-format compatibility)", async () => {
  const { stateDir, cleanup } = tempStateDir();
  const script = `export const meta = { name: 'glue', description: 'plugin glue round trip' }
const a = await agent('first task', { label: 'a' })
const b = await agent('second task', { label: 'b' })
return [a, b]`;
  const runId = "run-glue";
  try {
    // First run: journal every agent through the SAME glue run.ts uses
    // (upsertJournalEntry + saveJournal), then persist to disk.
    const doc: JournalDocument = { version: 1, runId, session: "flow", kind: "codex", script, entries: [] };
    let liveCalls = 0;
    const first = await runWorkflow(script, {
      agent: {
        async run(prompt: string) {
          liveCalls++;
          return `live:${prompt}`;
        },
      },
      persistLogs: false,
      runId,
      onAgentJournal: (entry) => {
        upsertJournalEntry(doc, entry);
        saveJournal(stateDir, doc);
      },
    });
    assert.equal(liveCalls, 2);
    // Array.from: the script's result array was built inside the sandbox realm,
    // so deepStrictEqual would trip on its foreign Array prototype.
    assert.deepEqual(Array.from(first.result as unknown[]), ["live:first task", "live:second task"]);

    // Resume exactly as resume.ts does: reload from disk, rebuild the map with
    // toResumeMap, and feed it to the engine. Every call must replay from the
    // journal — a key-format drift between engine and plugin would cache-miss
    // here and run live.
    const reloaded = loadJournal(stateDir, runId);
    assert.equal(reloaded.entries.length, 2);
    let resumedCalls = 0;
    const resumed = await runWorkflow(reloaded.script, {
      agent: {
        async run(prompt: string) {
          resumedCalls++;
          return `re-ran:${prompt}`;
        },
      },
      persistLogs: false,
      runId,
      resumeFromRunId: runId,
      resumeJournal: toResumeMap(reloaded),
      onAgentJournal: (entry) => {
        upsertJournalEntry(reloaded, entry);
        saveJournal(stateDir, reloaded);
      },
    });
    assert.equal(resumedCalls, 0, "an unchanged script must replay entirely from the persisted journal");
    assert.deepEqual(Array.from(resumed.result as unknown[]), ["live:first task", "live:second task"]);
    assert.equal(loadJournal(stateDir, runId).entries.length, 2, "replay must not duplicate journal entries");
  } finally {
    cleanup();
  }
});

test("parseArgs splits positionals from --name value flags and rejects missing values", () => {
  assert.deepEqual(parseArgs(["wf.js", "--session", "flow", "--kind", "claude"]), {
    positionals: ["wf.js"],
    flags: new Map([
      ["session", "flow"],
      ["kind", "claude"],
    ]),
  });
  assert.throws(() => parseArgs(["--run"]), /missing value for --run/);
  assert.throws(() => parseArgs(["--run", "--session"]), /missing value for --run/);
  // Declared boolean flags consume no value.
  assert.deepEqual(parseArgs(["wf.js", "--verbose", "pos"], new Set(["verbose"])), {
    positionals: ["wf.js", "pos"],
    flags: new Map([["verbose", "true"]]),
  });
});

test("formatWorkspaceLabel leads with the caller name and suffixes last-4 of runId", () => {
  assert.equal(formatWorkspaceLabel("PR 412 reviews", "run-mt5cpbpy-i2ab"), "PR 412 reviews · i2ab");
  assert.equal(formatWorkspaceLabel("  hello\nworld  ", "run-xxxx-ab12"), "hello world · ab12");
  assert.equal(formatWorkspaceLabel("   ", "run-xxxx-ab12"), "workflow · ab12");
});

test("resolveInvocationCwd prefers Herdr pane/workspace context and falls back safely", () => {
  const fallback = "/fallback";
  assert.equal(
    resolveInvocationCwd(
      {
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
          focused_pane_cwd: "/pane/repo",
          workspace_cwd: "/workspace/repo",
        }),
      },
      fallback,
    ),
    "/pane/repo",
  );
  assert.equal(
    resolveInvocationCwd(
      { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/workspace/repo" }) },
      fallback,
    ),
    "/workspace/repo",
  );
  assert.equal(resolveInvocationCwd({ HERDR_PLUGIN_CONTEXT_JSON: "{" }, fallback), fallback);
  assert.equal(resolveInvocationCwd({}, fallback), fallback);
});

test("newRunId mints unique, journal-filename-safe ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
  assert.equal(ids.size, 50, "ids must be unique");
  for (const id of ids) assert.match(id, /^run-[a-z0-9]+-[a-z0-9]+$/);
});
