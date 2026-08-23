/**
 * Plugin action "resume": resume the most recently written journal.
 * The CLI does this with {"resumeFromRunId":"run-..."}; this entry exists
 * because herdr plugin action invoke cannot pass that object on 0.8.x.
 */
import path from "node:path";
import process from "node:process";
import { executeWorkflowInvoke } from "./execute.js";
import { InvokeError } from "./invoke.js";
import { latestRunId, resolveStateDir } from "./shared.js";

async function main(): Promise<void> {
  const stateDir = resolveStateDir();
  const runId = latestRunId(stateDir);
  if (!runId) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: `no journaled runs to resume (none under ${path.join(stateDir, "runs")})`,
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const envelope = await executeWorkflowInvoke({ resumeFromRunId: runId, hasArgs: false });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = error instanceof InvokeError ? error.runId : runId;
    process.stderr.write(`${JSON.stringify({ ok: false, runId: id, error: message })}\n`);
    process.exitCode = error instanceof InvokeError ? error.exitCode : 1;
  }
}

void main();
