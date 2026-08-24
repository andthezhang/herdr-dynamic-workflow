# Composing agent() calls

Deeper guidance for combining `agent()` / `parallel()` / `pipeline()` /
`kind` / `ssh` / the quality stdlib. Read this after `SKILL.md` once the
basics aren't enough — none of this is required to write a working script.

## `pipeline()` by default; `parallel()` only for a genuine barrier

`pipeline(items, stage1, stage2, ...)` runs every item through all stages with
**no barrier between stages** — item A can be in stage 2 while item B is still
in stage 1. Wall-clock is the slowest single chain, not the sum of the
slowest-per-stage. This is the default for any multi-stage fan-out.

```js
const results = await pipeline(
  files,
  (file) => agent(`Review ${file} for bugs.`, { label: `review:${file}`, schema: FINDINGS }),
  (review, file) => agent(`Verify: ${JSON.stringify(review)}`, { label: `verify:${file}`, schema: VERDICT }),
);
```

`parallel(thunks)` is a **barrier**: it awaits every thunk before returning
anything. Reach for it only when stage N genuinely needs every stage-(N-1)
result *together* — deduping across a full result set before expensive
verification, or an early exit when a total count is zero. "I need to
flatten/map/filter first" is not a reason to barrier: do the transform inside
a pipeline stage instead. When unsure, use `pipeline`.

## Loop until you have enough, not a fixed count

For open-ended discovery (bugs, edge cases, missing coverage) a fixed
`for` loop misses the tail. Either drive it yourself:

```js
const bugs = [];
while (bugs.length < 10) {
  const found = await agent("Find more bugs in this diff.", { schema: BUGS });
  bugs.push(...(found?.bugs ?? []));
}
```

or use `loopUntilDry`, which repeats rounds until N consecutive rounds
surface nothing new — see the quality-stdlib table in `SKILL.md`.

## Picking `kind` or `ssh` per call inside a fan-out

`kind` and `ssh` are just fields in the `options` object each thunk builds, so
a fan-out can vary either per call:

```js
// Same target, two independent lenses — see reference/second-opinion.js.
const [correctness, maintainability] = await parallel(
  ["correctness", "maintainability"].map((lens) => () =>
    agent(`${prompt}\n\nReview lens: ${lens}`, { kind: "codex", label: `review:${lens}` }),
  ),
);
```

```js
// Same prompt spread across several ssh hosts, named in args.
const perHost = await parallel(
  args.hosts.map((host) => () => agent(prompt, { ssh: host, label: `run:${host}` })),
);
```

Remember: `ssh` is a name that already works in your terminal — there is no
inventory file, and an empty one is a validation error rather than a silent
fallback to this computer.

## Adversarial verify, by hand

`verify()` already does N-reviewer adversarial voting (see `SKILL.md`). Reach
for the hand-rolled version only when you need a majority vote across
*qualitatively different* lenses rather than N identical reviewers — e.g. one
reviewer checking correctness, one checking security, one checking whether the
fix actually reproduces the original failure:

```js
const lenses = ["correctness", "security", "reproduces the bug"];
const votes = await parallel(
  lenses.map((lens) => () =>
    agent(`Judge via the ${lens} lens — is this real? Default to false if unsure.\n\n${claim}`, {
      label: `verify:${lens}`,
      schema: { type: "object", properties: { real: { type: "boolean" } }, required: ["real"] },
    }),
  ),
);
const survives = votes.filter(Boolean).filter((v) => v.real).length >= 2;
```

## No silent caps

If a script bounds its own coverage — top-N results, no retry on failure,
a sampled subset — `log()` what got dropped. A run that silently truncated
its coverage looks identical, from the envelope, to one that covered
everything.

## Reading these examples

Every file in this directory is runnable as-is:

```bash
herdr-dynamic-workflow '{"scriptPath":"skills/herdr-workflow-authoring/reference/<file>"}'
```

| File | Pattern |
| --- | --- |
| `hello-workflow.js` | Sequential `agent()` calls across `phase()`s, `schema` for structured output, falling back when an agent returns `null`. |
| `second-opinion.js` | `parallel()` fan-out with two independent review lenses, comparing structured results, and a reconciliation call only when they disagree. |
| `quality-stdlib-hello.js` | `verify()` for adversarial fact-checking and `judgePanel()` for picking the best of several attempts. |
| `ssh-hello.js` | Explicit placement — one call here, one on a named ssh host. |

## Inlining a skill into a prompt

Every `agent()` call is a separate CLI process. It does not share this
session's skills, subagents, or slash commands — whatever guidance a call
needs has to be *in the prompt string*, not referenced by name. Two
consequences:

- **Don't write `"Use the /diagnosing-bugs skill."`** in a prompt. The
  subagent CLI herdr starts (possibly a different vendor than whoever wrote
  the workflow) has no such skill installed, and even if it did, invoking it
  by name is a no-op outside the session that defines it.
- **Paste the skill's actual body into the prompt instead**, verbatim, as a
  template-literal constant, then reference that constant from the `agent()`
  call: `` `${SOME_SKILL}\n\n---\n\nApply it to: ${request}` ``. The agent then
  has the real instructions in front of it, not a name it can't resolve.

For a router workflow, define one prompt constant per route. Let the routing
call return a schema-checked route name, then pass only the matching prompt and
the original request to the executing call. If a route needs independent
review lenses, use `parallel()` and reconcile their results afterward.
