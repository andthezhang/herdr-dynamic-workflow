// Ask-Matt-style router: one agent classifies `args.request` into a flow —
// diagnose / build / review, echoing the ask-matt skill's job of routing a
// situation to the right process — then a second stage runs that flow.
//
// Each flow's agent() call carries the ORIGINAL skill's full instructions
// inline in its prompt, verbatim, rather than naming the skill and hoping the
// subagent CLI knows it. It won't: herdr starts a real, separate CLI process
// for every agent() call, and that process has no access to this session's
// skills. Whatever guidance a call needs, the prompt has to carry.
//
// Real ask-matt routes to more flows (triage, grill-with-docs, to-prd, ...);
// this example keeps three so the routing + inlining pattern stays readable
// end to end. Add a fourth the same way: one more ROUTE_MAP line, one more
// embedded skill constant, one more branch below.
//
//   herdr-dynamic-workflow '{"scriptPath":"skills/herdr-workflow-authoring/reference/mattcopock.js","args":{"request":"..."}}'
//
// Routes the DEFAULT_REQUEST below unless the invoke object passes `args`
// with a `request` field — edit DEFAULT_REQUEST directly to route something
// else meanwhile.

export const meta = {
  name: "mattcopock",
  description: "Classify a request into a flow (diagnose / build / review), then run that flow with its full instructions inlined",
  phases: [{ title: "Route" }, { title: "Execute" }],
};

// Condensed from ask-matt's routing map — see skills/herdr-workflow-authoring/reference/patterns.md for the routing-agent pattern in general.
const ROUTE_MAP = `
- diagnose: something is broken, throwing, failing, or slow — or the request literally says "diagnose" / "debug this".
- build: the request asks to implement a feature or fix, especially test-first / red-green-refactor.
- review: the request asks to review a branch, PR, or diff against a fixed point (a commit, tag, or "main").
`.trim();

// --- Embedded skills (frontmatter stripped) ------------------------------
// Each constant below is one flow's skill, copied in full. This is the part
// the router prompt says not to skip: an agent told to "diagnose the bug"
// with no further guidance will improvise; an agent handed this text will
// run the actual discipline.

const DIAGNOSING_BUGS_SKILL = `# Diagnosing Bugs

A discipline for hard bugs. Skip phases only when explicitly justified.

When exploring the codebase, read \`CONTEXT.md\` (if it exists) to get a clear mental model of the relevant modules, and check ADRs in the area you're touching.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on _this_ bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one — try them in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can \`git bisect run\` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive _them_ with \`scripts/hitl-loop.template.sh\` so the loop is still structured. Captured output feeds back to you.

Build the right feedback loop, and the bug is 90% fixed.

### Tighten the loop

Treat the loop as a product. Once you have _a_ loop, **tighten** it:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is tight — a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesise without a loop.

### Completion criterion — a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** — a script path, a test invocation, a curl — that you have **already run at least once** (paste the invocation and its output), and that is:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to _catch this specific bug_.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended; a human in the loop only via \`scripts/hitl-loop.template.sh\`.

If you catch yourself reading code to build a theory before this command exists, **stop — jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

## Phase 2 — Reproduce + minimise

Run the loop. Watch it go red — the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut — keep only what's load-bearing for the failure.

Why bother: a minimal repro shrinks the hypothesis space in Phase 3 (fewer moving parts left to suspect) and becomes the clean regression test in Phase 5.

Done when **every remaining element is load-bearing** — removing any one of them makes the loop go green.

Do not proceed until you have reproduced **and** minimised.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it — proceed with your ranking if the user is AFK.

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. \`[DEBUG-a4f2]\`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, \`performance.now()\`, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6 — Cleanup + post-mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All \`[DEBUG-...]\` instrumentation removed (\`grep\` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message — so the next debugger learns

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling) hand off to the \`/improve-codebase-architecture\` skill with the specifics. Make the recommendation **after** the fix is in, not before — you have more information now than when you started.`;

const TDD_SKILL = `# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, read \`CONTEXT.md\` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. You can't test everything — agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?"

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (\`expect(add(a, b)).toBe(a + b)\`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the \`code-review\` skill), not the red → green implementation cycle.`;

const CODE_REVIEW_SKILL = `Two-axis review of the diff between \`HEAD\` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you — run \`/setup-matt-pocock-skills\` if \`docs/agents/issue-tracker.md\` is missing.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, \`main\`, \`HEAD~5\`, etc. If they didn't specify one, ask for it.

Capture the diff command once: \`git diff <fixed-point>...HEAD\` (three-dot, so the comparison is against the merge-base). Also note the list of commits via \`git log <fixed-point>..HEAD --oneline\`.

Before going further, confirm the fixed point resolves (\`git rev-parse <fixed-point>\`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (\`#123\`, \`Closes #45\`, GitLab \`!67\`, etc.) — fetch via the workflow in \`docs/agents/issue-tracker.md\`.
2. A path the user passed as an argument.
3. A PRD/spec file under \`docs/\`, \`specs/\`, or \`.scratch/\` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as \`CODING_STANDARDS.md\` or \`CONTRIBUTING.md\`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same \`switch\`/\`if\`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long \`a.b().c().d()\` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Send a single message with two \`Agent\` tool calls. Use the \`general-purpose\` subagent for both.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under \`## Standards\` and \`## Spec\` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.`;

// --- Route -----------------------------------------------------------------

const DEFAULT_REQUEST = "review the current branch against HEAD~1";
const request = (args && args.request) || DEFAULT_REQUEST;

phase("Route");

const routeSchema = {
  type: "object",
  properties: {
    route: { type: "string", enum: ["diagnose", "build", "review"] },
    reason: { type: "string" },
  },
  required: ["route", "reason"],
};

const routed = await agent(
  `Classify the request below into exactly one flow, using this map:\n\n${ROUTE_MAP}\n\nRequest:\n${request}`,
  { label: "route", schema: routeSchema },
);

if (!routed) return { error: "routing failed" };

log(`routed to "${routed.route}": ${routed.reason}`);

phase("Execute");

if (routed.route === "diagnose") {
  const result = await agent(
    `${DIAGNOSING_BUGS_SKILL}\n\n---\n\nApply the discipline above to this bug. Work through the phases; do not skip to a fix without Phase 1's feedback loop.\n\nBug:\n${request}`,
    { label: "diagnose" },
  );
  return { route: routed.route, result };
}

if (routed.route === "build") {
  const result = await agent(
    `${TDD_SKILL}\n\n---\n\nApply the discipline above to build this, test-first. Confirm the seams before writing any test.\n\nRequest:\n${request}`,
    { label: "build" },
  );
  return { route: routed.route, result };
}

// route === "review" — code-review's own process is "spawn two sub-agents in
// parallel, then aggregate their reports." parallel() is the direct herdr
// equivalent of that "single message with two Agent tool calls" step: each
// thunk gets the same skill text, but a different one-line brief pulled from
// the skill's own step 4, so the two reviews stay genuinely independent.
const findingsSchema = {
  type: "object",
  properties: { findings: { type: "string" } },
  required: ["findings"],
};

const [standards, spec] = await parallel([
  () =>
    agent(
      `${CODE_REVIEW_SKILL}\n\n---\n\nYou are the Standards sub-agent from step 4 above. Report only standards violations and baseline-smell judgement calls, per that step's brief. Under 400 words.\n\nRequest:\n${request}`,
      { label: "review:standards", schema: findingsSchema },
    ),
  () =>
    agent(
      `${CODE_REVIEW_SKILL}\n\n---\n\nYou are the Spec sub-agent from step 4 above. Report only spec conformance, per that step's brief. Under 400 words.\n\nRequest:\n${request}`,
      { label: "review:spec", schema: findingsSchema },
    ),
]);

log(`standards: ${standards ? "reported" : "failed"}, spec: ${spec ? "reported" : "failed"}`);

return { route: routed.route, reviews: { standards, spec } };
