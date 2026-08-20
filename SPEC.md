# Design decisions

Claude Code's dynamic-workflow engine, on Herdr: `agent()` runs a real coding-agent CLI
in a Herdr pane instead of a headless API subagent. Everything here is implemented and
live-verified unless listed under limitations. The long-form research behind these
bullets lives in [`reference/`](./reference/); the git history has the original
numbered spec (code comments citing `SPEC D<n>` refer to it — each D-number maps to a
bullet above).

## Interface

- The script dialect is **exactly Claude Code's Workflow dialect** — same options, same
  globals, same semantics — plus pi's quality helpers (`verify`, `judgePanel`,
  `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `checkpoint`, `tier`,
  `timeoutMs`, `retries`). A Claude Code workflow script runs here unmodified.
- Exactly **two additions**: `kind` (which agent CLI) and `machine` (which computer).
  Nothing else, ever — every deviation is a place where a generated script breaks.
- An option the runtime cannot resolve is a **validation error, never a silent drop**
  (both parents silently ignore unknown options; a plausible result from a silently
  weaker configuration is the worst failure mode available).
- Almost nothing is required. The smallest workflow is `meta` (name + description) and
  one `agent()` call; defaults come from `fleet.toml` `[defaults]`.

## Engine

- Vendored from [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)
  (MIT) behind its `WorkflowAgentRunner` seam; the Pi SDK is fully removed.
- Semantics preserved exactly: `parallel` is a barrier and a failed agent resolves to
  `null` (never rejects); `pipeline` has no inter-stage barrier; retries collapse
  recoverable failures to `null` and throw non-recoverable ones loudly.
- **Resume** replays the longest unchanged prefix from the journal. Call identity hashes
  prompt / model / tier / phase / agentType / schema **plus `kind`, `machine`, and the
  resolved runtime flags** — repointing a call or editing the fleet config invalidates
  exactly the right cached results.
- Determinism is enforced (`Date.now()`, `Math.random()`, no-arg `new Date()` throw in
  the vm realm). The realm exists to protect the journal, **not as a security boundary**.
- `budget` keeps Claude Code's shape but counts **agent calls + wall-clock** — Herdr
  sees panes, not tokens, so token/cost accounting is impossible by construction.

## Runner (the only Herdr-aware part)

- Local transport: newline-delimited JSON over the session's unix socket. Socket paths
  are always computed, **never read from `HERDR_SOCKET_PATH`** (inside a pane it points
  at the user's own session).
- Topology per run: one workspace labeled `<meta.name> · <last4-of-runId>`; one tab per
  agent call (the tab mints the pane and carries cwd/env/label). `agent.start --kind`,
  then `agent.prompt` waiting on `["idle","done","blocked"]` (headless settles as
  `done`, never `idle`).
- Results come from an **output-file contract** (`$HERDR_FLOW_OUT`), never screen
  scraping: Herdr's status is the clock, the file is the proof. Schemas are validated
  with ajv; non-compliance is a loud non-recoverable error, never a silent `null`. A
  missing file triggers a state re-check before the tagged degraded fallback
  (`agent.read` visible).
- `blocked` policy (`fleet.toml`): `fail` (default) or `escalate` (pane kept open, slot
  held, human attach command printed). `answer` is rejected as unsupported.
- `kind: "cline"` is rejected up front, in any spelling Herdr would normalize to cline:
  its detection manifest has no idle rule, so a wait on it can never resolve.
- Worktree isolation (`isolation: "worktree"`) is cheap here — every call already has
  its own pane — and is the right default whenever parallel agents write files.

## Fleet

- `fleet.toml`: `[defaults]` (kind/model/effort/on_blocked), `[runtime.<kind>]`
  (permission / `model.*` / `effort.*` → CLI args + env — we never hardcode any
  vendor's flags; a vendor rename is a one-line config edit), `[[machine]]`
  (name/transport/herdr_bin/slots/tags/kinds/repos). No config file = one implicit
  local machine, zero setup.
- Remote machines run the plain `herdr` CLI over ssh at an **absolute `herdr_bin`**
  (non-login shells have no PATH). This is Herdr's own remote-control pattern —
  `herdr --remote` is a TUI byte-pipe and no remote API bridge exists. The worker
  session's server is autostarted; ssh connections are reused (ControlMaster).
- Placement: explicit machine name or `{tag}`, else the least-occupied machine that has
  the call's `kind`. Per-machine `slots` are enforced atomically. Naming an
  unconfigured machine is an error, never a silent fallback to local.
- Remote results are read back over ssh; machine identity in the resume hash is the
  stable machine **name**.

## UX

- **Zero-config visibility**: with no `--session`, the run lands in the user's own
  session — workspace live in their sidebar, named after the workflow — falling back to
  a hidden autostarted `flow` worker session when no herdr is reachable.
  `--session <name>` forces a named worker session; the name `default` is reserved.
- Workers on remote machines always live in a named worker session there — never
  another machine's personal session.
- **No UI of our own**: every worker is a real pane; watch, attach, or type into any of
  them mid-run. Ships as a Herdr plugin (`herdr plugin link .` locally, or a GitHub
  repo tagged `herdr-plugin`).
- The result envelope reports `agentCount` and `durationMs` — no token numbers, because
  none exist.

## Known limitations

- Resuming a fleet run requires re-passing the same `--fleet` (the path is not
  persisted in the journal).
- Journal replay returns cached **outputs**; filesystem effects do not replay. A
  resumed run's answers and its disk state can disagree (same hole as pi; durable
  worktrees keyed to the run id are the likely fix).
- Remote worktree isolation is unsupported (explicit validation error).
- Reliability varies by kind: six runtimes report lifecycle through real hooks; the
  rest are screen-detected, and thin manifests (e.g. gemini) can settle early — the
  output-file contract is the safety net.
- Output-contract compliance is model behavior, not enforced; expect a small fallback
  rate that varies by model.
- Per-process slot accounting: two engines driving the same machine don't see each
  other's occupancy.
- macOS/Linux only.

## Open items

- Durable worktrees keyed to runId (make replay and disk state agree).
- Repo provisioning for remote machines (today: the machine must already have it).
- Sidebar progress labels via `pane.report_metadata` / `agent.view.set` (nice-to-have).
- Publish: GitHub repo + `herdr-plugin` tag.
