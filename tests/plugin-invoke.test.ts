import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  InvokeError,
  SCRIPT_MAX_CHARS,
  parseInvokeJson,
  parseWorkflowInvoke,
  readInvokeRaw,
} from "../src/plugin/invoke.js";

test("parseWorkflowInvoke accepts Claude fields plus host fields", () => {
  const invoke = parseWorkflowInvoke({
    scriptPath: "review.js",
    args: { pr: 412 },
    kind: "codex",
    session: "flow",
    cwd: "/tmp",
  });
  assert.equal(invoke.scriptPath, "review.js");
  assert.deepEqual(invoke.args, { pr: 412 });
  assert.equal(invoke.hasArgs, true);
  assert.equal(invoke.kind, "codex");
  assert.equal(invoke.session, "flow");
  assert.equal(invoke.cwd, "/tmp");
});

test("parseWorkflowInvoke treats omitted args as hasArgs false, including null", () => {
  assert.equal(parseWorkflowInvoke({ scriptPath: "a.js" }).hasArgs, false);
  const withNull = parseWorkflowInvoke({ scriptPath: "a.js", args: null });
  assert.equal(withNull.hasArgs, true);
  assert.equal(withNull.args, null);
});

test("parseWorkflowInvoke rejects unknown keys (title/description are not accepted)", () => {
  assert.throws(() => parseWorkflowInvoke({ scriptPath: "a.js", title: "x" }), /unknown invoke field "title"/);
  assert.throws(() => parseWorkflowInvoke({ scriptPath: "a.js", keep: true }), /unknown invoke field "keep"/);
  assert.throws(() => parseWorkflowInvoke({ scriptPath: "a.js", machine: "box" }), /unknown invoke field "machine"/);
  assert.throws(() => parseWorkflowInvoke({ scriptPath: "a.js", fleet: "fleet.toml" }), /unknown invoke field "fleet"/);
});

test("parseWorkflowInvoke requires a source or resumeFromRunId", () => {
  assert.throws(() => parseWorkflowInvoke({}), /scriptPath, script, name, or resumeFromRunId/);
  assert.throws(() => parseWorkflowInvoke({ kind: "codex" }), /scriptPath, script, name, or resumeFromRunId/);
});

test("parseWorkflowInvoke rejects name when it would win (no saved-workflow registry)", () => {
  assert.throws(() => parseWorkflowInvoke({ name: "review-changes" }), /named workflows/);
  const ignored = parseWorkflowInvoke({ scriptPath: "a.js", name: "review-changes" });
  assert.equal(ignored.scriptPath, "a.js");
  assert.equal(ignored.name, "review-changes");
});

test("parseWorkflowInvoke caps script length and requires non-empty strings", () => {
  assert.throws(() => parseWorkflowInvoke({ script: "x".repeat(SCRIPT_MAX_CHARS + 1) }), /exceeds/);
  assert.throws(() => parseWorkflowInvoke({ scriptPath: "   " }), /non-empty/);
  assert.throws(() => parseWorkflowInvoke({ scriptPath: 12 }), /scriptPath must be a string/);
});

test("parseWorkflowInvoke validates our run id, not Claude's wf_ prefix", () => {
  const ok = parseWorkflowInvoke({ resumeFromRunId: "run-mt5cpbpy-i2ab" });
  assert.equal(ok.resumeFromRunId, "run-mt5cpbpy-i2ab");
  assert.throws(() => parseWorkflowInvoke({ resumeFromRunId: "wf_k2ab91" }), /resumeFromRunId must match/);
  assert.throws(() => parseWorkflowInvoke({ resumeFromRunId: "resume" }), /resumeFromRunId must match/);
});

test("parseInvokeJson explains the old bare-path CLI", () => {
  assert.throws(() => parseInvokeJson("hello-workflow.js"), /old CLI/);
  assert.throws(() => parseInvokeJson("resume"), /old CLI/);
  assert.throws(() => parseInvokeJson("not-json"), /not JSON/);
  assert.deepEqual(parseInvokeJson('{"scriptPath":"a.js"}').scriptPath, "a.js");
});

test("readInvokeRaw takes argv[0] or stdin, not flags", async () => {
  assert.equal(await readInvokeRaw(['{"scriptPath":"a.js"}']), '{"scriptPath":"a.js"}');
  await assert.rejects(readInvokeRaw(["a.js", "--kind", "codex"]), (error: unknown) => {
    assert.ok(error instanceof InvokeError);
    assert.match(error.message, /<<'JSON'/);
    return true;
  });
  await assert.rejects(readInvokeRaw([], { stdinIsTTY: true }), /<<'JSON'/);
  const stdin = Readable.from(['{"scriptPath":"from-stdin.js"}']);
  assert.equal(await readInvokeRaw([], { stdin, stdinIsTTY: false }), '{"scriptPath":"from-stdin.js"}');
});
