/**
 * The output-file contract (docs/herdr-runtime-support.md §6): how a
 * pane-hosted coding agent hands its answer back to the workflow without any
 * per-runtime parsing.
 *
 * - `buildEnv` mints the HERDR_FLOW_* environment injected via tab.create so
 *   the agent inherits the output path from its shell.
 * - `OUTPUT_CONTRACT_PREAMBLE` is the fixed §6 prompt preamble, prepended to
 *   every agent() prompt (no per-runtime variation — that is the point).
 * - `validateOutputPayload` is the harvest validation ladder, adapted from
 *   pi-dynamic-workflows' extractValidated(): parse (with fence-stripping and
 *   first-balanced-object repair), honor {ok:false}, and validate against the
 *   call's JSON Schema with ajv (coercing) — schema failure is
 *   SCHEMA_NONCOMPLIANCE, non-recoverable, never a silent null.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT).
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchema } from "../engine/agent-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../engine/errors.js";

/**
 * Fixed prompt preamble, verbatim from reference §6. Prepended to every
 * agent() prompt; compliance is a model behaviour, not tool-enforced, which is
 * why the harvest ladder below exists.
 */
export const OUTPUT_CONTRACT_PREAMBLE = [
  "[herdr-dynamic-workflow output contract]",
  "When you have finished this task, write your complete answer to the file at the",
  "path in the HERDR_FLOW_OUT environment variable, as JSON:",
  "",
  '  {"ok": true, "result": <your answer>}',
  "",
  "`result` is a plain string unless a JSON Schema is present at HERDR_FLOW_SCHEMA,",
  "in which case `result` must validate against it. If you cannot complete the task,",
  'write {"ok": false, "error": "<one line>"} instead. Write the file exactly once,',
  "as the last thing you do. Do not print the answer to the terminal instead of",
  "writing the file; terminal output is not read.",
  "[end contract]",
].join("\n");

/** Env delivered on tab.create so the launched agent inherits it (§6 table). */
export interface FlowCallEnv {
  /** The file the agent must write: `<stateDir>/<runId>/<callIndex>.json`. */
  HERDR_FLOW_OUT: string;
  /** Run correlation for logs and journal. */
  HERDR_FLOW_RUN: string;
  /** Lexical call index (the engine's callSeq), stringified. */
  HERDR_FLOW_CALL: string;
  /** Present only when the call has a schema: where the schema JSON is written. */
  HERDR_FLOW_SCHEMA?: string;
}

/** Build the HERDR_FLOW_* env for one agent() call. All values are strings. */
export function buildEnv(stateDir: string, runId: string, callIndex: number, hasSchema: boolean): FlowCallEnv {
  return buildEnvWith(path.join, stateDir, runId, callIndex, hasSchema);
}

/**
 * Build the HERDR_FLOW_* env for a call placed on an ssh host (SPEC
 * D12/D13): the paths live on the worker's host, so they are joined with
 * POSIX separators regardless of the engine's own platform, and read back
 * over that host's transport (never the local filesystem — Q11).
 */
export function buildRemoteEnv(remoteStateDir: string, runId: string, callIndex: number, hasSchema: boolean): FlowCallEnv {
  return buildEnvWith(path.posix.join, remoteStateDir, runId, callIndex, hasSchema);
}

function buildEnvWith(
  join: (...parts: string[]) => string,
  stateDir: string,
  runId: string,
  callIndex: number,
  hasSchema: boolean,
): FlowCallEnv {
  const runDir = join(stateDir, runId);
  const env: FlowCallEnv = {
    HERDR_FLOW_OUT: join(runDir, `${callIndex}.json`),
    HERDR_FLOW_RUN: runId,
    HERDR_FLOW_CALL: String(callIndex),
  };
  if (hasSchema) env.HERDR_FLOW_SCHEMA = join(runDir, `${callIndex}.schema.json`);
  return env;
}

/**
 * Ladder step (a): the output file is absent after the wait settled. Analogous
 * to AGENT_EMPTY_OUTPUT — recoverable, so the engine can retry the call or
 * collapse it to null, and a resume can be told to re-run it.
 */
export class OutputFileMissingError extends WorkflowError {
  constructor(outPath: string, agentLabel?: string) {
    super(`agent output file missing after the wait settled: ${outPath}`, WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
      recoverable: true,
      agentLabel,
      details: { outPath },
    });
    this.name = "OutputFileMissingError";
  }
}

/**
 * Ladder step (b): parse the raw file. Direct JSON first, then with markdown
 * fences stripped, then the first balanced `{...}` object in the text.
 * Returns undefined when nothing parses.
 */
export function parseOutputPayload(raw: string): unknown {
  const direct = tryParse(raw);
  if (direct !== undefined) return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1]);
    if (parsed !== undefined) return parsed;
  }
  const balanced = firstBalancedObject(raw);
  if (balanced !== undefined) return tryParse(balanced);
  return undefined;
}

/**
 * Run the §6 harvest validation ladder over the raw output-file text and
 * return the agent's result value.
 *
 * Throws:
 * - recoverable AGENT_EXECUTION_ERROR when the file is unparseable or does not
 *   follow the `{ok, result|error}` contract;
 * - recoverable AGENT_EXECUTION_ERROR carrying the agent's own message on
 *   `{ok:false}`;
 * - non-recoverable SCHEMA_NONCOMPLIANCE when a schema is present and the
 *   (coerced) result does not satisfy it — never a silent null.
 */
export function validateOutputPayload(raw: string, options: { schema?: JsonSchema; agentLabel?: string } = {}): unknown {
  const { schema, agentLabel } = options;
  const parsed = parseOutputPayload(raw);
  if (parsed === undefined) {
    throw new WorkflowError(
      "agent output file was not parseable as JSON (even after fence/balanced-object repair)",
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: true, agentLabel, details: { raw: raw.slice(0, 2_000) } },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
    throw new WorkflowError(
      'agent output file did not follow the contract (expected {"ok": true, "result": ...} or {"ok": false, "error": "..."})',
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: true, agentLabel, details: { parsed } },
    );
  }
  const payload = parsed as { ok: boolean; result?: unknown; error?: unknown };
  if (!payload.ok) {
    const message = typeof payload.error === "string" && payload.error.trim() ? payload.error : "agent reported failure with no message";
    throw new WorkflowError(`agent reported failure: ${message}`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
      recoverable: true,
      agentLabel,
      details: { agentError: payload.error },
    });
  }
  if (schema) return coerceAndValidate(payload.result, schema, agentLabel);
  return payload.result;
}

/**
 * Ladder step (d): validate `value` against the call's schema with ajv,
 * coercing types. The value is wrapped in an object so root-level scalars are
 * coerced too (ajv cannot coerce a by-value root). Failure is
 * SCHEMA_NONCOMPLIANCE — non-recoverable by contract (pi's guarantee,
 * preserved without pi's tool-level enforcement).
 */
export function coerceAndValidate(value: unknown, schema: JsonSchema, agentLabel?: string): unknown {
  const ajv = new Ajv({ coerceTypes: true, useDefaults: true, allErrors: true, strict: false });
  const wrapper: { value?: unknown } = { value };
  let validate: ValidateFunction;
  try {
    validate = ajv.compile({ type: "object", properties: { value: schema }, required: ["value"] });
  } catch (error) {
    throw new WorkflowError(
      `agent schema did not compile: ${error instanceof Error ? error.message : String(error)}`,
      WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
      { recoverable: false, agentLabel, details: { schema } },
    );
  }
  if (!validate(wrapper)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath.replace(/^\/value/, "result") || "result"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw new WorkflowError(`agent result did not satisfy the schema: ${detail}`, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
      recoverable: false,
      agentLabel,
      details: { errors: validate.errors, value },
    });
  }
  return wrapper.value;
}

function tryParse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value === undefined ? null : value;
  } catch {
    return undefined;
  }
}

/** Extract the first balanced top-level `{...}` from free text, string-aware. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
