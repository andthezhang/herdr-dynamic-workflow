# Reference: Claude Code's Workflow tool description

**What this is.** Claude Code has no separate "workflow skill" file — the instructions that
teach the model to write workflow scripts *are* the Workflow tool's own description, supplied
to the model alongside the tool schema. This document reproduces that text.

**Why it is here.** [D1](../SPEC.md#d1-the-script-interface-is-claude-codes-verbatim-plus-two-options) commits
us to matching this interface exactly. This is the thing being matched, so it belongs in the
repo as primary source rather than as a paraphrase. When our authoring skill is generated from
the capability contract
([D18](../SPEC.md#d18-the-authoring-skill-is-a-tested-artifact)), this
is what it should be diffed against.

**Caveat.** This is a transcript of one observed version and may drift. It is a reference
point, not a contract we control.

For pi's equivalent — which *is* a real skill directory — see `skills/workflow-authoring/`
in the pi-dynamic-workflows repository: a SKILL.md plus 15 reference files and 12 example
scripts.

---

## Tool inputs

| Input | Notes |
| --- | --- |
| `script` | Self-contained workflow script. Must begin with `export const meta = {...}`. Max 524,288 chars. |
| `scriptPath` | Path to a script file on disk. Takes precedence over `script` and `name`. |
| `name` | Name of a predefined workflow (built-in or from `.claude/workflows/`). |
| `args` | Value exposed to the script as the global `args`, verbatim. Untyped JSON. |
| `resumeFromRunId` | Run ID of a prior invocation to resume from. Claude: `^wf_[a-z0-9-]{6,}$`. |
| `title` | *Ignored* — set the workflow title in the script's `meta` block. |
| `description` | *Ignored* — set the workflow description in the script's `meta` block. |

No required fields. Precedence: `scriptPath > script > name`. `additionalProperties: false` on Claude's schema, except they still declare the vestigial `title` / `description` keys.

Our CLI takes that same object. See the field-by-field table in [README.md](../README.md#claudes-workflow-tool-vs-this-cli). Differences: we reject `title` / `description`, we reject `name` until we have a registry, our `resumeFromRunId` is `run-…`, and we add `kind` / `session` / `cwd`. Claude tells the model to pass `script` inline and not Write a file. We tell the model to Write a file and pass `scriptPath`, because the host is a shell.

---

## The description, as supplied to the model

> Execute a workflow script that orchestrates multiple subagents deterministically. Workflows
> run in the background — this tool returns immediately with a task ID, and a
> `<task-notification>` arrives when the workflow completes. Use `/workflows` to watch live
> progress.
>
> A workflow structures work across many agents — to be comprehensive (decompose and cover in
> parallel), to be confident (independent perspectives and adversarial checks before
> committing), or to take on scale one context can't hold (migrations, audits, broad sweeps).
> The script is where you encode that structure: what fans out, what verifies, what
> synthesizes.

### Opt-in gate

> ONLY call this tool when the user has explicitly opted into multi-agent orchestration.
> Workflows can spawn dozens of agents and consume a large amount of tokens; the user must
> request that scale, not have it inferred. Explicit opt-in means one of:
>
> - The user included the keyword "ultracode" in their prompt.
> - Ultracode is on for the session.
> - The user directly asked to run a workflow or use multi-agent orchestration in their own
>   words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with
>   subagents"). The ask must be in the user's words — a task that would merely benefit from a
>   workflow does not count.
> - The user invoked a skill or slash command whose instructions tell you to call Workflow.
> - The user asked to run a specific named or saved workflow.
>
> For any other task — even one that would clearly benefit from parallelism — do NOT call this
> tool.

### Hybrid scouting

> When you do call it, the right move is often **hybrid**: scout inline first (list the files,
> find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline
> over it. You don't need to know the shape before the *task* — only before the *orchestration
> step*.

### Common single-phase workflows

> - **Understand** — parallel readers over relevant subsystems → structured map
> - **Design** — judge panel of N independent approaches → scored synthesis
> - **Review** — dimensions → find → adversarially verify
> - **Research** — multi-modal sweep → deep-read → synthesize
> - **Migrate** — discover sites → transform each (worktree isolation) → verify
>
> For larger work, run several in sequence — read each result before deciding the next phase.

### The `meta` block

> Every script must begin with `export const meta = {...}`:
>
> ```js
> export const meta = {
>   name: 'find-flaky-tests',
>   description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
>   phases: [                                            // one entry per phase() call
>     { title: 'Scan', detail: 'grep test logs for retries' },
>     { title: 'Fix', detail: 'one agent per flaky test' },
>   ],
> }
> ```
>
> The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template
> interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the
> workflow list), `phases`. Use the SAME phase titles in `meta.phases` as in `phase()` calls —
> titles are matched exactly; a `phase()` call with no matching meta entry just gets its own
> progress group. Add `model` to a phase entry when that phase uses a specific model override.

### Script body hooks

> - **`agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?:
>   string, effort?: string, isolation?: 'worktree', agentType?: string}): Promise<any>`** —
>   spawn a subagent. Without `schema`, returns its final text as a string. With `schema` (a
>   JSON Schema), the subagent is forced to call a StructuredOutput tool and `agent()` returns
>   the validated object — no parsing needed. Returns `null` if the user skips the agent
>   mid-run or the subagent dies on a terminal API error after retries (filter with
>   `.filter(Boolean)`).
>   - `opts.label` overrides the display label.
>   - `opts.phase` explicitly assigns this agent to a progress group (use this inside
>     `pipeline()`/`parallel()` stages to avoid races on the global `phase()` state — same
>     phase string → same group box).
>   - `opts.model` overrides the model for this agent call. Default to omitting it — the agent
>     inherits the main-loop model (the resolved session model), which is almost always
>     correct. Only set it when you're highly confident a different tier fits the task; when
>     unsure, omit.
>   - `opts.effort` overrides the reasoning effort for this agent call (`'low' | 'medium' |
>     'high' | 'xhigh' | 'max'`) — omit to inherit the session effort; use `'low'` for cheap
>     mechanical stages and higher tiers only for the hardest verify/judge stages.
>   - `opts.isolation: 'worktree'` runs the agent in a fresh git worktree — EXPENSIVE
>     (~200-500ms setup + disk per agent), use ONLY when agents mutate files in parallel and
>     would otherwise conflict; the worktree is auto-removed if unchanged.
>   - `opts.agentType` uses a custom subagent type (e.g. `'general-purpose'`,
>     `'code-reviewer'`) instead of the default workflow subagent — resolved from the same
>     registry as the Agent tool; composes with `schema`.
>
> - **`pipeline(items, stage1, stage2, ...): Promise<any[]>`** — run each item through all
>   stages independently, NO barrier between stages. Item A can be in stage 3 while item B is
>   still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item
>   chain, not sum-of-slowest-per-stage. Every stage callback receives `(prevResult,
>   originalItem, index)`. A stage that throws drops that item to `null` and skips its remaining
>   stages.
>
> - **`parallel(thunks: Array<() => Promise<any>>): Promise<any[]>`** — run tasks concurrently.
>   This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent
>   errors) resolves to `null` in the result array — the call itself never rejects, so
>   `.filter(Boolean)` before using the results. Use ONLY when you genuinely need all results
>   together.
>
> - **`log(message: string): void`** — emit a progress message to the user.
> - **`phase(title: string): void`** — start a new phase; subsequent `agent()` calls are grouped
>   under this title in the progress display.
> - **`args: any`** — the value passed as Workflow's `args` input, verbatim (`undefined` if not
>   provided). Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string.
> - **`budget: {total: number|null, spent(): number, remaining(): number}`** — the turn's token
>   target. `budget.total` is `null` if no target was set. `spent()` returns output tokens spent
>   this turn across the main loop and all workflows — the pool is shared, not per-workflow.
>   `remaining()` returns `max(0, total - spent())`, or `Infinity` if no target. The target is a
>   HARD ceiling: once `spent()` reaches `total`, further `agent()` calls throw.
> - **`workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any>`** — run
>   another workflow inline as a sub-step. The child shares this run's concurrency cap, agent
>   counter, abort signal, and token budget. **Nesting is one level only.**

### Language constraints

> Scripts are plain JavaScript, NOT TypeScript — type annotations (`: string[]`), interfaces,
> and generics fail to parse. The script body runs in an async context — use `await` directly.
> Standard JS built-ins are available — EXCEPT `Date.now()`/`Math.random()`/argless `new
> Date()`, which throw (they would break resume); pass timestamps in via `args`, stamp results
> after the workflow returns, and for randomness vary the agent prompt/label by index. No
> filesystem or Node.js API access.

### pipeline vs parallel

> DEFAULT TO `pipeline()`. Only reach for a barrier when you genuinely need ALL prior-stage
> results together.
>
> A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
> dedup/merge across the full result set before expensive downstream work; early-exit if the
> total count is zero; stage N's prompt references "the other findings" for comparison.
>
> A barrier is NOT justified by: "I need to flatten/map/filter first" — do it inside a pipeline
> stage. "The stages are conceptually separate" — that's what `pipeline()` models; separate
> stages ≠ synchronized stages. "It's cleaner code" — barrier latency is real.
>
> Smell test: if you wrote
> ```js
> const a = await parallel(...)
> const b = transform(a)        // flatten, map, filter — no cross-item dependency
> const c = await parallel(b.map(...))
> ```
> that middle transform doesn't need the barrier. When in doubt: pipeline.

### Limits

> Concurrent `agent()` calls are capped at `min(16, cpu cores - 2)` per workflow — excess calls
> queue and run as slots free up. Total agent count across a workflow's lifetime is capped at
> 1000. A single `parallel()`/`pipeline()` call accepts at most 4096 items.

### The canonical multi-stage pattern

> ```js
> export const meta = {
>   name: 'review-changes',
>   description: 'Review changed files across dimensions, verify each finding',
>   phases: [{ title: 'Review' }, { title: 'Verify' }],
> }
> const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
> const results = await pipeline(
>   DIMENSIONS,
>   d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
>   review => parallel(review.findings.map(f => () =>
>     agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
>       .then(v => ({...f, verdict: v}))
>   ))
> )
> const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
> return { confirmed }
> ```

### Loop patterns

> **Loop-until-count** — accumulate to a target:
> ```js
> const bugs = []
> while (bugs.length < 10) {
>   const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
>   bugs.push(...result.bugs)
>   log(`${bugs.length}/10 found`)
> }
> ```
>
> **Loop-until-budget** — guard on `budget.total`: with no target set, `remaining()` is
> `Infinity` and the loop would run straight to the 1000-agent cap.
> ```js
> while (budget.total && budget.remaining() > 50_000) { ... }
> ```
>
> **Loop-until-dry** — dedup vs `seen`, NOT vs `confirmed`, or judge-rejected findings reappear
> every round and it never converges.

### Quality patterns

> - **Adversarial verify** — spawn N independent skeptics per finding, each prompted to REFUTE.
>   Kill if ≥majority refute.
> - **Perspective-diverse verify** — when a finding can fail in more than one way, give each
>   verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N
>   identical refuters.
> - **Judge panel** — generate N independent attempts from different angles, score with parallel
>   judges, synthesize from the winner while grafting the best ideas from runners-up.
> - **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive
>   rounds return nothing new. Simple counters miss the tail.
> - **Multi-modal sweep** — parallel agents each searching a different way (by-container,
>   by-content, by-entity, by-time).
> - **Completeness critic** — a final agent that asks "what's missing — modality not run, claim
>   unverified, source unread?"
> - **No silent caps** — if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what
>   was dropped; silent truncation reads as "covered everything" when it didn't.
>
> Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify.
> "thoroughly audit this" → larger finder pool, 3–5 vote adversarial pass, synthesis stage.

### Resume

> The tool result includes a `runId`. To resume after a pause, kill, or script edit, relaunch
> with `{scriptPath, resumeFromRunId}` — the longest unchanged prefix of `agent()` calls returns
> cached results instantly; the first edited/new call and everything after it runs live. Same
> script + same args → 100% cache hit. Before diagnosing why a completed workflow returned an
> empty result, read `<transcriptDir>/journal.jsonl` — it records each agent's actual return
> value.

---

## What we inherit and what we don't

| Element | Us |
| --- | --- |
| `meta` shape, pure-literal rule | inherited exactly ([D1](../SPEC.md#d1-the-script-interface-is-claude-codes-verbatim-plus-two-options)) |
| `agent()` seven options | inherited exactly; `model`/`effort` resolve via config ([D4](../SPEC.md#d4-environmental-options-live-in-config-not-the-script)) |
| `parallel` barrier / `pipeline` no-barrier semantics | inherited exactly |
| `null` on dead agent, `.filter(Boolean)` idiom | inherited exactly |
| determinism restrictions | inherited ([D7](../SPEC.md#d7-determinism-is-enforced-and-the-sandbox-is-not-a-security-boundary)) |
| resume by longest-unchanged-prefix | inherited, plus the ssh host and kind in the hash ([D6](../SPEC.md#d6-resume-is-longest-unchanged-prefix-replay-keyed-on-placement-too)) |
| pipeline-over-parallel guidance, quality patterns | should be carried into our authoring skill verbatim — it is good advice independent of substrate |
| `budget` in tokens, hard ceiling | **not inheritable** — agents and wall-clock instead ([D8](../SPEC.md#d8-budget-counts-agents-and-wall-clock-not-tokens)) |
| concurrency `min(16, cores-2)` | not capped per destination; a call names its host with `ssh` ([D13](../SPEC.md#d13-local-machines-use-the-socket-remote-machines-use-plain-herdr-over-ssh)) |
| the opt-in gate | not applicable — invoking this engine is already an explicit act |
| Workflow tool JSON (`script` / `scriptPath` / `name` / `args` / `resumeFromRunId`) | the CLI takes that object. `name` rejected until we have a registry. `title` / `description` rejected. Host extras: `kind`, `session`, `cwd` |
