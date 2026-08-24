# Design decisions

Claude Code's dynamic-workflow engine, on Herdr: `agent()` runs a real coding-agent CLI
in a Herdr pane instead of a headless API subagent. Everything here is implemented and
live-verified unless listed under limitations. The long-form research behind these
bullets lives in [`docs/`](./docs/). Code comments citing `SPEC D<n>` use the
decision labels preserved below.

## Decision reference map

### D1: The script interface is Claude Code's verbatim plus two options

The runtime keeps Claude's workflow dialect and adds only `kind` and `ssh`.

### D4: Launch options resolve before the agent starts

The runner turns `kind`, `model`, and `effort` into concrete CLI flags before
launch. The resolved flags are part of call identity.

### D5: Pipeline stages do not add a barrier

An item can enter the next pipeline stage while other items remain in the
previous stage. Recoverable failures become `null`.

### D6: Resume is longest-unchanged-prefix replay keyed on placement too

Resume identity includes the selected CLI, SSH destination, and resolved
launch flags.

### D7: Determinism is enforced and the sandbox is not a security boundary

The VM rejects nondeterministic time and randomness APIs to protect journal
replay. It does not isolate untrusted code.

### D8: Budget counts agents and wall-clock, not tokens

Herdr exposes agent lifecycle and elapsed time, not provider token accounting.

### D11: Each run has one workspace per destination

Every agent call gets its own tab inside the run workspace for that local or
SSH destination.

### D12: The runner owns transport details

The workflow engine talks through a transport interface. Local socket and SSH
CLI mechanics stay behind that interface.

### D13: Local machines use the socket, remote machines use plain Herdr over SSH

Omitting `ssh` uses the local session socket. Supplying it runs the Herdr CLI
through that SSH destination.

### D14: Agent kinds are normalized before launch

Aliases resolve to Herdr's canonical kind, and kinds without a usable idle
rule are rejected.

### D15: Blocked calls fail or escalate

The default closes the worker and fails. Escalation keeps the pane open and
returns a human attach command.

### D16: Workers stay visible and attachable

Workspaces, tabs, and panes remain ordinary Herdr objects throughout a run.

### D18: The authoring skill is a tested artifact

The bundled skill and every included example are parsed by the test suite.

## Interface

- The script dialect is **exactly Claude Code's Workflow dialect** — same options, same
  globals, same semantics — plus pi's quality helpers (`verify`, `judgePanel`,
  `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `checkpoint`, `tier`,
  `timeoutMs`, `retries`). A Claude Code workflow script runs here unmodified.
- Exactly **two additions**: `kind` (which agent CLI) and `ssh` (which computer).
  Nothing else, ever — every deviation is a place where a generated script breaks.
- An option the runtime cannot resolve is a **validation error, never a silent drop**
  (both parents silently ignore unknown options; a plausible result from a silently
  weaker configuration is the worst failure mode available).
- Almost nothing is required. The smallest workflow is `meta` (name + description) and
  one `agent()` call. Defaults: kind `claude`, and omitting `ssh` runs the call on the
  engine's own computer.
- The CLI is the host stand-in for Claude Code's Workflow tool: one JSON object
  (`script` / `scriptPath` / `name` / `args` / `resumeFromRunId`) plus `kind` /
  `session` / `cwd`. `additionalProperties: false`. `name` is rejected until we have a
  saved-workflow registry. `ssh` stays on `agent()`.

## Engine

- Vendored from [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)
  (MIT) behind its `WorkflowAgentRunner` seam; the Pi SDK is fully removed.
- Semantics preserved exactly: `parallel` is a barrier and a failed agent resolves to
  `null` (never rejects); `pipeline` has no inter-stage barrier; retries collapse
  recoverable failures to `null` and throw non-recoverable ones loudly.
- **Resume** replays the longest unchanged prefix from the journal. Call identity hashes
  prompt / model / tier / phase / agentType / schema **plus `kind`, `ssh`, and the
  resolved launch flags** — repointing a call at another host, or changing its
  `model`/`effort`, invalidates exactly the right cached results.
- Determinism is enforced (`Date.now()`, `Math.random()`, no-arg `new Date()` throw in
  the vm realm). The realm exists to protect the journal, **not as a security boundary**.
- `budget` keeps Claude Code's shape but counts **agent calls + wall-clock** — Herdr
  sees panes, not tokens, so token/cost accounting is impossible by construction.

## Runner (the only Herdr-aware part)

- Local transport: newline-delimited JSON over the session's unix socket. Socket paths
  are always computed, **never read from `HERDR_SOCKET_PATH`** (inside a pane it points
  at the user's own session).
- Topology per run: one workspace labeled `<meta.name> · <last4-of-runId>`;
  one tab per agent call (the tab mints the pane and carries cwd/env/label).
  `agent.start --kind`, then `agent.prompt` waiting on `["idle","done","blocked"]`
  (headless settles as `done`, never `idle`). Teardown closes each tab after the
  call and the workspace on runner.close().
- Results come from an **output-file contract** (`$HERDR_FLOW_OUT`), never screen
  scraping: Herdr's status is the clock, the file is the proof. Schemas are validated
  with ajv; non-compliance is a loud non-recoverable error, never a silent `null`. A
  missing file triggers a state re-check before the tagged degraded fallback
  (`agent.read` visible).
- Launch flags are hardcoded in the start path, not configurable: claude gets
  `--dangerously-skip-permissions`, codex `--sandbox workspace-write --ask-for-approval
  never`. A call's `model` / `effort` are passed through verbatim as `--model` /
  `--effort` — the CLI, not this engine, decides whether a name is real.
- `blocked` policy: `fail` (default) or `escalate` (pane kept open, human attach command
  printed). `answer` is rejected as unsupported.
- `kind: "cline"` is rejected up front, in any spelling Herdr would normalize to cline:
  its detection manifest has no idle rule, so a wait on it can never resolve.
- Worktree isolation (`isolation: "worktree"`) is cheap here — every call already has
  its own pane — and is the right default whenever parallel agents write files.

## Other computers

- Zero-config and zero inventory: `ssh: "example-host"` is a name that already
  works with `ssh` in the terminal. There is no config file to declare hosts,
  and no tag selectors. Omitting `ssh` runs the call on the engine's own computer.
- A blank `ssh` is a validation error, never a silent fall back to local.
- ssh hosts run the plain `herdr` CLI over ssh; the binary is found with a login-shell
  probe (`bash -lc 'command -v herdr'`), because plain `ssh host 'cmd'` has no PATH.
  ControlMaster reuses the connection; the worker session's server is autostarted.
- One transport and one run workspace per destination. Results are written on the
  worker's own host and read back over ssh; ssh tabs open in the remote HOME.
- Worktree isolation cannot travel: combining a call-site `cwd` with `ssh` is a
  validation error, because the path only exists on the engine's computer.

## UX

- **Zero-config visibility**: with no `session` field, the run lands in the user's own
  session — workspace live in their sidebar, named after the workflow — falling back to
  a hidden autostarted `flow` worker session when no herdr is reachable.
  `session` forces a named worker session; the name `default` is reserved.
- Workers on an ssh host always live in a named worker session there — never another
  host's personal session.
- **No UI of our own**: every worker is a real pane; watch, attach, or type into any of
  them mid-run. Ships as a Herdr plugin (`herdr plugin link .` locally, or a GitHub
  repo tagged `herdr-plugin`).
- The result envelope reports `agentCount`, `durationMs`, and the workspace label.
  No token numbers, because none exist.

## Known limitations

- Named workflows (`invoke.name`) are not implemented. Pass `script` or `scriptPath`.
- Journal replay returns cached **outputs**; filesystem effects do not replay. A
  resumed run's answers and its disk state can disagree (same hole as pi; durable
  worktrees keyed to the run id are the likely fix).
- Worktree isolation over ssh is unsupported (explicit validation error).
- Reliability varies by kind: six runtimes report lifecycle through real hooks; the
  rest are screen-detected, and thin manifests (e.g. gemini) can settle early — the
  output-file contract is the safety net.
- Output-contract compliance is model behavior, not enforced; expect a small fallback
  rate that varies by model.
- No concurrency cap per destination: nothing stops a wide fan-out from opening many
  panes on one ssh host.
- macOS/Linux only.

## Open items

- Durable worktrees keyed to runId (make replay and disk state agree).
- Repo provisioning on ssh hosts (today: the host must already have the checkout).
- Sidebar progress labels via `pane.report_metadata` / `agent.view.set` (nice-to-have).
- Publish: GitHub repo + `herdr-plugin` tag.
