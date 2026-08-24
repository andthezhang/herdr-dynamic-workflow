/**
 * Run or resume from a parsed Workflow invoke object.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_KIND,
  HerdrAgentRunner,
  parseWorkflowScript,
  runWorkflow,
  type JournalEntry,
} from "../index.js";
import { InvokeError, type WorkflowInvoke } from "./invoke.js";
import {
  type JournalDocument,
  formatWorkspaceLabel,
  loadJournal,
  newRunId,
  resolveInvocationCwd,
  resolveSessionTarget,
  resolveStateDir,
  saveJournal,
  successEnvelope,
  toResumeMap,
  upsertJournalEntry,
} from "./shared.js";

export async function executeWorkflowInvoke(invoke: WorkflowInvoke): Promise<Record<string, unknown>> {
  const invocationCwd = resolveInvocationCwd();
  const stateDir = resolveStateDir();

  let doc: JournalDocument | undefined;
  if (invoke.resumeFromRunId) {
    try {
      doc = loadJournal(stateDir, invoke.resumeFromRunId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InvokeError(`no journal for resumeFromRunId ${invoke.resumeFromRunId}: ${detail}`, 1);
    }
  }

  const runId = doc?.runId ?? newRunId();
  const cwd = invoke.cwd
    ? path.resolve(invocationCwd, invoke.cwd)
    : (doc?.cwd ?? invocationCwd);

  const script = await resolveScript(invoke, doc, cwd);
  let workflowName: string;
  try {
    workflowName = parseWorkflowScript(script).meta.name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvokeError(message, 1, runId);
  }

  const args = invoke.hasArgs ? invoke.args : doc?.args;
  const kind = invoke.kind ?? doc?.kind ?? DEFAULT_KIND;
  const workspaceLabel = formatWorkspaceLabel(workflowName, runId);

  let runner: HerdrAgentRunner | undefined;
  try {
    const target = await resolveSessionTarget({
      explicitSession: invoke.session,
      workerSession: doc?.session,
      preferDefault: invoke.session ? undefined : doc ? doc.sessionMode === "default" : true,
    });

    runner = new HerdrAgentRunner({
      socketPath: target.socketPath,
      stateDir: path.join(os.tmpdir(), "herdr-flow"),
      defaults: { kind, cwd },
      workspaceLabel,
      session: target.session,
      localSessionMode: target.mode,
    });

    const nextDoc: JournalDocument = doc ?? {
      version: 1,
      runId,
      session: target.session,
      sessionMode: target.mode,
      kind,
      cwd,
      script,
      workspaceLabel,
      entries: [],
    };
    nextDoc.session = target.session;
    nextDoc.sessionMode = target.mode;
    nextDoc.kind = kind;
    nextDoc.cwd = cwd;
    nextDoc.script = script;
    nextDoc.workspaceLabel = workspaceLabel;
    if (args !== undefined) nextDoc.args = args;
    saveJournal(stateDir, nextDoc);

    const onAgentJournal = (entry: JournalEntry): void => {
      upsertJournalEntry(nextDoc, entry);
      saveJournal(stateDir, nextDoc);
    };

    const outcome = await runWorkflow(script, {
      agent: runner,
      runId,
      args,
      resumeFromRunId: doc ? runId : undefined,
      resumeJournal: doc ? toResumeMap(nextDoc) : undefined,
      stateDir,
      cwd,
      agentRetries: 2,
      onAgentJournal,
      onLog: (message) => process.stderr.write(`${message}\n`),
      onPhase: (title) => process.stderr.write(`== ${title}\n`),
    });
    return successEnvelope(runId, outcome, {
      resumed: Boolean(doc),
      workspace: workspaceLabel,
    });
  } catch (error) {
    if (error instanceof InvokeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new InvokeError(message, 1, runId);
  } finally {
    if (runner) await runner.close();
  }
}

async function resolveScript(invoke: WorkflowInvoke, doc: JournalDocument | undefined, cwd: string): Promise<string> {
  if (invoke.scriptPath) {
    return readFile(path.resolve(cwd, invoke.scriptPath), "utf8");
  }
  if (invoke.script !== undefined) return invoke.script;
  if (doc) return doc.script;
  throw new InvokeError("invoke needs scriptPath, script, name, or resumeFromRunId");
}
