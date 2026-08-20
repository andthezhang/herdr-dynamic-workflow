---
name: herdr-workflow-authoring
description: Write and run a dynamic workflow on Herdr — a JS script whose agent() calls run real coding-agent CLIs (claude, codex, cursor, …) as subagents in Herdr panes, locally or on fleet machines over ssh. Use when asked to run a herdr workflow, fan a task out across subagents, pick which CLI or machine an agent call runs on, or resume an earlier run.
---

# Authoring a herdr workflow

A **workflow** is one JS file that orchestrates other coding-agent CLIs as
subagents. It structures work that would otherwise overflow one agent's
context or benefit from running several agents at once: fan a task out across
files, get independent reviews from two different CLIs and reconcile them,
run a design → implement → review pipeline, or place work on a specific
machine in a fleet. Each `agent()` call in the script becomes a real CLI
process (claude, codex, cursor, …) running in its own Herdr terminal pane; the
script itself only orchestrates — it never edits files or runs shell commands
directly.

You write the script; Herdr runs it and reports back a result. Nothing about
the *dialect* below is Herdr-specific — it is the same scripting model used by
Claude Code's own `Workflow` tool. What's new here is two fields on every
`agent()` call (`kind`, `machine`) that pick which CLI and which computer each
call runs on, because unlike Claude Code's tool, a herdr workflow is not
implicitly "more Claude."

## How a run starts

```bash
herdr plugin action invoke herdrflow.engine.run -- \
  "$PWD/<script.js>" --cwd "$PWD" [--fleet "$PWD/fleet.toml"]
```

There is no separate "compile" step. Point the command at a `.js` file and it
runs. Zero config: the run appears live in your own Herdr sidebar as a
workspace named after the workflow (`<meta.name> · <last-4-of-run-id>`), one
tab per `agent()` call, so you (or the user) can watch it happen. If your
session is unreachable it falls back to a hidden `flow` worker session,
autostarting that session's server; `--session <name>` forces a named worker
session. On success you get back `{ result, agentCount, durationMs }` — no
token numbers (see "budget", below).

Resume a run that crashed, or one whose script you've since edited: unchanged
calls replay instantly from the journal, and only the first changed/new call
and everything after it runs live.

```bash
herdr plugin action invoke herdrflow.engine.resume -- --run <runId>
```

Every worker is a real terminal, reachable while it runs:

```
herdr --session flow                       # the worker session, when one is used
herdr --session flow agent attach <name>   # one worker, in this terminal
ssh -t <host> '<herdr_bin> --session flow' # a remote machine's workers
```

## The script contract

```js
export const meta = {
  name: "hello",
  description: "One agent answers a question",
};

const answer = await agent("What port does Herdr's control plane listen on by default?");
log(`answer: ${answer}`);
return { answer };
```

Five hard rules, because the script runs inside a deterministic, replayable
sandbox — not a general Node process:

1. **The first statement must be `export const meta = { ... }`**, a plain
   object literal — no variables, function calls, spreads, or computed keys.
   `name` and `description` are required; `phases: [{ title }, ...]` is
   optional and only affects progress display.
2. **Plain JavaScript, not TypeScript.** No type annotations, interfaces, or
   generics — they fail to parse. No `import` — everything the script needs
   (`agent`, `parallel`, `log`, …) is already a global.
3. **Top-level `await` and a bare top-level `return` both work.** The body is
   not wrapped in a function you write yourself; write it as if it already
   were the inside of an async function.
4. **No `Date.now()`, `Math.random()`, or argless `new Date()`.** They would
   make a resumed run replay differently than it ran live, so the sandbox
   blocks them outright. Need a timestamp or randomness? Take it from `args`,
   or vary it per call by index (`label: `run-${i}``) instead of by RNG.
5. **Return plain, JSON-serializable data.** The result crosses out of the
   sandbox as JSON; functions, class instances, and circular references don't
   survive the trip.

## The globals

| Global | Signature | What it does |
| --- | --- | --- |
| `agent` | `agent(prompt, options?) => Promise<string \| structured \| null>` | Runs one subagent CLI call and waits for it to go idle. The only global that spends an agent slot. |
| `parallel` | `parallel(thunks) => Promise<Array<unknown\|null>>` | Runs `() => agent(...)` thunks concurrently; a **barrier** — waits for all of them. **Thunks, not promises** — `parallel([agent(...)])` starts every call immediately and defeats the concurrency limiter silently; always wrap: `parallel(items.map(x => () => agent(...)))`. |
| `pipeline` | `pipeline(items, ...stages) => Promise<Array<unknown\|null>>` | Items run concurrently; each item's own stages run in order, with **no barrier between stages** — the default for multi-stage fan-out. Each stage gets `(prev, originalItem, index)`. |
| `phase` | `phase(title, {budget?}) => void` | Labels the group subsequent `agent()` calls fall under, for progress display; optional soft call-count sub-budget. |
| `log` | `log(message) => void` | User-visible progress line. Prefer this over `console.log` (routed into it anyway). |
| `args` | `args: unknown` | The only input channel into the script — whatever was passed at invoke time. |
| `budget` | `budget: { total, spent(), remaining() }` | See "budget", below. |
| `workflow` | `workflow(nameOrScript, childArgs?) => Promise<unknown>` | Runs another saved workflow inline, one nesting level deep, sharing this run's limiter/budget. |

A dead agent — crashed pane, exhausted retries, a recoverable error — resolves
to `null` rather than throwing. **Always guard before using a result**:
`(reply && reply.field) || fallback`, or `.filter(Boolean)` on an array of
results from `parallel`/`pipeline`.

### `agent()` options

```js
await agent(prompt, {
  kind,        // which CLI: "claude" | "codex" | "cursor" | ... — see below
  machine,     // which computer: a name, a tag selector, or omitted — see below
  label,       // names this call in logs, the journal, and the Herdr pane tab
  schema,      // a plain JSON Schema object — turns the reply into structured
               // data instead of a string. Not a builder; the script never
               // imports anything, so this is a literal object.
  model,       // explicit model override, resolved against fleet config
  effort,      // explicit reasoning-effort override, resolved against fleet config
  isolation,   // "worktree" — see "Isolation", below
});
```

## `kind` and `machine`: the two things Claude Code's dialect doesn't have

```js
const review = await agent("Review the diff.", { kind: "codex" });     // which CLI
const built = await agent("Implement it.", { machine: "linux-box" });  // which computer
const bench = await agent("Run the benchmarks.", { machine: { tag: "linux" } });
```

**Omit both by default** — defaults come from the fleet config's `[defaults]`
and the run's `--kind` flag. `machine` accepts either a configured machine's
`name`, or `{ tag: "..." }` to place on any machine carrying that tag; either
form resolves to the least-occupied eligible machine when more than one
qualifies.

Machine names and tags come from `fleet.toml`, not from anywhere else — naming
one that isn't configured there is a validation error, never a silent
fallback to local. So before naming one, read the fleet a run will load
automatically (unless `--fleet` points elsewhere):

```bash
cat "$(herdr plugin config-dir herdrflow.engine)/fleet.toml"
```

The same strictness covers `model` / `effort`: a value the fleet config can't
resolve fails that specific call at validation time, before it touches any
pane — non-recoverably, so the run dies there. (Scripts are dynamic, so there
is no whole-script pass up front: agents started by earlier calls have
already run by the time a later call fails validation.) And `kind: "cline"` —
in any spelling herdr would accept as cline — is always rejected: herdr has no
idle-detection rule for cline, so a wait on it could never resolve.

## `budget` counts agent calls, never tokens or money

Herdr has no token signal. The `{ total, spent(), remaining() }` shape is
unchanged from Claude Code's dialect, but `spent()` counts agent calls (one
per attempt), not tokens. There is no run-wide cap to configure, so
`budget.total` is `null` and `remaining()` is `Infinity` by default; the real
knob is `phase(title, { budget: n })`, which caps that phase at `n` agent
calls. Wall-clock is reported (the envelope's `durationMs`), not capped. If
the user asked to cap *cost*, say so explicitly — this engine caps breadth,
not spend.

## The quality stdlib

Six more globals, all built purely on top of `agent()`/`parallel()` — nothing
privileged about them, just reusable patterns so scripts don't hand-roll them:

| Global | Signature | What it does |
| --- | --- | --- |
| `verify` | `verify(item, {reviewers?, threshold?, lens?})` | Spawns N independent adversarial reviewers, each voting `real: boolean`; accepts if the `real` fraction clears `threshold`. |
| `judgePanel` | `judgePanel(attempts, {judges?, rubric?})` | Scores each candidate 0–1 with N judges per candidate on `rubric`, returns the highest-mean attempt (ties by index). |
| `loopUntilDry` | `loopUntilDry({round, key?, consecutiveEmpty?, maxRounds?})` | Repeats `round(roundIndex)` until N consecutive rounds produce no new keys — for open-ended discovery (bugs, edge cases) where a fixed count would miss the tail. |
| `completenessCheck` | `completenessCheck(taskArgs, results)` | One critic agent that lists what's still missing from `results` given `taskArgs`. |
| `retry` | `retry(thunk, {attempts?, until?})` | Re-runs `thunk(attempt)` until `until(result)` passes or attempts run out. `until` is synchronous. |
| `gate` | `gate(thunk, validator, {attempts?})` | Like `retry`, but `validator(result)` returns `{ok, feedback?}` and `feedback` is threaded into the next attempt. |
| `checkpoint` | `checkpoint(promptText, options?) => Promise<unknown>` | A human gate: journaled and replayable like `agent()`, but consumes no agent budget. Headless runs take the declared default rather than hanging. |

## Isolation is cheap here, and usually right

`isolation: "worktree"` is flagged as expensive in Claude Code, because there
it's extra setup on top of a shared session. Here every call already gets its
own pane, so a worktree is the marginal cost of one `git worktree add`. Use it
whenever agents in the same `parallel()`/`pipeline()` write files — two agents
editing one checkout is a data race the engine cannot fix. (Worktree isolation
runs on local machines only.)

## Where to go next

- `reference/patterns.md` — composing `pipeline()`/`parallel()`/the quality
  stdlib for real tasks: when a barrier is actually justified, looping until
  you have enough instead of a fixed count, varying `kind`/`machine` inside a
  fan-out, hand-rolled adversarial verify, and how to inline an existing
  skill's instructions into an `agent()` prompt when the subagent CLI won't
  have that skill installed.
- `reference/*.js` — five runnable example scripts, one per pattern above.
  When asked to write a new workflow, start from whichever is closest to the
  shape of the task and adapt it, rather than writing the script shape from
  memory.
