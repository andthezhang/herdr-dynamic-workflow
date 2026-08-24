/**
 * Tests for the output-file contract (src/runner/contract.ts): env building,
 * the fixed prompt preamble, and the harvest validation ladder — missing file,
 * fence/balanced-object repair, {ok:false} propagation, ajv schema validation
 * with coercion, and SCHEMA_NONCOMPLIANCE (non-recoverable, never a silent
 * null).
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import {
  buildEnv,
  OUTPUT_CONTRACT_PREAMBLE,
  OutputFileMissingError,
  validateOutputPayload,
} from "../src/runner/contract.js";

test("buildEnv shapes the flow env, schema path only when a schema exists", () => {
  const env = buildEnv("/state/runs", "run_9f2c", 7, false);
  assert.deepEqual(env, {
    HERDR_FLOW_OUT: path.join("/state/runs", "run_9f2c", "7.json"),
    HERDR_FLOW_RUN: "run_9f2c",
    HERDR_FLOW_CALL: "7",
  });
  assert.equal(typeof env.HERDR_FLOW_CALL, "string", "env values must be strings");

  const withSchema = buildEnv("/state/runs", "run_9f2c", 7, true);
  assert.equal(withSchema.HERDR_FLOW_SCHEMA, path.join("/state/runs", "run_9f2c", "7.schema.json"));
});

test("the preamble is the fixed reference §6 text", () => {
  assert.ok(OUTPUT_CONTRACT_PREAMBLE.startsWith("[herdr-dynamic-workflow output contract]"));
  assert.ok(OUTPUT_CONTRACT_PREAMBLE.endsWith("[end contract]"));
  assert.match(OUTPUT_CONTRACT_PREAMBLE, /HERDR_FLOW_OUT environment variable, as JSON:/);
  assert.ok(OUTPUT_CONTRACT_PREAMBLE.includes('{"ok": true, "result": <your answer>}'));
  assert.ok(OUTPUT_CONTRACT_PREAMBLE.includes('write {"ok": false, "error": "<one line>"} instead.'));
  assert.match(OUTPUT_CONTRACT_PREAMBLE, /terminal output is not read\./);
});

test("OutputFileMissingError is recoverable AGENT_EMPTY_OUTPUT", () => {
  const error = new OutputFileMissingError("/state/runs/r/0.json", "reviewer");
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(error.recoverable, true);
  assert.equal(error.agentLabel, "reviewer");
});

test("a clean {ok:true} payload returns the result", () => {
  assert.equal(validateOutputPayload('{"ok": true, "result": "the answer"}', {}), "the answer");
  assert.deepEqual(validateOutputPayload('{"ok":true,"result":{"n":1}}', {}), { n: 1 });
});

test("fenced JSON is repaired before parsing", () => {
  const raw = '```json\n{"ok": true, "result": "fenced"}\n```\n';
  assert.equal(validateOutputPayload(raw, {}), "fenced");
});

test("prose around the first balanced object is repaired", () => {
  const raw = 'Sure! Here is the JSON you asked for:\n{"ok": true, "result": "salvaged {braces} inside"}\nHope that helps.';
  assert.equal(validateOutputPayload(raw, {}), "salvaged {braces} inside");
});

test("an unparseable file is a recoverable AGENT_EXECUTION_ERROR", () => {
  assert.throws(
    () => validateOutputPayload("no json anywhere here", {}),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});

test("{ok:false} propagates the agent's own message as recoverable AGENT_EXECUTION_ERROR", () => {
  assert.throws(
    () => validateOutputPayload('{"ok": false, "error": "the build tool exploded"}', { agentLabel: "builder" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      assert.match(error.message, /the build tool exploded/);
      assert.equal(error.agentLabel, "builder");
      return true;
    },
  );
});

test("schema validation coerces types (ajv coerce) and returns the value", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "number" }, name: { type: "string" } },
    required: ["count"],
  };
  const value = validateOutputPayload('{"ok": true, "result": {"count": "42", "name": "x"}}', { schema });
  assert.deepEqual(value, { count: 42, name: "x" });
});

test("root-level scalar coercion works too", () => {
  const value = validateOutputPayload('{"ok": true, "result": "17"}', { schema: { type: "number" } });
  assert.equal(value, 17);
});

test("schema failure is SCHEMA_NONCOMPLIANCE, non-recoverable, never a silent null", () => {
  const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
  assert.throws(
    () => validateOutputPayload('{"ok": true, "result": {"wrong": true}}', { schema, agentLabel: "counter" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
      assert.equal(error.recoverable, false, "non-recoverable: must halt, not collapse to null");
      return true;
    },
  );
});

test("a payload without a boolean ok field violates the contract (recoverable)", () => {
  assert.throws(
    () => validateOutputPayload('{"result": "no ok field"}', {}),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});
