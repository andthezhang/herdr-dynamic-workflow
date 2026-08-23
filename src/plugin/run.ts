/**
 * Plugin action "run" and the herdr-dynamic-workflow CLI.
 *
 *   herdr-dynamic-workflow <<'JSON'
 *   { "scriptPath": "workflow.js", "args": { "pr": 412 } }
 *   JSON
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CLI_HELP } from "./cli-help.js";
import { executeWorkflowInvoke } from "./execute.js";
import { InvokeError, parseInvokeJson, readInvokeRaw } from "./invoke.js";
import { pluginRootFromModuleUrl, readAuthoringSkill } from "./skills-cli.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(CLI_HELP.endsWith("\n") ? CLI_HELP : `${CLI_HELP}\n`);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (argv.length === 0 && process.stdin.isTTY) {
    process.stdout.write(CLI_HELP.endsWith("\n") ? CLI_HELP : `${CLI_HELP}\n`);
    process.exitCode = 2;
    return;
  }
  if (argv[0] === "skill" || argv[0] === "skills") {
    const skill = readAuthoringSkill();
    process.stdout.write(skill.endsWith("\n") ? skill : `${skill}\n`);
    return;
  }

  let invoke;
  try {
    const raw = await readInvokeRaw(argv);
    invoke = parseInvokeJson(raw);
  } catch (error) {
    fail(error);
    return;
  }

  try {
    const envelope = await executeWorkflowInvoke(invoke);
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
}

function readVersion(): string {
  const pkg = path.join(pluginRootFromModuleUrl(), "package.json");
  const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const runId = error instanceof InvokeError ? error.runId : undefined;
  const exitCode = error instanceof InvokeError ? error.exitCode : 1;
  // Usage errors stay plain text, like browser-use's empty-stdin hint.
  if (exitCode === 2 && !runId) {
    process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${JSON.stringify({ ok: false, ...(runId ? { runId } : {}), error: message })}\n`);
  process.exitCode = exitCode;
}

void main();
