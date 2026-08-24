/**
 * The CLI invoke object. Same fields as Claude Code's Workflow tool, plus the
 * host fields we need because we are not already inside Claude.
 *
 *   herdr-dynamic-workflow <<'JSON'
 *   { "scriptPath": "review.js", "args": { "pr": 412 } }
 *   JSON
 *
 * additionalProperties: false. title/description are rejected, not ignored.
 */
import { INVOKE_USAGE } from "./cli-help.js";

export const SCRIPT_MAX_CHARS = 524_288;
export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

const HOST_KEYS = ["kind", "session", "cwd"] as const;
const CLAUDE_KEYS = ["script", "scriptPath", "name", "args", "resumeFromRunId"] as const;
const ALLOWED_KEYS = new Set<string>([...CLAUDE_KEYS, ...HOST_KEYS]);

export { INVOKE_USAGE };

export class InvokeError extends Error {
  readonly exitCode: number;
  readonly runId?: string;
  constructor(message: string, exitCode = 2, runId?: string) {
    super(message);
    this.name = "InvokeError";
    this.exitCode = exitCode;
    this.runId = runId;
  }
}

export interface WorkflowInvoke {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  /** True when the JSON contained an `args` key, including null. */
  hasArgs: boolean;
  resumeFromRunId?: string;
  kind?: string;
  session?: string;
  cwd?: string;
}

export function parseInvokeJson(raw: string): WorkflowInvoke {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new InvokeError(
      `invoke is not JSON. Pass the Workflow object, e.g. {"scriptPath":"workflow.js"}. ${hintForRaw(trimmed)}`,
    );
  }
  return parseWorkflowInvoke(parsed);
}

export function parseWorkflowInvoke(value: unknown): WorkflowInvoke {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvokeError("invoke must be a JSON object");
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new InvokeError(
        `unknown invoke field "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
      );
    }
  }

  const script = optionalString(rec, "script");
  if (script !== undefined && script.length > SCRIPT_MAX_CHARS) {
    throw new InvokeError(`script exceeds ${SCRIPT_MAX_CHARS} characters`);
  }
  const scriptPath = optionalString(rec, "scriptPath");
  const name = optionalString(rec, "name");
  const resumeFromRunId = optionalString(rec, "resumeFromRunId");
  if (resumeFromRunId !== undefined && !RUN_ID_PATTERN.test(resumeFromRunId)) {
    throw new InvokeError(
      `resumeFromRunId must match ${RUN_ID_PATTERN.source} (for example, wf_mt5cpbpy-i2ab)`,
    );
  }
  const kind = optionalString(rec, "kind");
  const session = optionalString(rec, "session");
  const cwd = optionalString(rec, "cwd");

  const hasSource = script !== undefined || scriptPath !== undefined || name !== undefined;
  if (!hasSource && resumeFromRunId === undefined) {
    throw new InvokeError("invoke needs scriptPath, script, name, or resumeFromRunId");
  }
  // Precedence: scriptPath > script > name. name wins only when the other two
  // are absent — and we have no saved-workflow registry yet.
  if (scriptPath === undefined && script === undefined && name !== undefined) {
    throw new InvokeError(
      'named workflows (invoke.name) are not supported yet. Pass scriptPath or script.',
    );
  }

  return {
    script,
    scriptPath,
    name,
    args: rec.args,
    hasArgs: Object.prototype.hasOwnProperty.call(rec, "args"),
    resumeFromRunId,
    kind,
    session,
    cwd,
  };
}

export async function readInvokeRaw(
  argv: string[],
  options: { stdin?: NodeJS.ReadableStream; stdinIsTTY?: boolean } = {},
): Promise<string> {
  if (argv.length > 1) {
    throw new InvokeError(INVOKE_USAGE.trimEnd());
  }
  if (argv.length === 1) return argv[0]!;
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (stdinIsTTY) {
    throw new InvokeError(INVOKE_USAGE.trimEnd());
  }
  const stdin = options.stdin ?? process.stdin;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new InvokeError(INVOKE_USAGE.trimEnd());
  return raw;
}

function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  if (!(key in rec)) return undefined;
  const value = rec[key];
  if (typeof value !== "string") {
    throw new InvokeError(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new InvokeError(`${key} must be a non-empty string`);
  return trimmed;
}

function hintForRaw(raw: string): string {
  if (raw.endsWith(".js") || raw.endsWith(".mjs") || raw === "resume") {
    return `A bare path is the old CLI. Wrap it: {"scriptPath":"${raw}"}.`;
  }
  return `Got: ${JSON.stringify(raw.slice(0, 80))}`;
}
