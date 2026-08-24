/**
 * Herdr workflow options added by this port:
 * - agent() accepts `kind` and `ssh`, threads both into AgentRunOptions,
 *   and folds both into hashAgentCall's identity (changing either invalidates
 *   the cached result on resume; keeping them stable cache-hits).
 * - Unknown agent() options throw SCRIPT_VALIDATION_ERROR instead of being
 *   silently dropped.
 * - runWorkflow requires options.agent (no default runner).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/engine/errors.js";
import { type JournalEntry, runWorkflow, type WorkflowRunOptions } from "../src/engine/workflow.js";

function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

const kindScript = (kind: string) => `export const meta = { name: 'kind_id', description: 'kind identity' }
const a = await agent('task', { label: 'a', kind: ${JSON.stringify(kind)} })
return a`;

const sshScript = (ssh: string) => `export const meta = { name: 'ssh_id', description: 'ssh identity' }
const a = await agent('task', { label: 'a', ssh: ${JSON.stringify(ssh)} })
return a`;

async function journalOf(script: string, runId: string): Promise<Map<string, JournalEntry>> {
  const journal = new Map<string, JournalEntry>();
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    runId,
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  return journal;
}

test("runWorkflow requires options.agent — no default runner", async () => {
  await assert.rejects(
    // Deliberately bypass the compile-time requirement to exercise the runtime guard.
    () => runWorkflow("export const meta = { name: 'x', description: 'd' }\nreturn 1", {} as WorkflowRunOptions),
    (error: unknown) =>
      error instanceof TypeError && /options\.agent/.test(error.message) && /WorkflowAgentRunner/.test(error.message),
    "a clear TypeError naming options.agent must be thrown",
  );
});

test("agent() threads kind and ssh into AgentRunOptions", async () => {
  const seen: Array<{ kind?: string; ssh?: unknown }> = [];
  const runner = {
    async run(_p: string, o: { kind?: string; ssh?: string }) {
      seen.push({ kind: o.kind, ssh: o.ssh });
      return "ok";
    },
  };
  const script = `export const meta = { name: 'thread', description: 'kind/ssh threading' }
await agent('a', { label: 'a', kind: 'codex', ssh: 'example-host' })
await agent('b', { label: 'b', kind: 'claude', ssh: 'alex@gpu-box' })
await agent('c', { label: 'c' })
return 1`;
  await runWorkflow(script, { agent: runner, persistLogs: false });

  assert.deepEqual(seen[0], { kind: "codex", ssh: "example-host" });
  assert.deepEqual(seen[1], { kind: "claude", ssh: "alex@gpu-box" });
  assert.deepEqual(seen[2], { kind: undefined, ssh: undefined }, "absent options stay absent");
});

test("changing kind invalidates the cached result on resume; same kind cache-hits", async () => {
  const journal = await journalOf(kindScript("codex"), "kind-run");

  // Same kind — full cache hit, no live re-run.
  const same = countingAgent();
  await runWorkflow(kindScript("codex"), {
    agent: same.runner,
    persistLogs: false,
    runId: "kind-run",
    resumeJournal: journal,
  });
  assert.equal(same.state.calls, 0, "identical kind must cache-hit");

  // Changed kind — identical prompt/label, but the call identity changed:
  // a codex result must never replay as if claude produced it.
  const changed = countingAgent();
  await runWorkflow(kindScript("claude"), {
    agent: changed.runner,
    persistLogs: false,
    runId: "kind-run",
    resumeJournal: journal,
  });
  assert.equal(changed.state.calls, 1, "a changed kind must cache-miss and re-run live");
});

test("changing ssh invalidates the cached result on resume; the same ssh host cache-hits", async () => {
  const journal = await journalOf(sshScript("host-a"), "ssh-run");

  const same = countingAgent();
  await runWorkflow(sshScript("host-a"), {
    agent: same.runner,
    persistLogs: false,
    runId: "ssh-run",
    resumeJournal: journal,
  });
  assert.equal(same.state.calls, 0, "an identical ssh host must cache-hit");

  const changed = countingAgent();
  await runWorkflow(sshScript("host-b"), {
    agent: changed.runner,
    persistLogs: false,
    runId: "ssh-run",
    resumeJournal: journal,
  });
  assert.equal(changed.state.calls, 1, "a changed ssh host must cache-miss and re-run live");
});

test("adding ssh to a previously local call invalidates its cache entry", async () => {
  const script = (opts: string) => `export const meta = { name: 'ssh_add', description: 'ssh added' }
return await agent('task', { label: 'a'${opts} })`;
  const journal = await journalOf(script(""), "ssh-add-run");

  const changed = countingAgent();
  await runWorkflow(script(", ssh: 'example-host'"), {
    agent: changed.runner,
    persistLogs: false,
    runId: "ssh-add-run",
    resumeJournal: journal,
  });
  assert.equal(changed.state.calls, 1, "moving a local call onto an ssh host must re-run live");
});

test("adding kind to a previously kind-less call invalidates its cache entry", async () => {
  const script = (opts: string) => `export const meta = { name: 'kind_add', description: 'kind added' }
return await agent('task', { label: 'a'${opts} })`;
  const journal = await journalOf(script(""), "kind-add-run");

  const changed = countingAgent();
  await runWorkflow(script(", kind: 'codex'"), {
    agent: changed.runner,
    persistLogs: false,
    runId: "kind-add-run",
    resumeJournal: journal,
  });
  assert.equal(changed.state.calls, 1, "adding kind changes the identity and must re-run live");
});

test("agentType definition kind participates in identity via agentDefinitionKey", async () => {
  const script = `export const meta = { name: 'def_kind', description: 'def kind identity' }
return await agent('task', { label: 'a', agentType: 'worker' })`;

  const registryWith = (kind: string) => ({
    resolve: (name: string) => (name === "worker" ? { prompt: "You are a worker.", kind } : undefined),
  });

  const journal = new Map<string, JournalEntry>();
  const seenKinds: Array<string | undefined> = [];
  const recordingRunner = () => ({
    async run(_p: string, o: { kind?: string }) {
      seenKinds.push(o.kind);
      return "ok";
    },
  });
  await runWorkflow(script, {
    agent: recordingRunner(),
    persistLogs: false,
    runId: "def-kind-run",
    agentRegistry: registryWith("codex"),
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.deepEqual(seenKinds, ["codex"], "the definition's kind reaches the runner");

  // Same definition — cache hit.
  const same = countingAgent();
  await runWorkflow(script, {
    agent: same.runner,
    persistLogs: false,
    runId: "def-kind-run",
    agentRegistry: registryWith("codex"),
    resumeJournal: journal,
  });
  assert.equal(same.state.calls, 0, "an unchanged definition must cache-hit");

  // Edited definition kind — the resolved definition is part of the hash.
  const changed = countingAgent();
  await runWorkflow(script, {
    agent: changed.runner,
    persistLogs: false,
    runId: "def-kind-run",
    agentRegistry: registryWith("claude"),
    resumeJournal: journal,
  });
  assert.equal(changed.state.calls, 1, "editing the definition's kind must invalidate the cached call");
});

test("agentType resolution is memoized per run: a live registry cannot change identity mid-run", async () => {
  // A host registry whose resolve() re-reads live config could return a
  // different definition for the same name mid-run. Pi prevented this
  // structurally (registry snapshotted once per run); the engine restores that
  // guarantee by resolving each name against the host at most once per run.
  let resolveCalls = 0;
  const registry = {
    resolve: (name: string) =>
      name === "worker" ? { prompt: `You are worker v${++resolveCalls}.`, kind: `kind-v${resolveCalls}` } : undefined,
  };
  const script = `export const meta = { name: 'memo', description: 'registry memoization' }
const a = await agent('same task', { label: 'a', agentType: 'worker' })
const b = await agent('same task', { label: 'b', agentType: 'worker' })
return [a, b]`;

  const seen: Array<{ kind?: string; instructions?: string }> = [];
  const journal = new Map<string, JournalEntry>();
  await runWorkflow(script, {
    agent: {
      async run(_p: string, o: { kind?: string; instructions?: string }) {
        seen.push({ kind: o.kind, instructions: o.instructions });
        return "ok";
      },
    },
    persistLogs: false,
    runId: "memo-run",
    agentRegistry: registry,
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });

  assert.equal(resolveCalls, 1, "the host resolve() must be consulted at most once per name per run");
  assert.deepEqual(seen[0], { kind: "kind-v1", instructions: "You are worker v1." });
  assert.deepEqual(seen[1], seen[0], "both agent() calls must observe the identical resolved definition");
  // Resume-identity stability: two identical calls share one callHash even
  // though the live registry would have produced two different definitions.
  const hashes = [...journal.values()].map((e) => e.hash);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1], "identical calls must hash identically despite the live registry");
});

test("unknown agent() options throw SCRIPT_VALIDATION_ERROR instead of being dropped", async () => {
  const script = `export const meta = { name: 'unknown_opt', description: 'unknown option' }
return await agent('task', { label: 'a', kine: 'codex' })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: countingAgent().runner, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      /unknown agent\(\) option "kine"/.test(error.message),
  );
});

test("unknown agent() options inside parallel() still halt the run (non-recoverable)", async () => {
  const script = `export const meta = { name: 'unknown_opt_par', description: 'unknown option in parallel' }
return await parallel([() => agent('task', { label: 'a', maschine: 'x' })])`;
  await assert.rejects(
    () => runWorkflow(script, { agent: countingAgent().runner, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      /maschine/.test(error.message),
    "a typo'd option must not collapse to null in a fan-out",
  );
});

test("malformed kind/ssh values are rejected loudly", async () => {
  const badKind = `export const meta = { name: 'bad_kind', description: 'bad kind' }
return await agent('task', { kind: 42 })`;
  await assert.rejects(
    () => runWorkflow(badKind, { agent: countingAgent().runner, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && /kind/.test(error.message),
  );

  for (const value of ["''", "'   '", "42", "{ tag: 'mac' }"]) {
    const badSsh = `export const meta = { name: 'bad_ssh', description: 'bad ssh' }
return await agent('task', { ssh: ${value} })`;
    await assert.rejects(
      () => runWorkflow(badSsh, { agent: countingAgent().runner, persistLogs: false }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        /"ssh" must be a non-empty name/.test(error.message),
      `ssh: ${value} must be rejected`,
    );
  }
});

test('the removed `machine` option is a loud validation error pointing at ssh, never a silent alias', async () => {
  const script = `export const meta = { name: 'old_machine', description: 'machine is gone' }
return await agent('task', { label: 'a', machine: 'example-host' })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: countingAgent().runner, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      /unknown agent\(\) option "machine"/.test(error.message) &&
      /pass ssh: "<host>"/.test(error.message),
  );
});

test("label changes still do NOT invalidate the cache (kind/ssh are identity, label is metadata)", async () => {
  const script = (label: string) => `export const meta = { name: 'label_meta', description: 'label metadata' }
return await agent('task', { label: ${JSON.stringify(label)}, kind: 'codex', ssh: 'host-a' })`;
  const journal = await journalOf(script("first-label"), "label-run");

  const relabeled = countingAgent();
  await runWorkflow(script("second-label"), {
    agent: relabeled.runner,
    persistLogs: false,
    runId: "label-run",
    resumeJournal: journal,
  });
  assert.equal(relabeled.state.calls, 0, "a changed label must still cache-hit — label is not part of the identity");
});
