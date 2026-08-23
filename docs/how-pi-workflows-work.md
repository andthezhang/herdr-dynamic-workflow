# How pi-dynamic-workflows works

A mechanism explainer for engineers porting this engine onto a different agent
backend. It describes what the code actually does, not what the feature list
says it does.

All `path:line` references are relative to the `pi-dynamic-workflows` repository root
at v3.5.1 (17,648 lines of TypeScript across 47 `src/*.ts` files, ESM, MIT, one
runtime dependency: `acorn`).

---

## 1. What a dynamic workflow is

An assistant, asked to do something too broad for one context window, writes a
**JavaScript program**. That program is not executed by the assistant turn by
turn — it is handed to `runWorkflow()`, which executes it to completion inside a
`node:vm` realm where a handful of injected globals are the only way to reach the
outside world. The most important global is `agent(prompt, options)`, which
spawns a fresh subagent session, runs it, and resolves to its output.

Three consequences follow, and they are the whole point:

**Intermediate results live in script variables, not in the chat transcript.**
A fan-out over 200 files produces 200 strings bound to a local `const`. The
orchestrating model never sees them. Only whatever the script `return`s crosses
back into the conversation. Context cost is decoupled from work volume.

**Control flow is real control flow.** `for`, `if`, `try/catch`, `Array.filter` —
the JavaScript ones, evaluated by V8. No DSL, no interpreter to write, and no
expressiveness ceiling to hit exactly when a task gets interesting.

**Every run is reproducible enough to replay.** Because the script is
deterministic (§5) and every `agent()` call gets a positional index assigned at
lexical call time (§6), a completed call's result can be cached and replayed.
Editing one prompt re-runs that call and everything downstream, nothing else.

Why code and not a graph editor: a graph editor forces "filter the results, group
by module, and fan out only on groups with more than three findings" into node
types someone had to anticipate. Code already has `filter` and `groupBy`. Why not
a ticket/queue system: a queue makes sequencing an operational concern with its
own durable state machine; here sequencing is `await`, and durability is a journal
of pure results rather than a scheduler's state. The trade is that the medium is
only as safe as its sandbox — and this sandbox is explicitly not a security
boundary (§5).

---

## 2. The authored interface

A workflow script is plain JavaScript with exactly one hard structural rule: the
**first statement must be a literal `export const meta`**. Everything after it is
the body, which is spliced out of the module context and re-wrapped in an async
IIFE, so `await` works at top level and `return` ends the run.

`skills/workflow-authoring/examples/fan-out-and-synthesize.js` is a complete,
representative script:

```js
export const meta = {
  name: "fan_out_and_synthesize",
  description: "Run bounded independent work, retain a complete coverage ledger, then synthesize",
  phases: [{ title: "Fan out" }, { title: "Synthesize" }],
};

// ADAPT: validate and bound args.work for the task before invoking this workflow.
const work = args && Array.isArray(args.work) ? args.work : [];

phase("Fan out");
const fanOutResults = await parallel(
  work.map((unit, index) => () =>
    agent(
      `Complete this independent work unit. Return only evidence relevant to it.\n\n${JSON.stringify(unit)}`,
      // INVARIANT: index plus a stable task-owned id keeps labels unique.
      { label: `fanout:${index}:${String(unit.id)}` },
    ),
  ),
);

// INVARIANT: preserve every intended identity before filtering or synthesis.
const ledger = work.map((unit, index) => ({
  id: String(unit.id),
  status: fanOutResults[index] === null ? "failed" : "complete",
  result: fanOutResults[index],
}));

phase("Synthesize");
const synthesis = await agent(
  `Synthesize the complete fan-out ledger below. Distinguish covered work from failed/missing coverage; do not invent results.\n\n${JSON.stringify(ledger)}`,
  {
    label: "synthesize-complete-set",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        coveredIds: { type: "array", items: { type: "string" } },
        failedIds: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "coveredIds", "failedIds"],
    },
  },
);

// INVARIANT: return plain serializable data, including missing-coverage identities.
return { ledger, synthesis };
```

Three things in that example encode load-bearing contracts:

- `parallel()` takes **thunks, not promises** — `() => agent(...)`, never
  `agent(...)`. The runtime type-checks this and produces a specific error
  message (`workflow.ts:887`) because the mistake is otherwise silent: array of
  already-started promises defeats the limiter entirely.
- `fanOutResults[index] === null` is the recoverable-failure signal. A recoverable
  agent failure resolves to `null` rather than throwing (§9). Indexes are
  preserved, so position-to-identity mapping survives.
- The `schema` is a **plain JSON Schema object literal**, not a typebox builder.
  The script never imports anything.

### The globals

Assembled by the capability contract (§11) from `workflow.ts:1226-1250`:

| Global | Signature | Notes |
| --- | --- | --- |
| `agent` | `agent(prompt, options?) => Promise<string \| structured \| null>` | The only thing that spends money. §4 |
| `parallel` | `parallel(thunks) => Promise<Array<unknown\|null>>` | Order-preserving; recoverable failures become `null` |
| `pipeline` | `pipeline(items, ...stages) => Promise<Array<unknown\|null>>` | Items concurrent, stages sequential per item; stage gets `(prev, original, index)` |
| `workflow` | `workflow(savedNameOrScript, childArgs?) => Promise<unknown>` | One nesting level; shares limiter/counters/budget/store |
| `verify` | `verify(item, {reviewers?, threshold?, lens?})` | N adversarial reviewers vote `{real}`; majority by threshold |
| `judgePanel` | `judgePanel(attempts, {judges?, rubric?})` | Scores candidates 0–1, returns highest mean, ties by index |
| `loopUntilDry` | `loopUntilDry({round, key?, consecutiveEmpty?, maxRounds?})` | Repeats rounds until N consecutive produce no new keys |
| `completenessCheck` | `completenessCheck(taskArgs, results)` | One critic agent; truncates evidence at 4,000 chars |
| `retry` | `retry(thunk, {attempts?, until?})` | `until` must be synchronous |
| `gate` | `gate(thunk, validator, {attempts?})` | Validator feedback is fed into the next attempt |
| `checkpoint` | `checkpoint(prompt, options?) => Promise<unknown>` | Human gate; journaled and replayable; consumes an agent slot, no tokens |
| `log` | `log(message) => void` | Preferred over `console` |
| `phase` | `phase(title, {budget?}) => void` | Sets current phase; optional soft token sub-budget |
| `args` | `args: unknown` | The only legal input channel |
| `cwd` | `cwd: string` | |
| `process` | `process: { cwd(): string }` | Frozen stub, nothing else from `process` |
| `budget` | `budget: { total, spent(), remaining() }` | Frozen view over shared soft accounting |
| `console` | `{ log, info, warn, error }` | Compatibility only; routes into `log` |

`verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry` and `gate`
are a **quality stdlib built entirely on top of `agent()`/`parallel()`**
(`workflow.ts:1014-1184`). They are not privileged: each helper's internal agent
calls take ordinary `callSeq` slots, which is precisely why they stay
resume-safe. A port gets all six for free by porting `agent()` and `parallel()`.

---

## 3. The execution pipeline, end to end

### 3.1 Parse — `parseWorkflowScript()` (`workflow.ts:1343`)

Four stages, in order:

**Regex blocklist.** Before any parsing:

```js
// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;
```
(`workflow.ts:369-370`)

A hit throws `SCRIPT_VALIDATION_ERROR`. This is an author-feedback fast path, not
a control — the comment says so.

**acorn parse.**

```js
const ast = parse(script, {
  ecmaVersion: "latest",
  sourceType: "module",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  ranges: false,
}) as AnyNode;
```
(`workflow.ts:1352-1358`)

Those two `allow*` flags are what make the authored dialect legal: top-level
`await` and a bare top-level `return` both parse, because the body will later be
wrapped in an async function anyway.

**Structural meta check.** The first AST node must be an `ExportNamedDeclaration`
whose declaration is a `const` VariableDeclaration with exactly one declarator
named `meta` that has an initializer. Each failure gets its own error message
(`workflow.ts:1360-1394`).

**Literal-only evaluation.** `evaluateLiteral()` (`workflow.ts:1405`) is a
hand-rolled AST walker that accepts `ObjectExpression`, `ArrayExpression`,
`Literal`, non-interpolated `TemplateLiteral`, and negative-number
`UnaryExpression`. It rejects spread, computed keys, methods/accessors, sparse
array holes, and the key names `__proto__`, `constructor`, `prototype`. So the
meta is read without ever evaluating the script — a `meta` whose `name` is
`"a" + "b"` is a hard error, not a clever trick.

**Splice.** The return value is the parsed meta plus a body string with the meta
export cut out by character range:

```js
return {
  meta,
  body: script.slice(0, first.start) + script.slice(first.end),
};
```
(`workflow.ts:1399-1402`)

The vm therefore never sees the token `export`, which would be a syntax error in
a non-module script.

Upstream of all this, the tool adapter strips a whole-script Markdown fence
(`normalizeWorkflowScript`, `workflow-tool.ts:486`) because models emit them.
That behavior is declared in the contract as `COMPATIBILITY`, i.e. accepted but
not recommended.

### 3.2 Context assembly and run

```js
const { globals: projectGlobals, diagnostics: bindingDiagnostics } =
  WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(runtimeImplementations);
for (const diagnostic of bindingDiagnostics) logger.warn(diagnostic.message);
const context = vm.createContext({
  ...projectGlobals,
  // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
  // itself — we deliberately do NOT inject host built-ins, whose .constructor
  // would be the host Function (a determinism-guard bypass). Math/Date are
  // neutered in-realm by DETERMINISM_PRELUDE below.
});

const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` })
  .runInContext(context);
```
(`workflow.ts:1251-1264`)

The realm's own `Object`/`Array`/`JSON`/`Promise` are used; nothing is injected
from the host except the bridge functions. The wrapped script's value is the
IIFE's promise, so `await`ing it is awaiting the whole workflow.

On success the runner persists logs, emits final token usage, and returns
`{ meta, result, logs, phases, agentCount, durationMs, runId, tokenUsage }`.

### 3.3 Teardown

`runWorkflow`'s `finally` (`workflow.ts:1311-1340`) is only active for the
top-level frame (`isTopLevelRun`, set when the run created its own
`SharedRuntime`). It drains in-flight agents (§7) and then disposes the shared
store. Its own comment names the failure mode honestly: a hung, signal-ignoring,
un-awaited `agent()` call combined with the default `agentTimeoutMs: null` can
wedge the drain — and therefore the run — forever.

---

## 4. `agent()` in detail

This is the function a port replaces the backend of, and the function whose
surrounding machinery a port must preserve. It is split in two:
`agent()` (`workflow.ts:536`) is a thin wrapper that registers the call for
draining; `agentImpl()` (`workflow.ts:550`) is the real path.

### The wrapper

```js
const agent = (prompt, agentOptions = {}) => {
  const call = agentImpl(prompt, agentOptions);
  shared.inFlight.add(call);
  // Attaching a handler here (independent of whatever the script itself does
  // with the returned promise) also means an un-awaited call's eventual
  // rejection never becomes a process-crashing unhandled rejection.
  call.catch(() => {}).finally(() => shared.inFlight.delete(call));
  return call;
};
```
(`workflow.ts:536-548`)

### The ordered path of one call

**1. Abort check.** `throwIfAborted()` — true if the caller's `options.signal` is
aborted or the run's fate has been sealed (§7).

**2. Capture the fan-out batch, synchronously.**

```js
// Capture the enclosing parallel()/pipeline() fan-out's cancellation batch
// (if any) synchronously, while the ALS context of the caller is still
// active — i.e. before suspending on the limiter below.
const batch = fanoutScope.getStore();
```
(`workflow.ts:553-558`)

`AsyncLocalStorage` context is only reliably readable before the first
suspension point; the capture must happen here.

**3. Hard caps.** `shared.agentCount >= maxAgents` throws
`AGENT_LIMIT_EXCEEDED` (non-recoverable). `budget.remaining() <= 0` throws
`TOKEN_BUDGET_EXHAUSTED` (non-recoverable). Then the per-phase soft sub-budget
gate: exceeding a phase ceiling throws `TOKEN_BUDGET_EXHAUSTED` while the run
budget is untouched; crossing 80% logs once (`workflow.ts:580-596`).

**4. Resolve agentType, then model.**

```js
const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
if (agentOptions.agentType && !agentDef) {
  log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
}
const explicitModel = agentOptions.model ?? agentDef?.model;
const modelSpec =
  explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
```
(`workflow.ts:601-612`)

Passing `undefined` when only a tier is set is deliberate: it defers the decision
to `WorkflowAgent.run()` so the tier, not the phase model, wins there.

**5. Assign the call index — before the limiter.**

```js
// Deterministic resume key: assigned at lexical call time, before the limiter,
// so parallel()/pipeline() fan-out is reproducible for a fixed script.
const callIndex = state.callSeq++;
const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));
const deltaKey = `${runId}:${callIndex}`;
```
(`workflow.ts:618-634`)

`hashAgentCall` (`workflow.ts:1519`) hashes exactly
`{prompt, model, tier, phase, agentType, agentDef, schema}` — note that `label`,
`isolation`, `timeoutMs`, and `retries` are **not** in the identity. Changing a
label does not invalidate a cached result; neither does adding worktree
isolation. `agentDef` is `agentDefinitionKey()` (`agent-registry.ts:207`),
a JSON string of the definition's tools/denylist/model/isolation/prompt, so
editing an agent `.md` invalidates every call that used it.

**6. Reserve the slot — atomically.**

```js
// Reserve the agent slot synchronously — atomic with the limit/budget gate
// above (no await in between) — so a parallel() fan-out can't all observe the
// same agentCount and overshoot maxAgents.
shared.agentCount++;
const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);
```
(`workflow.ts:636-642`)

There is no lock. There is no `await` between the read at step 3 and the
increment here, and JavaScript is single-threaded, so the sequence is atomic by
construction. A port on a different concurrency model must reproduce the
*property*, not the code.

**7. Journal lookup.**

```js
const cached = options.resumeJournal?.get(deltaKey);
const hashMatches = cached != null && cached.hash === callHash;
const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
  options.onAgentStart?.({ id: deltaKey, label, phase: assignedPhase, prompt, model: displayModel });
  options.onAgentEnd?.({ id: deltaKey, label, phase: assignedPhase, result: cached.result, tokens: 0, model: displayModel });
  if (cached.storeDelta) store.applyDelta(cached.storeDelta);
  return cached.result;
}
if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);
```
(`workflow.ts:653-674`)

A replay is a full round trip through the observer callbacks with `tokens: 0` and
no limiter involvement at all. Note `cachedEmptyOutput`: a journaled empty-text
result is treated as a miss, so a poisoned cache entry self-heals.

**8. Enter the limiter.** Everything from here runs inside
`limiter(async () => { ... })` (`workflow.ts:676`), which caps concurrency.

**9. Worktree isolation** (optional, inside the limiter):

```js
const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
if (resolvedIsolation === "worktree") {
  worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
  if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
}
```
(`workflow.ts:688-693`)

`createWorktree` (`worktree.ts:41`) shells out to
`git worktree add -b pi/wf/<slug> <repoRoot>/.pi/worktrees/<slug> HEAD`. The name
is derived from runId + callIndex — never wall-clock — so resume keys stay
stable. Every failure path returns `{ isolated: false, reason }` and the agent
runs in the shared tree: isolation is best-effort by design. Teardown is in a
`finally` that covers timeout and abort (`workflow.ts:876-879`), and results are
never auto-merged.

**10. The attempt loop** (`workflow.ts:715`), `maxAttempts = retries + 1`, retries
clamped to 0..3. Per attempt:

- Re-check abort; check `batch?.cancelled` and throw the agent-limit error if the
  enclosing fan-out already breached.
- Build a fresh per-attempt `AbortController`, linked to *both* the caller's
  external signal and `shared.runFatalController`, with both listeners removed in
  the attempt's `finally` so they don't accrue.
- Call the runner:

```js
const runPromise = agentRunner.run(prompt, {
  label, sessionName: `workflow:${runId} ${label}`, schema: agentOptions.schema,
  signal: agentController.signal,
  instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
  model: modelSpec, tier: agentOptions.tier, modelRegistry: options.modelRegistry,
  toolNames: agentDef?.tools, disallowedToolNames: agentDef?.disallowedTools,
  systemTools: createAgentStoreTools(store, deltaKey),   // bypass the tool allowlist
  cwd: runCwd,
  onModelResolved: (id) => { displayModel = id; },
  onModelFallback: ({ tier, requestedSpec }) => { /* log the degrade into the run */ },
  onUsage: (u) => { usage = u; },
  onHistory: (history) => options.onAgentHistory?.({ id: deltaKey, label, phase: assignedPhase, history }),
});
runPromise.catch(() => {});
const result = await withTimeout(runPromise, timeout, label, () => agentController.abort());
```
(`workflow.ts:748-787`)

`withTimeout` (`workflow.ts:1586`) fires `onTimeout` — which aborts the attempt —
*before* the timeout rejection wins the race, so the losing session is torn down
instead of streaming on in the background. The bare `runPromise.catch(() => {})`
is there because the loser still settles later.

**11. Empty-output check.** A non-schema result that is an empty/whitespace string
throws `AGENT_EMPTY_OUTPUT` (recoverable) so it retries rather than silently
succeeding.

**12. Record usage.** `recordTokens()` (`workflow.ts:700`) folds the attempt's real
usage into `shared.tokenUsage`/`shared.spent`, or falls back to a length/4
estimate when the provider reported nothing. It is called on both the success
path and the failure path, so wasted retries are still charged against the
budget.

**13. Journal + report.**

```js
const tokens = recordTokens(result);
options.onAgentJournal?.({ index: callIndex, runId, hash: callHash, result, storeDelta: store.commitDelta(deltaKey) });
options.onAgentEnd?.({ id: deltaKey, label, phase: assignedPhase, result, tokens, tokenUsage: usage, worktree: runCwd, model: displayModel });
return result;
```
(`workflow.ts:797-815`)

Only this path journals. A failed call is never cached.

**14. Failure handling** (`workflow.ts:816-866`). Wrap into a `WorkflowError`,
record the wasted tokens, and unconditionally `store.discardDelta(deltaKey)` —
because every attempt of a call shares one deltaKey, an un-rolled-back failed
attempt would leak writes into a later successful attempt's journaled delta.
Then: recoverable and attempts left → log, report the wasted spend on the
dedicated `onRetrySpend` channel, `continue`. Recoverable and exhausted →
`onAgentEnd` with the error, **return `null`**. Non-recoverable → `onAgentEnd`
with the error, then `throw`.

The `null`-vs-throw split is the single most important behavioral contract in the
engine, and every helper and example is written around it.

---

## 5. Determinism, and what it is not

```js
/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
```
(`workflow.ts:372-384`)

The prelude itself (`workflow.ts:385-402`) replaces `Math.random`, and shadows
`globalThis.Date` with a `SafeDate` function that throws on `Date()` and
`new Date()` but forwards `new Date(arg)` through `Reflect.construct`, preserving
`Date.UTC`, `Date.parse`, and `Date.prototype`.

Read that comment as a design statement, and read it twice. `node:vm` isolates a
realm; it does not isolate capabilities. Any injected bridge function's
`.constructor` is the host `Function`, from which a hostile script can build
arbitrary host code. **The sandbox exists to protect the journal, not the host.**
The threat model is a trusted-but-careless author (a human, or an LLM writing on
their behalf), and the failure it prevents is a silently wrong replay.

The causal chain is: nondeterminism → the same script produces different values
on a re-run → journal replay serves results computed under conditions that no
longer hold → resume is unsound. Ban `Date.now()` and `Math.random()` and the
chain never starts. Anything genuinely nondeterministic enters through `args`,
which is hashed into nothing and simply supplied by the caller.

A port that abandons resume can abandon the whole determinism apparatus. A port
that keeps resume must keep it, and must audit any *new* global it injects for
nondeterminism — a `machine()` or `now()` helper would silently reopen the hole.

---

## 6. Journal and resume

### The data

```ts
export interface JournalEntry {
  index: number;
  runId?: string;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  storeDelta?: Record<string, unknown>;
}
```
(`workflow.ts:60-86`)

### Longest-unchanged-prefix replay

Two pieces of state on `RuntimeState` do all the work: `callSeq` (monotonic,
incremented at lexical call time) and `firstMiss` (initialized to
`Number.POSITIVE_INFINITY`). The rule from `workflow.ts:653-674`:

- Replay only if the hash matches **and** the cached result is not empty-text
  **and** `callIndex < state.firstMiss`.
- Any miss sets `firstMiss = min(firstMiss, callIndex)`.

So: edit the prompt of call #7 in a 20-call script, resume, and calls 0–6 replay
from cache while 7–19 run live. Not because 8–19 changed, but because their
inputs may have. This matches Claude Code's contract and is the only sound rule
without dataflow tracking.

`checkpoint()` participates identically (`workflow.ts:1191-1224`) with its own
`hashCheckpoint()` over `{promptText, kind, choices, default, headless, timeoutMs}`
— every field that can change the outcome, including the headless default, so an
edited default cannot resume with the old journaled answer.

### The deltaKey and the collision it prevents

```js
// Store delta key: callIndex alone is NOT run-unique. A nested workflow()
// call (see workflowFn below) shares this run's SharedStore instance but
// restarts its own callSeq at 0, so a parent agent and a concurrently
// running nested-run agent — or two SEQUENTIAL sibling nested runs, whose
// depth alone would otherwise repeat — can both get callIndex 0 and
// collide in SharedStore.agentDeltas — whichever commits last
// steals/overwrites the other's journaled delta (and, via this same
// deltaKey doubling as the onAgentStart/onAgentEnd/onAgentHistory event
// id, misattributes one agent's events to the other ...
const deltaKey = `${runId}:${callIndex}`;
```
(`workflow.ts:622-634`)

Nested runs get their runId from `` `${runId}-nested${++shared.nestedCallSeq}` ``
(`workflow.ts:1004`). The counter is `nestedCallSeq`, **not** `depth`, and the
reason is spelled out at `workflow.ts:99-115`: `depth` returns to 0 after each
nested call finishes, so `await workflow('a'); await workflow('b')` would mint
the same child runId twice — and an un-awaited stray call from the first child
can still be in flight when the second starts.

That one string is doing three jobs: journal key, `SharedStore` delta key, and
observer event id. A port must keep all three namespaced together or accept
misattributed progress UI as well as corrupted replay.

### storeDelta ordering

`SharedStore` (`shared-store.ts`) is a run-scoped key-value map exposed to agents
as two tools, `store_put` and `store_get`. Each agent's writes are tracked
per-deltaKey and journaled alongside its result. On replay, `applyDelta()` sets
keys **additively**:

> Applied during resume replay so parallel-agent deltas applied in callSeq order
> accumulate correctly regardless of original completion order.
> (`shared-store.ts:147-151`)

The predecessor was a whole-map snapshot per entry, which had a last-completed-
wins bug for concurrent writers. `discardDelta()` (`shared-store.ts:131`) rolls a
failed attempt's writes back to their pre-attempt shadow values, with a per-key
`Object.is` guard that leaves a concurrent sibling's later overwrite alone.

### Nested journal propagation is cut at the first miss

```js
const prefixIntact = state.firstMiss === Number.POSITIVE_INFINITY;
const child = await runWorkflow(childScript, {
  ...options,
  resumeJournal: prefixIntact ? options.resumeJournal : undefined,
  ...
});
```
(`workflow.ts:991-1006`)

Namespacing alone is insufficient here: store *content* is not part of any call's
hash, so a child cached under the old store state would be stale once an upstream
parent call re-runs live and writes different values. Once anything upstream
misses, the child is cut off from the journal entirely.

### Who owns the journal

`workflow.ts` never persists. It emits `onAgentJournal` and the host decides.
`WorkflowManager` accumulates entries into `managed.journal`, deduping on
`(index, runId)` (`workflow-manager.ts:732`), coalesces the writes, and on
`resume()` rebuilds the lookup map — falling back to the run's own runId for
legacy entries written before namespacing existed, which then safely cache-miss
rather than misapplying:

```js
const resumeJournal = new Map((persisted.journal ?? []).map((e) => [`${e.runId ?? runId}:${e.index}`, e]));
```
(`workflow-manager.ts:1301`)

`resume(runId, { script?, args? })` (`workflow-manager.ts:1189`) is also the
edited-script path: the orchestrating model resumes with a *changed* script and
pays only for the calls at or after the first edit.

Two seeding asymmetries are worth internalizing before porting, both documented
at `workflow.ts:452-461`:

- **Token spend is seeded** from the persisted total via `initialTokenUsage`,
  because the cache-hit branch deliberately skips `recordTokens()`.
- **Agent count is not seeded**, and doesn't need to be, because
  `shared.agentCount++` fires unconditionally for every call — replay included —
  before the replay branch runs. Replaying the script from index 0 reconstructs
  the count for free.

---

## 7. Concurrency and cancellation

### The limiter

```js
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => { active--; queue.shift()?.(); };
  return async (fn) => {
    if (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active++;
    try { return await fn(); } finally { next(); }
  };
}
```
(`workflow.ts:1467-1483`)

FIFO, no priority, no fairness beyond arrival order. The limit is
`normalizeConcurrency(options.concurrency ?? max(1, hardwareConcurrency - 2))`,
clamped to `1..MAX_CONCURRENCY` where `MAX_CONCURRENCY = 16` ("matches Claude
Code limit", `config.ts:12`). `MAX_AGENTS_PER_RUN = 1000`, `MAX_AGENT_RETRIES = 3`,
`DEFAULT_AGENT_TIMEOUT_MS = null` (no hard timeout).

The limiter lives on `SharedRuntime`, so a nested `workflow()` shares it and the
caps hold across nesting rather than being multiplied by it.

### Three layers of cancellation

**Layer 1 — `fanoutScope` (batch-scoped).** An `AsyncLocalStorage` whose store is
`{ cancelled: boolean }`. `parallel()` and `pipeline()` each establish a fresh
batch via `fanoutScope.run(batch, ...)`; `agent()` captures the nearest enclosing
one synchronously. When a fan-out's own call breaches `maxAgents`, the catch in
`parallel()` sets `batch.cancelled = true` (`workflow.ts:910`) and every still-
queued agent in *that* batch bails before spending. The scoping rationale is
explicit:

> Scope note: cancellation is bounded PER breaching fan-out, not run-global — a
> deliberate tradeoff. Deep-sixing the earlier run-global flag was required
> because it wrongly cancelled an innocent, independently-caught sibling batch.
> (`workflow.ts:36-42`)

Note the narrowness: only `AGENT_LIMIT_EXCEEDED` cancels a batch. The token budget
stays a soft gate, and other non-recoverable errors don't imply the rest of the
batch is doomed.

**Layer 2 — `shared.runFatalController` (run-scoped).** Fires exactly once, from
`runWorkflow`'s catch, and only when `isTopLevelRun`:

```js
if (isTopLevelRun) shared.runFatalController.abort();
```
(`workflow.ts:1309`)

The placement is the whole design. Sealing the run's fate inside
`agent()`/`parallel()` would break `parallel()`'s null-on-recoverable-error
contract and any script-level `try/catch`. By the time an error reaches this
catch, nothing anywhere in the chain caught it. Every in-flight agent's per-attempt
controller is linked to this signal, so siblings wind down instead of running to
completion on a doomed run.

**Layer 3 — per-attempt `AbortController` + `withTimeout`.** One per attempt, linked
to the external signal and to `runFatalController`, both listeners removed in the
attempt's `finally` so they don't accrue over a long run.

All three compose through one predicate:

```js
const isAborted = () => Boolean(options.signal?.aborted || shared.runFatalController.signal.aborted);
```
(`workflow.ts:528`)

### The inFlight drain

`shared.inFlight` holds every agent promise spawned anywhere in the run tree. The
top-level `finally` drains it in a **loop**, not a single `allSettled`, because
draining can let a still-running call schedule more work (`workflow.ts:1332-1337`).
This is what prevents a forgotten `await agent(...)` from mutating the store after
the run has been marked complete.

---

## 8. Structured output

When `agent()` is called with a `schema`, the result must satisfy it. Three
stages, narrowing:

**Stage 1 — a terminating tool whose parameters *are* the schema.**

```js
return defineTool({
  name,
  description: "Return the final machine-readable result for this subagent task.",
  promptGuidelines: [
    `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
    `Do not write a prose final answer after calling ${name}.`,
  ],
  parameters: schema,
  async execute(_toolCallId, params) {
    capture.value = params;
    capture.called = true;
    return { content: [...], details: params, terminate: true };
  },
});
```
(`structured-output.ts:27-46`)

The provider validates `params` against the schema before `execute` runs, so a
successful call is validated by construction. `terminate: true` ends the subagent
on the tool call, saving a follow-up assistant turn. `agent.ts:725-739` fails fast
if the schema's top-level `type` is not `"object"`, because strict
OpenAI-compatible providers reject that with a transport-level 400 before any of
this classification logic ever runs. The prompt also gets an explicit final-output
contract appended (`agent.ts:930-940`).

**Stage 2 — bounded repair.** `resolveStructuredOutput` (`agent.ts:123`) narrows
the toolset to `["structured_output"]` (best-effort, wrapped in try/catch) and
re-prompts up to `maxSchemaRetries` (default 2) times with a fixed message telling
the model to call the tool as its only action.

**Stage 3 — strict prose extraction.** `extractValidated` (`agent.ts:57`) pulls a
fenced `json` block, or failing that the first balanced `{...}`/`[...]`,
`JSON.parse`s it, runs typebox `Convert()` for coercion, and accepts it **only if
`Check()` then passes**. Its comment: *"Never fabricates — returns undefined unless
the parsed value genuinely satisfies the schema."* A recovery here logs a warning
recommending a tool-reliable model.

**Failure.** After checking whether a repair turn itself hit a provider limit
(which would be the real, more useful cause), it throws:

```js
throw new WorkflowError(
  "Subagent did not produce valid structured_output after repair attempts",
  WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  { recoverable: false, agentLabel: options.label },
);
```
(`agent.ts:160-164`)

`recoverable: false` is the deliberate part, and it has two effects. It bypasses
`agent()`'s retry loop — re-running a model that structurally won't call the tool
is waste — and, crucially, it **propagates instead of collapsing to `null`**. A
silent null here would be the worst outcome available: downstream script code
would read `result.summary` off `null`, or a `filter(Boolean)` would quietly drop
the item and the run would report success over a hole. A loud non-recoverable
failure is strictly better than a plausible wrong answer.

---

## 9. The error taxonomy

`WorkflowError` (`errors.ts:67`) carries `code`, `recoverable`, `agentLabel`,
`details`, and `resetHint`. `recoverable` **defaults to `false`** — errors are
fatal unless explicitly marked otherwise.

| Code | Recoverable | Raised by | Effect |
| --- | --- | --- | --- |
| `AGENT_TIMEOUT` | yes | `withTimeout`, `wrapError` on timeout-like errors | Retry; then `null` |
| `AGENT_EMPTY_OUTPUT` | yes | Empty assistant text (`workflow.ts:791`, `agent.ts:895`) | Retry; then `null` |
| `AGENT_EXECUTION_ERROR` | yes | `wrapError` catch-all | Retry; then `null` |
| `WORKFLOW_ABORTED` | yes | `throwIfAborted`, abort-like messages | Unwinds; drain still runs |
| `AGENT_LIMIT_EXCEEDED` | no | `maxAgents` breach | Throws; **cancels its own fan-out batch** |
| `TOKEN_BUDGET_EXHAUSTED` | no | Run or phase budget | Throws; does not cancel the batch |
| `PROVIDER_USAGE_LIMIT` | no | `throwIfProviderLimit` | Throws → run pauses/checkpoints, auto-resumes on quota reset |
| `SCHEMA_NONCOMPLIANCE` | no | `resolveStructuredOutput` | Throws; bypasses agent retries |
| `MODEL_NOT_FOUND` | no | Explicit `model`/`tier` that doesn't resolve | Throws; never substitutes |
| `SCRIPT_VALIDATION_ERROR` | no | `parseWorkflowScript`, nesting depth, non-object schema | Throws before any spend |
| `PERSISTENCE_ERROR` | no | Run-state persistence | Host-level |
| `UNKNOWN` | no | Fallback | — |

The recoverable/non-recoverable line answers one question: *would running this
again plausibly produce a different result?* Timeouts and transient execution
errors: yes. A model that doesn't exist, a budget that's spent, a schema the model
structurally won't satisfy: no — retrying burns money to fail identically.

`PROVIDER_USAGE_LIMIT` is the subtlest. The Pi SDK does not throw it; it records
it as an assistant message with `stopReason: "error"` and a message like
`"Codex usage limit reached (plus plan). Resets in ~3h."`. `classifyProviderLimit`
(`errors.ts:140`) pattern-matches that text and extracts the reset hint, and every
caller must gate on `stopReason === "error"` first so a task whose *output*
mentions "rate limit" isn't misclassified. It is non-recoverable specifically so
the run *checkpoints and pauses* rather than failing — a provider limit refills on
its own, so pausing and resuming later is the correct response. Transient
overloaded/5xx errors are deliberately excluded from the pattern and stay
recoverable.

`wrapError` (`errors.ts:166`) normalizes anything thrown by the runner: already-a-
`WorkflowError` passes through, abort-like → `WORKFLOW_ABORTED`, timeout-like →
`AGENT_TIMEOUT`, provider-limit-like → `PROVIDER_USAGE_LIMIT`, everything else →
recoverable `AGENT_EXECUTION_ERROR`. **This is the classification seam a port
rewires**: a Herdr backend's failure vocabulary (pane died, agent kind not
installed, `agent_pane_busy`, wait timeout, blocked-on-approval) must be mapped
onto these codes, and the recoverable flag decides whether it turns into a `null`
or halts the run.

---

## 10. The agent backend (`agent.ts`) — the replaceable layer

The seam:

```ts
/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}
```
(`workflow.ts:152-155`)

and its one use:

```js
const agentRunner = options.agent ?? new WorkflowAgent(options);
```
(`workflow.ts:441`)

The entire test suite drives the engine through this seam with runners as small as
`{ async run(p) { return `ran:${p}` } }`. The seam is real, load-bearing, and
already exercised — which is the strongest available evidence that a port is
viable.

### What `WorkflowAgent.run()` actually does

One call, one **fresh subagent session**, in-process
(`agent.ts:703-920`):

1. Build tools: `createCodingTools(runCwd)` (rebuilt when the cwd differs from the
   runner's, since tools capture cwd at construction) + caller tools, filtered by
   `applyToolPolicy(tools, allow, deny)`. Then append `systemTools`, then
   `structured_output` — both **after** the filter, so a restrictive agentType
   allowlist can't strip the shared store or the schema channel.
2. Resolve registry → model spec → concrete `Model` (+ thinking level).
3. `createAgentSession({ cwd, agentDir, sessionManager, settingsManager, customTools, resourceLoader, modelRuntime, model, thinkingLevel, excludeTools })`.
4. `await session.prompt(builtPrompt)` — one prompt; the SDK runs the agent loop.
5. `throwIfProviderLimit(session.messages)`, then either the schema path or
   `finalAssistantText` — which requires assistant text *after the last tool
   result*, because text before it is stale progress and accepting it would report
   an incomplete run as successful (`agent.ts:958-987`).
6. `finally`: remove listeners, emit history, read `session.getSessionStats()` for
   real usage **before** disposal, `session.dispose()`.

### Model resolution precedence

Split across two files. In `workflow.ts:606-612`, `explicitModel = opts.model ??
agentDef.model`, and `modelSpec = explicitModel ?? (opts.tier ? undefined :
phaseModel)`. In `agent.ts:183-203`, `resolveAgentModelSpec` applies
`options.model` → `options.tier` via `model-tiers.json` (falling back to the
session main model) → **implicit `"medium"` tier when a tier config exists at all**
→ session default. The contract states the full chain as:

> explicit model > agentType model > tier > phase model > metadata model >
> implicit medium > session default

The asymmetry at `agent.ts:774-800` is worth copying conceptually: an *explicit*
model or tier that fails to resolve throws `MODEL_NOT_FOUND` (naming the tier and
what it resolved to), because silent substitution would run real calls against
different weights while the caller believes the pin was honored. The *implicit*
default tier degrades to the session default instead — the script never asked for
it — but the degrade is reported through `onModelFallback` so it lands in the
run's own log, not just a `console.warn`.

Phase routing itself is trivial (`model-routing.ts`): `meta.phases[].model`
becomes exact-match routes, `meta.model` is the default. Matching is exact and
case-sensitive by design; the comment notes that substring matching caused
mis-routes like `"analyze"` matching `"analyze-deep"`.

### The agentType registry

`.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user, with the legacy
`~/.pi/agents/` scanned and warned about). Frontmatter binds `tools`,
`disallowedTools`, `model`, `isolation`; the markdown body becomes the role prompt
prepended to the task. Project wins on name collision. The registry is
**snapshotted once per run** (`workflow.ts:418`) so two calls can't observe a
mid-run edit — determinism again.

### Tool exclusion

```js
export const DEFAULT_EXCLUDED_SUBAGENT_TOOLS = ["workflow", "workflow_control"];
```
(`agent.ts:510`)

The extension registers those tools globally, so without this a subagent could
start its own background workflows — recursive fan-outs unbounded by the parent's
`maxAgents`/concurrency/accounting. Separately, the shared per-run
`DefaultResourceLoader` is built with `noExtensions: true`
(`agent.ts:568-613`), which structurally removes the extension runtime from
subagents. That comment is worth reading in full before porting: it fixes a real
leak (every subagent otherwise re-ran every extension factory) at the cost of
subagents losing host-extension-registered tools such as MCP bridges.

**Everything in this section is Pi-specific.** A Herdr port replaces all of it with
pane lifecycle: create/claim a pane, `agent.start --kind`, `agent.prompt` with
`wait`, harvest the result, tear down. What it must *preserve* is the contract the
engine depends on: `run()` resolves to the result or rejects with something
`wrapError` can classify; it honors the `AbortSignal`; it reports usage; the
result is a string when no schema is given and a schema-satisfying value when one
is.

---

## 11. The capability contract

`workflow-capability-contract.ts` is a single frozen data structure describing
every capability once, from which three separate surfaces are derived.

Each `CapabilityDescriptor` (`workflow-capability-contract.ts:51-67`) carries an
id, label, classification, support level, discovery placement, signature, option
shape, constraints, `enforcementOwner`, an optional `runtimeBinding`
(`{ global, implementation, allowsUndefined? }`), `behaviorEvidence` (paths to the
tests that prove the behavior), and a `staticReference` (doc path + anchor).

**Surface 1 — the vm globals.** `assembleRuntimeBindings(supplied)`
(`workflow-capability-contract.ts:710-722`) walks the declared bindings and builds
the globals object from the supplied implementations. A declared binding with no
implementation is a `MISSING_RUNTIME_IMPLEMENTATION` diagnostic and **throws**; a
supplied implementation nobody declared is a warning and is silently dropped from
the context. So a new global cannot reach a workflow script without a contract
entry — the contract isn't documentation *about* the runtime, it *is* the runtime's
assembly step.

**Surface 2 — the tool schema.** `WORKFLOW_TOOL_INPUT` capabilities describe the
`workflow` tool's parameters (`script`, `name`, `args`, `background`, `maxAgents`,
`concurrency`, `agentRetries`, `agentTimeoutMs`, `tokenBudget`, `resumeFromRunId`)
with `enforcementOwner: "workflowToolSchema and createWorkflowTool"`.

**Surface 3 — the docs.** `workflow-authoring-reference.ts` renders
`projectStaticReferenceFacts()` into a byte-identical Markdown table injected
between `<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->` markers in
`README.md`, `docs/workflow-authoring.md`, and
`skills/workflow-authoring/references/capabilities.md`, plus a full
`capability-details.md`. `npm run docs:check` runs the generator in `--check` mode
and exits non-zero if any surface is stale; it is wired into `release:check`.

The definition is validated and `deepFreeze`d at module load
(`workflow-capability-contract.ts:640-644, 807`), rejecting duplicate ids,
duplicate globals, duplicate implementation identities, runtime-global capabilities
with no binding, bindings that aren't project-origin runtime globals, and unknown
option-shape or dynamic-reference references. An invalid contract fails at import,
not at first use.

`DYNAMIC_REFERENCE` capabilities (`model-routes`, `agent-types`) exist to declare
what deliberately **isn't** in the static data: live catalogs owned by
`model-tier-config` and `agent-registry`, with a constraint reading *"live values
must not be copied into static contract data."*

This pattern is worth stealing wholesale and is not Pi-coupled — the descriptors
name their own implementations, and swapping the implementations is exactly what a
port does.

---

## 12. Portable vs Pi-specific

| Component | Where | Verdict | Notes for the port |
| --- | --- | --- | --- |
| Parse pipeline (blocklist → acorn → meta check → literal evaluator → splice) | `workflow.ts:1343-1465` | **Portable verbatim** | Zero Pi coupling. Only `acorn` |
| `DETERMINISM_PRELUDE` + vm context assembly | `workflow.ts:372-402, 1254-1264` | **Portable verbatim** | Keep it if you keep resume; audit any new global for nondeterminism |
| `callSeq` / `firstMiss` / longest-unchanged-prefix replay | `workflow.ts:618-674` | **Portable verbatim** | The hard part to rebuild; don't |
| `deltaKey = ${runId}:${callIndex}`, nested runId minting | `workflow.ts:634, 1004` | **Portable, must extend** | Add machine + agent kind to the *hash*, not the key — see below |
| `hashAgentCall` inputs | `workflow.ts:1519-1538` | **Portable, must extend** | Currently `{prompt, model, tier, phase, agentType, agentDef, schema}`. A Herdr port must add machine and `--kind`, or a resume replays a codex-on-host-A result as if claude-on-host-B produced it |
| `JournalEntry` shape | `workflow.ts:60-86` | **Portable** | `result: unknown` is backend-agnostic |
| `SharedStore` + delta commit/discard/apply | `shared-store.ts` | **Portable logic, Pi-specific tools** | The class is pure; `createAgentStoreTools` uses `defineTool`/typebox and must be re-expressed however your agents call tools (or via the file contract) |
| `createLimiter` + atomic slot reservation | `workflow.ts:1467-1483, 636-642` | **Portable verbatim** | Preserve "no await between check and increment" as a property; the concurrency unit becomes panes, not sessions |
| `fanoutScope` batch cancellation | `workflow.ts:44, 883-957` | **Portable verbatim** | `AsyncLocalStorage` is Node, not Pi |
| `runFatalController` + `inFlight` drain | `workflow.ts:117-142, 1309-1339` | **Portable verbatim** | Drain is *more* important with real processes — an undrained pane keeps running |
| Per-attempt `AbortController` + `withTimeout` | `workflow.ts:715-787, 1586` | **Portable shape** | Abort must actually stop a pane (interrupt key / `pane.kill`), not just detach |
| Retry loop + recoverable→`null` collapse | `workflow.ts:715-866` | **Portable verbatim** | The single most important contract to preserve |
| Quality stdlib (`verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`) | `workflow.ts:1014-1184` | **Portable verbatim** | Built purely on `agent()`/`parallel()` |
| `checkpoint()` + `hashCheckpoint` | `workflow.ts:1191-1224, 1507` | **Portable verbatim** | The `confirm` callback is host-supplied already |
| Error codes + `wrapError` + recoverable split | `errors.ts` | **Portable taxonomy, rewire classification** | Map pane/agent failures onto the codes; decide where `blocked` lands |
| `classifyProviderLimit` / `throwIfProviderLimit` | `errors.ts:140`, `agent.ts:97` | **Concept portable, mechanism Pi-specific** | Depends on `stopReason: "error"` on an SDK assistant message. Herdr has no equivalent signal; a CLI's own quota message would have to be scraped |
| Capability contract + generated docs + `docs:check` | `workflow-capability-contract.ts`, `workflow-authoring-reference.ts` | **Portable verbatim** | Change the descriptor list, keep the machinery |
| Authoring skill + comprehension/coverage CI | `skills/`, `workflow-comprehension.ts` | **Portable pattern** | Directly relevant if "ask the AI to use workflow" must work reliably |
| `WorkflowAgentRunner` interface | `workflow.ts:152-155` | **The seam** | Narrow `AgentRunOptions` off typebox `TSchema` and the SDK types first |
| `WorkflowAgent` class | `agent.ts:523-988` | **Replace entirely** | Session creation, resource loader, tool policy, message inspection — all Pi SDK |
| `structured_output` tool | `structured-output.ts` | **Replace mechanism, keep funnel** | "Provider validates params against the schema" has no analogue when driving a CLI. Stages 2 and 3 (bounded repair, strict validated extraction) port directly, and stage 3 becomes the *primary* path |
| `extractValidated` | `agent.ts:57-73` | **Portable with a JSON Schema validator** | Swap typebox `Convert`/`Check` for ajv or equivalent |
| Model resolution (registry, tiers, thinking level, `MODEL_NOT_FOUND`) | `agent.ts:183-203, 744-801`, `model-tier-config.ts` | **Replace** | Herdr picks an agent *kind* and a machine, not a provider/model id. The MODEL_NOT_FOUND asymmetry (explicit → throw, implicit → degrade loudly) is worth keeping as a policy shape |
| agentType registry (`.pi/agents/*.md`) | `agent-registry.ts` | **Portable pattern** | Markdown + frontmatter binding tools/model/prompt; `agentDefinitionKey` feeding the hash is the part that matters |
| Tool exclusion (`DEFAULT_EXCLUDED_SUBAGENT_TOOLS`, `noExtensions`) | `agent.ts:510, 568-613` | **Concept portable, mechanism replaced** | Recursion prevention is still needed: a coding-agent CLI in a pane can absolutely invoke your engine's CLI |
| Worktree isolation | `worktree.ts` | **Portable, likely redundant** | 36 lines of `git worktree` shell-out. Herdr has `worktree.create`; use it, but keep the deterministic name and the best-effort fallback |
| Token accounting: `recordTokens`, `budget`, phase sub-budgets, `onRetrySpend`, `initialTokenUsage` | `workflow.ts:500-513, 700-712, 576-596` | **Structure portable, signal absent** | Herdr sees panes, not tokens. Re-key onto agent-count and wall-clock, but keep the *shape*: soft pre-call gate, post-hoc accrual, separate retry-spend channel, seeded-on-resume cumulative total |
| `PROVIDER_USAGE_LIMIT` → pause → auto-resume | `errors.ts:40-45`, `usage-limit-scheduler.ts` | **Drop or rebuild** | No token signal to trigger it |
| `WorkflowManager` (persistence, leases, eviction, pause/stop/resume, snapshots) | `workflow-manager.ts` | **Rewrite, study first** | Not Pi-coupled in principle, but 1,455 lines of host policy. The `resume()` seeding asymmetries (§6) are the load-bearing bits |
| `workflow-ui.ts`, `display.ts`, `task-panel.ts` | — | **Drop** | Herdr's `pane.report_metadata` + `agent.view.set` replace the display layer entirely |

### The three highest-risk deltas

1. **Result harvesting.** Pi's runner returns a value from an in-process session.
   A pane returns a screen. The file-contract decision (briefing §3) is the right
   call, but it changes `run()`'s failure surface: "agent finished but wrote no
   output file" is a new, common, *recoverable* error that has no Pi analogue.
   Wire it to `AGENT_EMPTY_OUTPUT` semantics.

2. **Structured output without provider-side validation.** Pi gets validation for
   free because the schema *is* the tool's parameter schema. A CLI-driven agent
   gives you prose. Stage 3 becomes the primary path, so `extractValidated`'s
   "never fabricate" rule and the non-recoverable `SCHEMA_NONCOMPLIANCE` become
   *more* important, not less.

3. **`blocked` has no Pi equivalent.** Pi subagents never ask for permission. A
   real coding-agent CLI does, Herdr detects it, and the engine must decide. This
   is genuinely new state, not a port of anything, and it needs its own place in
   the error taxonomy and its own policy hook.
