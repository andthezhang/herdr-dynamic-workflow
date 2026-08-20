# fleet.toml — fleet and runtime configuration

Environmental options live in config, not the script (SPEC D4): the script says
*what* it wants (`model: "opus"`, `effort: "high"`, `kind: "codex"`,
`machine: "build-mac"`); `fleet.toml` says what that means for each agent CLI
and which machines exist. We never keep a table of any CLI's flags ourselves
(D14) — a vendor flag rename is a one-line edit to this file, not a release.

## Where it is loaded from

In order:

1. `--fleet <path>` in the arguments forwarded to the plugin action
   (`herdr plugin action invoke herdrflow.engine.run -- <workflow.js> --cwd "$PWD" --fleet "$PWD/fleet.toml"`,
   or the equivalent `resume` action). A missing file here is an **error**, never
   a silent fallback.
2. `$HERDR_PLUGIN_CONFIG_DIR/fleet.toml` when the file exists — Herdr injects
   that variable for installed plugins
   (`~/.config/herdr/plugins/config/herdrflow.engine/`, SPEC D17).
3. Standalone/internal entry-point execution (no injected variable): the same
   conventional plugin config dir, computed the way herdr computes it
   (`$XDG_CONFIG_HOME`-aware; `herdr plugin config-dir
   herdrflow.engine` prints it) — so a terminal run and a Herdr-invoked action
   load the same fleet.
4. **No config at all**: the implicit default — a single local machine named
   `local`, default kind `claude`, no runtime tables, `on_blocked = "fail"`.
   Multi-machine is in the model from day one but opt-in for the user (D12).

The file is validated strictly: unknown keys anywhere are errors, not silent
drops — the same rule the script contract applies to `agent()` options (D1).

## Complete annotated example

```toml
# ── [defaults]: what an agent() call inherits when it names nothing ─────────

[defaults]
kind = "claude"          # agent CLI when a call sets no `kind`
model = "sonnet"         # IMPLICIT model: resolved per kind below; a kind with
                         # no matching entry inherits silently (the CLI just
                         # runs its own default)
effort = "medium"        # IMPLICIT effort, same rule
on_blocked = "escalate"  # "fail" (default) | "escalate"
                         # "answer" is rejected at load time — not yet
                         # supported (SPEC Q8: nothing may auto-answer a
                         # permission prompt before that is designed)

# ── [runtime.<kind>]: what model/effort names MEAN for each CLI ─────────────
# Two delivery mechanisms, both real (SPEC D4):
#   * an array        => launch args, appended to `agent.start` after the kind's
#                        canonical executable
#   * { env = {...} } => environment set on the call's tab; the pane's shell —
#                        and therefore the agent — inherits it
#                        ({ args = [...], env = {...} } combines both)

[runtime.claude]
permission   = ["--dangerously-skip-permissions"]  # ALWAYS appended for this kind
model.opus   = ["--model", "opus"]
model.sonnet = ["--model", "sonnet"]
effort.high   = { env = { MAX_THINKING_TOKENS = "32000" } }
effort.medium = { env = { MAX_THINKING_TOKENS = "8000" } }

[runtime.codex]
# codex 0.147.0 removed the old `--full-auto` alias; this is its documented
# equivalent (verified against `codex --help`). Exactly the kind of vendor
# flag churn this file exists to absorb (D14).
permission = ["--sandbox", "workspace-write", "--ask-for-approval", "never"]
model.opus = ["--model", "gpt-5.4"]   # the same script-level name, this CLI's spelling

# ── [[machine]]: the fleet (SPEC D12/D13) ───────────────────────────────────
# Omit every [[machine]] block to get the implicit single local machine.
# The moment you declare any, the declared list is authoritative — so declare
# `local` too if local placement should stay available.

[[machine]]
name = "local"           # transport defaults to "local"
slots = 6                # declared concurrency capacity (capacity is declared,
                         # not measured — Herdr exposes no CPU/memory metric)

[[machine]]
name = "build-mac"
transport = "build-mac"  # "local" | "ssh://user@host" | a plain ssh alias
                         # (this one is an alias from ~/.ssh/config; BatchMode
                         # ssh works against it)
herdr_bin = "/opt/homebrew/bin/herdr"
                         # REQUIRED for remote machines, always an ABSOLUTE
                         # path: `ssh host 'cmd'` runs a non-login shell with
                         # no usable PATH, so herdr is never resolved via PATH
                         # (SPEC D13). herdr 0.8.0 lives here on this machine.
slots = 4
tags = ["mac", "arm64"]
kinds = ["claude", "codex"]
                         # agent CLIs installed there (at /Users/alex/.local/bin,
                         # which IS on PATH inside pane shells even though it is
                         # not in a plain `ssh build-mac '...'` command's PATH).
                         # Omit to declare no restriction.
repos = ["/Users/alex/Documents/Github/herdr-dynamic-workflow"]
                         # checkouts this machine can work (placement filters on
                         # it — a machine can only work repos it has, D12)
```

## Resolution rules (SPEC D4/D1)

For each `agent()` call, the runner resolves `model`/`tier`/`effort` through
`[runtime.<kind>]` **before any socket call**:

- An **explicit** value (written in the script, including a `meta.phases[].model`
  route; `tier` resolves through the same `model.<name>` table, and an explicit
  `model` beats `tier`) with no matching entry is a
  **`SCRIPT_VALIDATION_ERROR`** — an option we can't resolve is a validation
  error, never a silent drop. A plausible result from a silently weaker
  configuration is the worst failure mode available.
- An **implicit** value (from `[defaults]`) with no matching entry **inherits
  silently**: the CLI runs its own default.
- The kind's `permission` args are **always appended** (after any model/effort
  args).

The **resolved** args/env — not just the requested names — are part of every
call's resume hash (D4/D6): editing `[runtime.claude].model.opus` correctly
invalidates the cached calls that used it, while runs that never touched fleet
config hash exactly as before.

## Placement and remote machines (SPEC D12/D13)

Every agent call is **placed** on exactly one fleet machine before any Herdr
traffic:

- **`machine:` omitted** — the machine of **least current occupancy** among
  machines that declare the call's kind (an omitted `kinds` declares no
  restriction). Ties break in declaration order, so the implicit
  single-machine fleet always places `local`.
- **`machine: "name"`** (or `{name: "..."}`) — exactly that machine. Naming an
  unconfigured machine is a script-validation error, never a silent fallback
  to local (D12). The machine must declare the call's kind.
- **`machine: {tag: "mac"}`** — least occupied among machines carrying the
  tag (that also declare the kind). An unconfigured tag is a validation error.

**Slots** are enforced per machine: occupancy is counted live in the runner
(check-and-increment is atomic — a `parallel()` fan-out can never overshoot a
machine's declared capacity) and a call beyond capacity waits for a slot. The
slot is released when the call ends — except a `blocked` call under
`on_blocked = "escalate"`, which keeps holding it: the worker still occupies
its pane (D15). Known limitation: the count lives in the engine **process** —
declared slots are a per-run concurrency budget, not a cross-run admission
controller, so two concurrent runs against one worker session (or a resume
while a previous execution's escalated panes are still open) each start from
zero and can together exceed a machine's declared capacity.

**Repos** filter placement (D12: a machine can only work repos it has): a
remote machine that declares `repos` is a placement candidate only when one of
them basename-matches the workflow's own cwd — the same match that picks the
remote tab's directory. Naming such a machine explicitly when no repo matches
is a `SCRIPT_VALIDATION_ERROR`, never a silent placement into an unrelated
checkout. An omitted/empty `repos` declares no restriction (mirroring
`kinds`), and local machines always qualify — the workflow's cwd is by
definition on the engine's host.

**Remote machines** are driven with the plain `herdr` CLI over ssh at the
machine's declared absolute `herdr_bin` (D13) — one `-o ControlMaster=auto`
connection reused across the call's many small commands. On first use the
runner probes the worker session (`workspace list`) and, on
`server_not_running`, starts one headless
(`nohup <herdr_bin> --session <name> server &`) and re-probes with backoff.
The output-file contract moves with the pane:

- `HERDR_FLOW_OUT` / `HERDR_FLOW_SCHEMA` for a remote call are **remote**
  paths under `/tmp/herdr-flow/<runId>/` (the runner's `remoteStateDir`),
  written and harvested over the same ssh connection (`cat`, `mkdir -p`).
- A remote tab's cwd is the machine's declared repo — basename-matched
  against the workflow's own cwd, else the first `repos` entry — else the
  remote `$HOME`. The engine's local cwd is never sent across: it names a
  path on the wrong filesystem.
- **Worktree isolation is not supported on remote machines in this
  milestone**: a call requesting isolation whose placement leaves no local
  candidate is an explicit `SCRIPT_VALIDATION_ERROR`, never a silent degrade.
  (Implicit placement with isolation simply narrows to local machines.)
- An escalated blocked worker on a remote machine gets a runnable attach
  command in its failure and escalation record:
  `ssh -t <target> '<herdr_bin> --session <session> agent attach <agent>'`.

The engine's resume hash carries the call's `machine` **option** — the stable
machine name (or tag selector) the script asked for. Repointing a call at a
different machine invalidates its cached result (D6); an implicit placement
hashes exactly as it did before multi-machine landed, so old journals keep
replaying.

## `on_blocked` (SPEC D15)

A call can end with the worker stopped on an approval/question prompt Herdr
reports as `blocked`. The policy is configured here, never per call:

- **`fail`** (default): the call fails (recoverable — the engine may retry or
  collapse it to `null`) and its tab is torn down with it. The error's
  `details.paneClosed` is `true`.
- **`escalate`**: the pane is left **open** with the blocked worker in it:
  - the call still fails recoverable, with the exact attach command in the
    message: `herdr --session <session> agent attach <agent-name>`;
  - an escalation record is emitted through the run's history channel;
  - a pointer is persisted at `<state>/<runId>/escalation-<callIndex>.json`
    (agent name, pane/tab ids, attach command) so the pane stays findable
    after the process exits;
  - `details.paneClosed` is `false`, and the runner's shutdown leaves the run's
    workspace alive — a blocked worker holds its pane, worktree, and slot for
    as long as it waits (D15); freeing capacity is exactly what escalate does
    **not** do.
- **`answer`**: rejected at config-load time as not yet supported (Q8).
