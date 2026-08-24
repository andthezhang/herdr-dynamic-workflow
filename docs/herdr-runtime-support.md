# Herdr runtime support

How a Herdr plugin can provide the same dynamic-workflow capability as
pi-dynamic-workflows, while working across many coding-agent runtimes instead of one
vendor SDK.

Verified against herdr `0.8.0` (protocol 19), `docs/next/` as of `06ca0baa`. Every
claim below is either a source citation or a fact marked **measured** in
`.briefing.md`. Where the runtime-agnosticism claim is weaker than the pitch, that is
called out inline rather than in a footnote.

---

## 1. The substitution

### What `agent()` is in pi

`pi-dynamic-workflows` exposes one capability that matters
(`workflow-capability-contract.ts:304`):

```
agent(prompt, options?) => Promise<string | structured value | null>
```

Underneath, `runWorkflow` resolves `options.agent ?? new WorkflowAgent(options)` against
a one-method interface (`src/workflow.ts:153`):

```ts
export interface WorkflowAgentRunner {
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}
```

`WorkflowAgent.run()` spawns an in-process Pi SDK subagent: same process, same auth,
structured output via a synthesized tool, usage read back off the session object
(`src/agent.ts:400-430`).

### What `agent()` becomes in herdr-dynamic-workflow

`HerdrAgentRunner.run()` is a five-phase sequence of socket calls against a Herdr
server. Nothing in it is Pi-specific, and nothing in it is agent-specific except the
`kind` string.

| Phase | Herdr call(s) | Failure surface |
| --- | --- | --- |
| 0. Placement | `pane.list` / `session.snapshot` | no machine satisfies the constraint set (§7) |
| 1. Topology | `pane.split` (or `worktree.create` + `layout.apply`) | — |
| 2. Launch | `agent.start` | `agent_pane_busy`, `unsupported_agent_kind`, `agent_not_ready`, `agent_name_taken` |
| 3. Turn | `agent.prompt` with `wait` | `agent_prompt_stalled`, `timeout`, `agent_not_running` |
| 4. Harvest | read `$HERDR_FLOW_OUT`; degraded fallback `agent.read` | `agent_not_idle` on alt-screen fallback (§6) |
| 5. Teardown | `pane.close` (or recycle the pane) | — |

Herdr does not create topology for you. `agent.start` "activates an existing available
shell pane" and "never creates, splits, or moves layout"
(`docs/next/website/src/content/docs/agent-automation.mdx:16`). The pane must be at its
interactive shell prompt with the shell itself owning the foreground —
`available_pane_shell_from_job` (`src/platform/mod.rs:223-234`) rejects the pane unless
the foreground process group is exactly the pane shell PID and its name is a known shell.
Otherwise `start_agent` returns `agent_pane_busy` (`src/app/agents.rs:183-191`,
`src/app/agents.rs:253-256`).

#### Phase 1 — topology

```json
{"id":"flow_1","method":"pane.split","params":{
  "target_pane_id":"w1:p1",
  "direction":"right",
  "ratio":0.5,
  "cwd":"/repo",
  "focus":false,
  "env":{
    "HERDR_FLOW_OUT":"/tmp/herdr-dynamic-workflow/run_9f2c/call_0007.json",
    "HERDR_FLOW_RUN":"run_9f2c",
    "HERDR_FLOW_CALL":"7"
  }
}}
```

`PaneSplitParams.env` is a real field (`src/api/schema/panes.rs:26-42`) and Herdr
"applies those key/value pairs to the newly launched process only"
(`socket-api.mdx:291`). This is how the output-file contract (§6) is delivered without
per-agent config: the env lands on the pane's shell, and the agent launched into that
shell inherits it. Herdr-owned variables (`HERDR_SOCKET_PATH`, `HERDR_ENV=1`,
`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) are authoritative on conflict —
do not try to override them.

Response carries the new pane at `.result.pane.pane_id`. Never predict IDs.

#### Phase 2 — launch

```json
{"id":"flow_2","method":"agent.start","params":{
  "name":"flow-run9f2c-7",
  "kind":"codex",
  "pane_id":"w1:p2",
  "args":["-m","gpt-5.4"],
  "timeout_ms":60000
}}
```

Shape from `AgentStartParams` (`src/api/schema/agents.rs:163-173`). Constraints from
`start_agent` (`src/app/agents.rs:143-225`):

- `name` must match `[a-z][a-z0-9_-]{0,31}` and be unique among *live* agents. herdr-dynamic-workflow's
  naming scheme must fit in 32 chars — `flow-<run>-<call>` with a short run id.
- `kind` goes through `parse_agent_label` (`src/detect/mod.rs:168`), so aliases work
  (`claude-code`, `cursor-agent`, `kilo code`, `qoder`, …) but the canonical set is 21.
- `args` reject any control character.
- `timeout_ms` must be `> 3000` and `<= 300000`; default 30 000
  (`src/app/agents.rs:8-9`).

Herdr then builds `argv = [interactive_agent_executable(kind), ...args]`, wraps it with
`platform::interactive_shell_command`, and **types it into the pane's shell**
(`src/app/agents.rs:193-217`). There is no exec: the launch is terminal input. A
successful return means Herdr has confirmed the expected agent owns the same terminal and
is ready for interactive input. If detection reports `blocked` during startup — a
first-launch trust prompt, for example — `agent start` returns `agent_not_ready`
immediately (`agent-automation.mdx:52`). herdr-dynamic-workflow must treat `agent_not_ready` as a
placement-level failure, not a retryable agent error.

#### Phase 3 — the turn

```json
{"id":"flow_3","method":"agent.prompt","params":{
  "target":"flow-run9f2c-7",
  "text":"<contract preamble>\n\nReview the diff in HEAD~1..HEAD for auth regressions.",
  "wait":{"until":["idle","done","blocked"],"timeout_ms":900000}
}}
```

Shape from `AgentPromptParams` / `AgentPromptWaitOptions`
(`src/api/schema/agents.rs:175-181`, `:34-40`). Submitting the prompt and arming the wait
in one request is not a convenience — it closes the race where a fast agent transitions
`working → idle` between a separate `agent.prompt` and `agent.wait`
(`socket-api.mdx:114`).

`agent.wait` is server-owned, event-driven, and "pins the resolved pane occupant so a
replacement cannot satisfy the wait" (`socket-api.mdx:114`). If the pane's agent dies and
is replaced, the in-flight wait ends with `agent_not_running` rather than being satisfied
by the wrong process (`agent-automation.mdx:32`).

#### Phase 4 — harvest

Read `HERDR_FLOW_OUT` from wherever the plugin can reach that path (local FS, or
`git`/`ssh` for a remote machine — §7). Only on non-compliance does herdr-dynamic-workflow fall back to
`agent.read`, tagged with a `fallbackReason` (§6).

#### Phase 5 — teardown

`pane.close` on the pane, or return it to a warm pool. Because `agent.start` requires an
idle shell, recycling a pane means the agent must actually exit first — otherwise the next
`agent.start` on that pane returns `agent_pane_busy`.

### What is lost and gained versus pi

| pi in-process subagent | herdr-dynamic-workflow PTY agent |
| --- | --- |
| Structured output via a synthesized tool with `terminate: true` | Output-file contract in the prompt (§6); no tool-level enforcement |
| Real token usage read off the session | No token signal at all (§8); budget re-keyed to agent-count and wall-clock |
| Cancellation via `AbortController` | `agent.send-keys <target> esc` / `ctrl+c`, then `pane.close`; best-effort |
| Subagents never ask permission | `blocked` is real and detectable; configured `on_blocked` policy (D4) |
| One vendor's models | Whatever CLI the user already authenticated |
| ~seconds of setup per call | `agent.start` waits for real TUI readiness; budget 3–30 s per call |

---

## 2. Why Herdr makes this tractable

The hard part of driving heterogeneous agent CLIs is not launching them — it is knowing
when a turn is over. Herdr has already built that, and exposes it as one enum.

### Two state models

`PaneAgentState` is what integrations report (`src/api/schema/common.rs:142-147`):
`idle | working | blocked | unknown`.

`AgentStatus` is what the API returns (`src/api/schema/common.rs:151-157`): the same four
plus `done`. `done` is "the same underlying idle state after unseen background work
completes" — it collapses to `idle` once the tab is focused or targeted with `pane focus`
/ `agent focus`. Reading through the CLI does **not** mark it seen
(`agent-automation.mdx:79`).

For herdr-dynamic-workflow this matters concretely: a headless worker session has no focused UI, so
finished agents will report `done`, not `idle`, essentially forever. **Always wait on
`["idle","done","blocked"]`, never on `["idle"]` alone.** That is also the CLI default
(`cli-reference.mdx:312`).

### Two authority paths

Effective state resolution is a three-line precedence in
`recompute_effective_state` (`src/terminal/state.rs:2127-2135`):

```rust
let state = if self.visible_blocker_overrides_hook() {
    AgentState::Blocked
} else {
    self.hook_authority.as_ref()
        .filter(|authority| self.hook_authority_is_effective(authority))
        .map(|authority| authority.state)
        .unwrap_or(self.fallback_state)   // <- the screen manifest result
};
```

**Path A — lifecycle-hook authority.** When an installed integration has full lifecycle
coverage and is actively reporting for the running pane, its `pane.report_agent` calls
author `idle`/`working`/`blocked` and Herdr suppresses screen rules entirely
(`agents.mdx:42`). The set is a hardcoded pair-match in
`full_lifecycle_hook_authority()` (`src/detect/mod.rs:289-299`):

```rust
("herdr:pi", "pi") | ("herdr:omp", "omp") | ("herdr:mastracode", "mastracode")
| ("herdr:opencode", "opencode") | ("herdr:kilo", "kilo") | ("herdr:kimi", "kimi")
```

Six agents. `AgentInfo.screen_detection_skipped` (`src/app/agents.rs:381`) tells you when
this is live for a pane — herdr-dynamic-workflow should surface it in run diagnostics.

A near-neighbour is `session_identity_only_integration()` (`src/detect/mod.rs:301-306`):
`("herdr:hermes","hermes")` and `("herdr:antigravity_cli","agy")`. Those integrations
report a resumable session id but explicitly do **not** take state authority; both remain
in `SCREEN_MANIFEST_AGENTS`. The other session-only integrations (Claude, Codex, Copilot,
Devin, Droid, Qoder, Cursor, Grok) behave the same way in practice — the docs are explicit
that "their hooks do not cover the whole lifecycle. They can miss permission approval
results, escape interrupts, or other transitions" (`agents.mdx:48`).

**Path B — screen manifests.** 19 of the 21 kinds ship a TOML manifest
(`Agent::SCREEN_MANIFEST_AGENTS`, `src/detect/mod.rs:92`; files in
`src/detect/manifests/`). Rules are evaluated against a live bottom-buffer snapshot — not
the user-visible viewport, so scrolling never changes detection (`agents.mdx:46`).

Rule grammar (`src/detect/manifest.rs:153-197`): each rule has an `id`, `state`,
`priority`, a `region`, boolean evidence flags (`visible_idle`, `visible_blocker`,
`visible_working`, `skip_state_update`), and nested AND/OR/NOT gates over `contains`,
`regex`, `line_regex`. Regions (`src/detect/manifest.rs:1073-1094`) are
`whole_recent`, `after_last_prompt_marker`, `before_current_prompt_marker`,
`whole_recent_without_current_prompt_marker`, `current_prompt_block_marker`,
`after_current_prompt_block_marker`, `prompt_box_body`, `above_prompt_box`,
`last_non_empty_above_prompt_box`, `after_last_horizontal_rule`, `osc_title`,
`osc_progress`, `bottom_lines(N)`, `bottom_non_empty_lines(N)`, `top_lines(N)`.

`osc_title` / `osc_progress` match terminal-title and progress escape sequences instead of
drawn text — the closest Herdr comes to orca's OSC-9999 approach. Claude's manifest uses it
as its highest-priority working rule (`src/detect/manifests/claude.toml:7-13`, a
braille-spinner regex at priority 1100).

Manifests are hot-swappable at three levels: bundled in the binary, cached remote updates
from herdr.dev, and a local override at `~/.config/herdr/agent-detection/<agent>.toml`
which always wins (`agents.mdx:62-76`). **Adding a genuinely new agent still requires a
binary update** — remote manifests only patch rules for agents Herdr already identifies by
process name (`agents.mdx:74`).

### Why `blocked` is strict

Herdr marks `blocked` only when the snapshot matches known approval/question UI. If no rule
matches for a known agent, it falls back to `idle` with the reason
`default_known_agent_idle_fallback` (`src/detect/manifest.rs:14`, `agents.mdx:58`).

The rationale is safety: a false `blocked` would invite an orchestrator to send input into
an agent that is actually mid-turn. The cost is a false `idle` — an unrecognized permission
prompt looks finished. For herdr-dynamic-workflow this is the primary source of *silent* wrong answers:
`agent.prompt --wait` returns "done", the output file is absent, and the agent is actually
sitting on a y/n prompt. The mitigation is the output-file contract (§6) — absence of the
file is a strong signal that the turn did not really complete, and herdr-dynamic-workflow should
re-check state and read the screen before deciding.

---

## 3. The runtime matrix

Derived from `src/detect/mod.rs` (`Agent::ALL` at :68, `agent_label` at :115,
`interactive_agent_executable` at :141, `SCREEN_MANIFEST_AGENTS` at :92,
`full_lifecycle_hook_authority` at :289, `session_identity_only_integration` at :301),
`src/api/schema/integrations.rs:15-52` (`IntegrationTarget::ALL`, exactly 16), and
`src/detect/manifests/*.toml`. Manifest line counts are a crude but honest proxy for how
much screen shape Herdr has actually learned.

| `--kind` | Executable typed into the shell | Manifest (lines) | State authority | `integration install` target | Workflow reliability |
| --- | --- | --- | --- | --- | --- |
| `pi` | `pi` | pi.toml (13) | **hook (full)** | `pi` | **A** — hook-authoritative; the tiny manifest is irrelevant when installed |
| `omp` | `omp` | *none* | **hook (full)** | `omp` | **A** — no screen fallback exists at all |
| `mastracode` | `mastracode` | *none* | **hook (full)** | `mastracode` | **A** — hook or nothing (`integrations.mdx:282`) |
| `kimi` | `kimi` | kimi.toml (77) | **hook (full)** | `kimi` | **A** — needs Kimi ≥ 0.14.0 |
| `opencode` | `opencode` | opencode.toml (37) | **hook (full)** | `opencode` | **A** with plugin; **C** without (37-line manifest) |
| `kilo` | `kilo` | kilo.toml (24) | **hook (full)** | `kilo` | **A** with plugin; **D** without (24 lines, no idle rule) |
| `claude` | `claude` | claude.toml (161) | screen | `claude` (session only) | **B** — richest manifest, OSC-title working rule |
| `grok` | `grok` | grok.toml (164) | screen | `grok` (session only) | **B** |
| `hermes` | `hermes` | hermes.toml (102) | screen | `hermes` (session only, explicit) | **B** |
| `codex` | `codex` | codex.toml (89) | screen | `codex` (session only) | **B** |
| `devin` | `devin` | devin.toml (86) | screen | `devin` (session only) | **B** |
| `maki` | `maki` | maki.toml (68) | screen | *none* | **B** |
| `amp` | `amp` | amp.toml (65) | screen | *none* | **B** |
| `kiro` | `kiro-cli` | kiro.toml (63) | screen | *none* | **B** |
| `cursor` | `cursor-agent` (`.cmd` on Windows) | cursor.toml (57) | screen | `cursor` (session only) | **B** |
| `droid` | `droid` | droid.toml (48) | screen | `droid` (session only) | **B** |
| `qodercli` | `qodercli` | qodercli.toml (38) | screen | `qodercli` (session only) | **C** |
| `copilot` | `copilot` | github-copilot.toml (37) | screen | `copilot` (session only) | **C** |
| `agy` | `agy` | antigravity.toml (33) | screen | `antigravity-cli` (session only, explicit) | **C** |
| `gemini` | `gemini` | gemini.toml (25) | screen | *none* | **D** — docs: "less thoroughly tested" |
| `cline` | `cline` | cline.toml (26) | screen | *none* | **F** — see below |

Grades are herdr-dynamic-workflow's, not Herdr's: **A** = lifecycle events author state;
**B** = mature manifest with idle/working/blocked rules; **C** = thin manifest, expect
missed `blocked`; **D** = two-rule manifest, expect premature `idle`; **F** = unusable for
wait-based orchestration.

### The five kinds with no integration at all

`gemini`, `cline`, `kiro`, `amp`, `maki`. Screen manifests only, permanently. Nothing to
install to improve them.

### Where the docs are honest, and where this document has to be more honest

`agents.mdx:36` says: "Detected but less thoroughly tested: Gemini CLI and Cline." That
understates Cline.

**`cline` cannot reach idle.** `src/detect/manifests/cline.toml:20-26`:

```toml
[[rules]]
id = "default_cline_working"
state = "working"
priority = -10
region = "whole_recent"
visible_working = true
regex = ['(?s).+']
```

`(?s).+` matches any non-empty screen. A TUI always draws something. There is no idle rule
in the file, and Cline has no integration, so `hook_authority` is always `None` and
`fallback_state` is permanently `Working` (`src/terminal/state.rs:2127-2135`). A wait on
`["idle","done","blocked"]` never resolves except through a permission prompt.
**herdr-dynamic-workflow must refuse `kind: "cline"` at script-validation time with an explicit
message**, or treat it as a custom-source runtime (§4) where the user supplies their own
reporting.

**`gemini` will report idle too early.** `src/detect/manifests/gemini.toml` has exactly two
rules: `blocked` on approval chrome, and `working` on the literal `"esc to cancel"`. Any
screen without that literal falls to `default_known_agent_idle_fallback` → `idle`. Gemini
CLI screens that do not carry that exact string — tool-output pages, long streamed answers,
error states — read as finished. herdr-dynamic-workflow's output-file contract is the only thing
standing between that and a silently-empty workflow result.

**`kilo` without the plugin is the same shape as gemini**: kilo.toml has one blocked rule
and one working rule (`"esc interrupt"`), no idle rule. Grade **A** with the plugin, **D**
without. herdr-dynamic-workflow should call `integration.install` or check `herdr integration status`
during preflight and warn.

Because remote manifest updates land without a Herdr restart (`agents.mdx:64`), these grades
are a snapshot. herdr-dynamic-workflow should compute them at runtime from `server.agent_manifests`
rather than hardcoding this table.

---

## 4. The escape hatch for unsupported runtimes

The 21 kinds are compiled in. Anything else — a private agent, a shell harness, a Python
script, `aider`, `goose`, `openhands` — still participates through the same lifecycle
model, by self-reporting.

### The pattern

1. **Create the pane with `pane.split`**, injecting env.
2. **Launch as a plain process**, not via `agent.start`. There is no `pane.run` raw method;
   the CLI's `herdr pane run` is `pane.send_input` with `text` plus an `Enter` key
   (`src/cli/pane.rs:1047-1060`):

```json
{"id":"flow_r1","method":"pane.send_input","params":{
  "pane_id":"w1:p3",
  "text":"aider --model sonnet",
  "keys":["Enter"]
}}
```

3. **Self-report lifecycle** from the runtime's own hooks:

```json
{"id":"flow_r2","method":"pane.report_agent","params":{
  "pane_id":"w1:p3",
  "source":"custom:aider",
  "agent":"aider",
  "state":"working",
  "message":"editing src/auth.rs",
  "seq":1781043522000000000
}}
```

Shape from `PaneReportAgentParams` (`src/api/schema/panes.rs:367-380`). `state` is
`PaneAgentState`, so `idle|working|blocked|unknown` only — no `done`; Herdr derives `done`
itself.

4. **Release on exit**, so the pane stops being treated as an agent:

```json
{"id":"flow_r3","method":"pane.release_agent","params":{
  "pane_id":"w1:p3","source":"custom:aider","agent":"aider"
}}
```

### Reference implementation

The shipped state-reporting integrations are the reference. `src/integration/assets/kimi/herdr-agent-state.sh`
is the clearest one — 57 lines, `/bin/sh` plus inline `python3`, and it encodes every rule
worth copying:

```sh
action="${1:-}"
case "$action" in
  session|working|blocked|idle) ;;      # closed action set; anything else is a no-op
  *) exit 0 ;;
esac

[ "${HERDR_ENV:-}" = "1" ] || exit 0    # no-op outside Herdr
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
```

then, in the Python heredoc:

```python
seq = time.time_ns()                     # monotonic-enough ordering key
params = {"pane_id": os.environ["HERDR_PANE_ID"],
          "source": "herdr:kimi", "agent": "kimi", "seq": seq}
...
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(0.5)               # never block the agent's own hook path
    client.connect(os.environ["HERDR_SOCKET_PATH"])
    client.sendall((request + "\n").encode())
    client.recv(4096)
```

with the whole thing wrapped in `except: pass` and `|| true`. The five invariants:

1. **No-op outside Herdr.** Guard on `HERDR_ENV=1` plus the required vars.
2. **Never block the agent.** 0.5 s socket timeout, exceptions swallowed, exit 0 always.
3. **Stable, unique `--source`.** Herdr keys authority off it. Use `custom:<runtime>`; the
   `herdr:` prefix is reserved for official integrations (`is_official_agent_source`).
4. **Monotonic `seq`.** `time.time_ns()`. Herdr ignores reports whose seq is `<=` the last
   accepted from the same source (`socket-api.mdx:782`); a pane accepts at most 32 distinct
   sources for its lifetime.
5. **Release on exit.** Otherwise the pane keeps a stale agent identity.

`src/integration/assets/claude/herdr-agent-state.sh` is the session-only variant — same
skeleton, but `pane.report_agent_session` and never `pane.report_agent`. Copy the kimi
shape.

### What you keep and what you lose

**Keep:** everything downstream of state. Reported state "affects waits, notifications, and
rollups" identically (`socket-api.mdx:701`) — `agent.wait`, `agent.prompt --wait`, the
sidebar, workspace rollups, `pane.agent_status_changed` events, `agent.view.set` filters.
Also `pane.report_metadata` tokens and optional session refs.

**Lose:**

- **`agent.start`.** No `--kind` value exists, so launching is `pane.send_input` and
  herdr-dynamic-workflow owns readiness detection instead of Herdr's 30-second confirm loop: send the
  launch line, then `pane.wait_output` on a known banner or wait for the first `custom:`
  report.
- **Native session identity and restore.** Herdr can only resume an agent it knows how to
  relaunch (`integrations.mdx:84`). A custom source can *store* a session ref but Herdr
  will not use it.
- **Screen detection as a safety net.** If the reporter dies mid-turn the pane freezes on
  its last reported state forever — there is no manifest to fall back to. herdr-dynamic-workflow needs
  a heartbeat: require the reporter to re-assert `working` on an interval and treat
  staleness as an error, as orca's `buildDispatchPreamble()` does.
- **`agent.explain`.** No manifest, nothing to explain.

The escape hatch is real, but it moves work from Herdr to whoever writes the reporter. The
honest framing: **Herdr's agnosticism is 21 runtimes for free and an unbounded number for
about 60 lines of shell each.**

---

## 5. Per-runtime prompt delivery

### Herdr's single path

`agent.prompt` "honors live bracketed-paste mode and submits text plus encoded Enter
atomically, including while the agent is working" (`cli-reference.mdx:312`). One method,
same shape for all 21 kinds. `agent.send_keys` handles everything else (`esc`, `up`,
`enter`, `ctrl+c`, modifier chords).

The stall guard: with `wait`, a prompt sent from a **non-working** state must produce an
observed lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`
(`src/api/wait.rs:626`, `src/cli/spec.rs:357`). The error message names the mechanism:

```
agent prompt produced no observed state change within {timeout_ms} ms;
status is {status} and state_change_seq remained {baseline}
```

The baseline is `AgentInfo.state_change_seq` (`src/api/schema/agents.rs:216`). A caller
`timeout_ms` of ≤ 5000 keeps the ordinary `timeout` error instead.

Two consequences for herdr-dynamic-workflow:

- `agent_prompt_stalled` is a *distinct, recoverable* error class: the keystroke landed
  somewhere that did not start a turn. Typical causes are a modal the manifest does not
  recognize, or a composer that was not ready. Retry once after `agent.send_keys esc`; then
  fail the call with `AGENT_EXECUTION_ERROR`.
- `state_change_seq` is exposed on every `AgentInfo`. herdr-dynamic-workflow should snapshot it before
  the prompt and use the delta to distinguish "this turn completed" from "the previous turn
  completed". Herdr explicitly "does not track individual turns" — "if the agent is already
  working, completion of that active turn may satisfy the wait" (`agent-automation.mdx:76`).
  Never prompt an agent that is already `working` unless you intend that ambiguity.

### Contrast with orca

orca's `TUI_AGENT_CONFIG` (`src/shared/tui-agent-config.ts` in the orca repo)
covers 37 agents with a per-agent `promptInjectionMode`. Measured distribution:

| Mode | Count |
| --- | --- |
| `stdin-after-start` | 19 |
| `argv` | 11 |
| `flag-prompt` | 2 |
| `flag-prompt-interactive` | 2 |
| `flag-interactive` | 1 |
| `hermes-query` | 1 |

Plus four knobs the briefing did not name, each documented in-file with a "Why":

| Knob | Purpose (orca's own words) |
| --- | --- |
| `draftPromptFlag` / `draftPromptEnvVar` | seed the composer without submitting — `--prefill`, `ORCA_PI_PREFILL` — "avoiding the paste-after-ready race" |
| `preflightTrust: cursor\|copilot\|codex` | pre-write a trust artifact "so the agent's first-launch 'trust this folder?' menu doesn't consume the bracketed paste" |
| `draftPasteReadySignal` | renderer-specific composer-ready signal, "stronger than the default quiet-render window" |
| `windowsShiftEnterEncoding: 'csi-u'` | per-agent Shift+Enter encoding on Windows |

### Honest assessment

**The uniform path is sufficient for the steady state.** orca's 19 `stdin-after-start`
agents are exactly Herdr's model: launch the bare TUI, paste into it. `argv` and the
`flag-*` modes only describe how orca delivers the *first* prompt at launch. herdr-dynamic-workflow
never needs them — it always launches bare via `agent.start` and always delivers turn 1 the
same way as turn N. Herdr's bracketed-paste-aware atomic submit plus `agent_prompt_stalled`
is a strictly better contract than orca's timing heuristics for that case.

**But three of orca's knobs describe real problems Herdr does not fully solve:**

1. **First-launch trust prompts (`preflightTrust`) are a live hazard.** Herdr's answer is
   passive: if detection reports `blocked` during startup, `agent.start` returns
   `agent_not_ready` (`agent-automation.mdx:52`). Correct, but a failure rather than a
   resolution — and it only fires if the manifest recognizes that specific trust screen.
   For a thin manifest (`gemini`, `copilot`, `agy`) an unrecognized trust prompt reads as
   `idle`, `agent.start` succeeds, and the first `agent.prompt` is eaten by the menu.
   **herdr-dynamic-workflow needs a preflight per (machine, kind, repo).** This is the one place a
   per-runtime table is unavoidable; keep it a small opt-in `trustPreflight` map.
2. **Composer-ready timing (`draftPasteReadySignal`) is mostly handled.** `agent.start`
   returns only after Herdr confirms interactive readiness (`AgentInfo.interactive_ready`,
   `src/app/agents.rs:390`), subsuming orca's quiet-render heuristic. Residual risk is the
   same thin-manifest case; `agent_prompt_stalled` catches it after 5 s.
3. **`hermes-query`** — orca needs a bespoke path for one agent. Herdr treats Hermes like
   everything else. Untested from here; a known unknown.

Windows Shift+Enter encoding is not herdr-dynamic-workflow's problem: `agent.prompt` encodes submission
itself and multi-line prompts go through bracketed paste.

**Verdict: herdr-dynamic-workflow ships with no `promptInjectionMode` equivalent.** It ships with an
optional per-kind `trustPreflight` hook and a universal single-retry-after-`esc` policy on
`agent_prompt_stalled`. If that proves insufficient for a specific runtime, the fix belongs
in a Herdr detection manifest (which anyone can override locally, `agents.mdx:66`), not in
a herdr-dynamic-workflow agent table. Keeping the agent table out of herdr-dynamic-workflow is the whole point.

---

## 6. Result harvesting across runtimes

### Why not screen-scrape

Three independent reasons, all verified:

1. **Pane content is the agent's UI, not its answer.** Every runtime renders differently.
   A scraper is a 21-way parser — precisely the per-agent table this project exists to
   avoid.

2. **Alt-screen reads move the agent's own viewport.** Herdr's docs
   (`agent-automation.mdx:83-87`): full-screen agents such as Claude Code and OpenCode render
   transcript history in the terminal's alternate screen. For an idle, recognized agent,
   `recent`/`recent-unwrapped` reads with `--lines` beyond the visible screen "automatically
   use the agent's mouse-scroll interface", collecting overlapping pages and returning the
   viewport to the bottom. An explicit `agent read --lines N` needing alt-screen history
   "returns `agent_not_idle` while the agent is working, blocked, or unknown"
   (`src/server/headless.rs:3361`, `:6497`). Harvesting is therefore a *stateful,
   racy operation on the agent's UI* for exactly the agents most likely to be used.

3. **`--source recent` and `recent-unwrapped` returned EMPTY with no client attached
   (measured).** `visible` and `detection` worked. Detection working is what preserves
   status, but it removes the scrape path in precisely the headless worker-session
   configuration herdr-dynamic-workflow chose (briefing decision 4).

Herdr's own documentation reaches the same conclusion: "If a full response is still
unavailable, ask the agent to write it as Markdown in a temporary directory and reply only
with the file path, then read the file directly" (`agent-automation.mdx:87`).

### The contract

**Environment.** Set on `pane.split` (`PaneSplitParams.env`) so the agent inherits it:

| Var | Value | Purpose |
| --- | --- | --- |
| `HERDR_FLOW_OUT` | `<state-dir>/<runId>/<callIndex>.json` | the file the agent must write |
| `HERDR_FLOW_RUN` | `run_9f2c` | run correlation for logs and journal |
| `HERDR_FLOW_CALL` | `7` | lexical call index (pi's `state.callSeq`) |
| `HERDR_FLOW_SCHEMA` | `<state-dir>/<runId>/<callIndex>.schema.json` | present only when `options.schema` was given |

`<state-dir>` is `$HERDR_PLUGIN_STATE_DIR/runs` locally; on a remote machine it is a path
under the checkout so `git` can carry it back (§7).

**Prompt preamble.** Prepended to every `agent()` prompt. Fixed text, no per-runtime
variation — this is the cost the briefing acknowledged (decision 3):

```
[herdr-dynamic-workflow output contract]
When you have finished this task, write your complete answer to the file at the
path in the HERDR_FLOW_OUT environment variable, as JSON:

  {"ok": true, "result": <your answer>}

`result` is a plain string unless a JSON Schema is present at HERDR_FLOW_SCHEMA,
in which case `result` must validate against it. If you cannot complete the task,
write {"ok": false, "error": "<one line>"} instead. Write the file exactly once,
as the last thing you do. Do not print the answer to the terminal instead of
writing the file; terminal output is not read.
[end contract]
```

**File format.** One JSON object. `{"ok":true,"result":<any>}` or
`{"ok":false,"error":"<string>"}`. Nothing else — no wrapping fences, no prose.

**Validation ladder.** Adapted from pi's `extractValidated()`:

1. File missing after the wait resolved → do not trust the wait. Re-read `agent.get` and
   `agent.explain`; if `blocked`, apply the configured `on_blocked` policy; otherwise take the degraded
   path.
2. File present but unparseable → strip fences, take the first balanced-brace object,
   re-parse.
3. `ok: false` → `AGENT_EXECUTION_ERROR` with the agent's own message (recoverable in pi's
   taxonomy: retry, then collapse to `null`).
4. Schema present → coerce, then check. Failure is `SCHEMA_NONCOMPLIANCE`, non-recoverable,
   never a silent `null` — pi's guarantee preserved without pi's tool-level enforcement.

**Degraded fallback.** When the file is absent and the agent is genuinely settled:

```json
{"id":"flow_h1","method":"agent.read","params":{
  "target":"flow-run9f2c-7","source":"visible","format":"text","strip_ansi":true
}}
```

Deliberately `visible`, not `recent`: `visible` was measured working headless, does not
trigger the alt-screen mouse-scroll path, and cannot return `agent_not_idle`. The result is
returned with `fallbackReason: "output_file_missing"` attached, and the journal (§8) marks
the call as fallback-sourced so a resume can be told to re-run it.

### Why this is runtime-independent

The contract touches nothing agent-specific: (a) process environment, which every CLI
inherits from its shell, (b) natural-language instruction, which every coding agent
follows, (c) the filesystem, which every agent can write. It degrades identically for all
21 kinds and for custom-source runtimes (§4), which get the same env from the same
`pane.split` call.

The residual weakness is honest: **compliance is a model behaviour, not an enforced tool
call.** pi's `createStructuredOutputTool()` made non-compliance structurally impossible —
the tool's `parameters` *was* the schema, returning `terminate: true`. herdr-dynamic-workflow can only
ask. Expect a non-zero non-compliance rate that varies by model, not by CLI. Mitigations:
short preamble at the *top* of the prompt, absolute file path, and fallback rate per
(kind, model) tracked as a first-class run metric.

---

## 7. Placement across machines and runtimes

### One server per machine

Sockets are local. `herdr --remote <host>` streams a remote TUI; it is a UI attach, not a
control channel. A fleet is therefore N transports, each with its own socket, its own ID
namespace, and its own `w1:p1`.

Named sessions are fully headless (**measured**): `herdr --session <name> server` runs with
zero TUI clients, its own socket at `~/.config/herdr/sessions/<name>/herdr.sock`, and pane
IDs starting at `w1:p1` unrelated to the default session. Workspace creation, `pane run`,
and command execution all work with nothing rendered.

### Transport (briefing decision 8)

| Transport | Mechanism | Events? | Latency |
| --- | --- | --- | --- |
| Local | connect directly to the Unix socket / named pipe, NDJSON | yes | sub-ms |
| Remote | `ssh host '<herdr_bin> --session flow ...'` per call | **no** | ~100 ms/call |

Remote machines have no event stream, so waits there are either a long-lived blocking
`herdr agent wait --until done` call or a poll of `agent.get`. Prefer the former: it moves
the waiting server-side and costs one SSH connection instead of many.

An earlier version of this decision tunnelled the socket protocol over SSH
(`ssh host 'socat - UNIX-CONNECT:<sock>'`) to preserve `events.subscribe` remotely. That
was over-built: an agent call runs for minutes, so the saved latency is irrelevant, while
the cost is a `socat`/`nc` dependency on every host, a capability probe at fleet-init, and
a second transport implementation to maintain. See
[D13](../SPEC.md#d13-local-machines-use-the-socket-remote-machines-use-plain-herdr-over-ssh).

The consequence that matters is a capability difference, not a speed one: **anything built
on `events.subscribe` works locally and silently does not exist remotely.** The scheduler
must be written so events are an optimization, never a requirement. Reuse SSH connections
(`ControlMaster`/`ControlPersist`) or per-call handshakes will dominate the 100 ms.

### The `HERDR_SOCKET_PATH` trap

Resolution order is `--session <name>` → `HERDR_SOCKET_PATH` → `HERDR_SESSION` → default
(`socket-api.mdx:670-676`). **`HERDR_SOCKET_PATH` outranks `HERDR_SESSION`**, and Herdr
injects `HERDR_SOCKET_PATH` into every managed pane and every plugin command
(`socket-api.mdx:292`, `plugins.mdx:254`).

So an engine running inside a Herdr pane — which is the normal case, since the plugin's
actions and panes are launched by Herdr — will silently drive the *user's* session unless
it strips the inherited value:

```bash
env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH \
  herdr --session flow agent list
```

herdr-dynamic-workflow's transport layer must construct every connection from an explicit socket path
it computed itself, and must never read `HERDR_SOCKET_PATH` from its own environment except
to identify the *host* session for UI purposes (§10).

### The placement constraint set

An `agent()` call needs a machine where **all** of:

| Constraint | How herdr-dynamic-workflow checks it |
| --- | --- |
| the requested `kind` is installed | probe `command -v <interactive_agent_executable(kind)>` once per (machine, kind), cache |
| the kind is *reliable* on that machine | `server.agent_manifests` + `herdr integration status`; compute the §3 grade at runtime |
| the repo is checked out at the right ref | `worktree.list`, or `worktree.create` on demand |
| a free slot exists | machine-level concurrency cap; Herdr has no queue (§8) |
| the transport tier is acceptable | recorded at fleet-init |

Two facts make placement harder than it looks. First, `kind` availability is per-machine:
`codex` on the Linux box and `claude` on the Mac is the normal case, so the scheduler must
treat `kind` as a placement constraint, not a parameter. Second, **the journal key must
include `{machine, kind}`** (briefing decision 7) — pi hashes
`{prompt, model, phase, agentType, schema}`, and without the machine and kind a resume
silently replays a result produced by `codex`-on-linux-01 as though `claude`-on-laptop produced
it.

### Cross-machine harvest

`HERDR_FLOW_OUT` on a remote machine is a remote path. Do not `scp` it — write it inside the
worktree at a path the workflow owns, and let the existing git flow carry it:

```
<worktree>/.herdr-dynamic-workflow/<runId>/<callIndex>.json
```

The remote agent commits nothing; herdr-dynamic-workflow reads it with one `ssh host cat <path>` (or
`git fetch` of a scratch ref when the volume justifies it). The rule is: **results move by
git or by an explicit read, never by assuming a shared filesystem.**

---

## 8. What Herdr does NOT give you

Herdr is a terminal runtime with a control API. It is not an orchestrator, and its own
docs say so — "Herdr stores no tasks, dependencies, or scheduling; sequencing is the
caller's job." Nothing named orchestrator, workflow, queue, or fanout exists in `src/`.

| Gap | Evidence | Who owns it | How |
| --- | --- | --- | --- |
| **Task / DAG state** | no such concept in the API surface | herdr-dynamic-workflow | pi's `phase()` / `pipeline()` / `parallel()` carried over unchanged; the DAG is the JS script's control flow, exactly as in pi |
| **Scheduling / queueing** | `agent.start` fails immediately with `agent_pane_busy`; nothing queues | herdr-dynamic-workflow | port pi's `createLimiter(limit)`; slot reservation stays synchronous (`shared.agentCount++` with no await between check and increment) so `parallel()` cannot overshoot |
| **Token accounting** | no token field anywhere in `AgentInfo`/`PaneInfo`; agents are PTYs | herdr-dynamic-workflow (re-keyed) | briefing decision 5: `budget` becomes agent-count + wall-clock. `PROVIDER_USAGE_LIMIT` → paused-run → auto-resume-on-quota-reset is **dropped**; there is no signal to rebuild it on |
| **Cross-machine ID namespacing** | every session's panes start at `w1:p1`; namespaces are per-server | herdr-dynamic-workflow | all internal handles are `{machine, paneId}` tuples; a bare `w1:p2` never crosses a module boundary |
| **Persistence of orchestration intent** | `session.json`/`plugins.json` persist panes and plugins, never intent | herdr-dynamic-workflow | pi's journal under `HERDR_PLUGIN_STATE_DIR`, keyed `{runId, callIndex}` with `storeDelta` per entry; longest-unchanged-prefix replay is the resume mechanism |
| **Runtime registration of new agent kinds** | `Agent::ALL` (`src/detect/mod.rs:68`), `interactive_agent_executable` (`:141`), and `lookup_agent` (`:183`) are compiled-in `match` arms; remote manifests only patch rules for already-known agents (`agents.mdx:74`) | herdr-dynamic-workflow | the `pane.report_agent` escape hatch (§4). herdr-dynamic-workflow provides a reporter template, not an agent table |
| **Headless geometry** | `MIN_COLS = 80`, `MIN_ROWS = 24` (`src/server/headless.rs:256-257`); sidebar + status row leave **53x23** usable (measured via `stty size`) | herdr-dynamic-workflow | see below |
| **Structured-output enforcement** | `agent.prompt` sends text; there is no tool layer | herdr-dynamic-workflow | §6 contract + validation ladder; accept a non-zero non-compliance rate |
| **Turn identity** | "It does not track individual turns" (`agent-automation.mdx:76`) | herdr-dynamic-workflow | snapshot `state_change_seq` before each prompt; refuse to prompt a `working` agent |
| **Cancellation of an in-flight turn** | no API cancels a turn | herdr-dynamic-workflow | `agent.send_keys esc` → poll → `ctrl+c` → `pane.close`; layered like pi's per-attempt `AbortController` |

### The geometry constraint deserves its own paragraph

53x23 is below what most coding-agent TUIs target, and **screen manifests match against
screen regions** — several use `bottom_non_empty_lines(N)`, `after_last_horizontal_rule`,
and `prompt_box_body`. Cramped wrapping can split a control hint across lines and break a
`line_regex`, silently changing `agent_status`, which is the spine of the scheduler.

Geometry derives from the **foreground client**, so the fix is cheap: attach any client to
the worker session and every pane in it gets real dimensions. Session bootstrap must
therefore (1) start `herdr --session flow server`, (2) attach one client at a large fixed
size — an off-screen terminal, or `terminal session observe` with explicit `--cols`
/`--rows`, (3) assert via a probe pane that the geometry took effect, and (4) refuse to
start a run if it did not, rather than emit unexplained detection noise.

This is a hard operational dependency on something Herdr does not guarantee — the single
most fragile assumption in the design.

---

## 9. How the plugin packages it

### Why a plugin, not a core patch

Herdr's `CLAUDE.md` external-contributor guardrail applies: the acting account is not in
`.github/MAINTAINERS`, unsolicited implementation PRs against `herdrdev/herdr` are closed
automatically. Beyond compliance, plugins are the *designed* path: "There is no separate
plugin SDK or restricted command set. The entire Herdr CLI is the plugin API"
(`plugins.mdx:23`). Distribution is a public GitHub repo tagged `herdr-plugin`
(`plugins.mdx:362-374`). Nothing herdr-dynamic-workflow needs is missing from the public surface.

### Draft manifest

```toml
id = "herdrflow.engine"
name = "Herdr Dynamic Workflow"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "Deterministic JavaScript workflows driving real coding-agent CLIs"
platforms = ["linux", "macos"]

# bun is the runtime; the engine is TypeScript adapted from pi-dynamic-workflows.
[[build]]
command = ["bun", "install"]

[[build]]
command = ["bun", "run", "build"]

# Re-applies the saved agent.view.set projection (views are transient and die
# with the server) and re-attaches to the worker session.
[[startup]]
command = ["bun", "run", "dist/startup.js"]

[[actions]]
id = "run"
title = "Run a workflow"
contexts = ["global", "workspace"]
command = ["bun", "run", "dist/run.js"]

[[actions]]
id = "resume"
title = "Resume last run"
contexts = ["global"]
command = ["bun", "run", "dist/resume.js"]

[[actions]]
id = "abort"
title = "Abort active run"
contexts = ["global"]
command = ["bun", "run", "dist/abort.js"]

# Per-agent escalation target for the configured on_blocked = "escalate" policy.
[[actions]]
id = "answer-blocked"
title = "Answer this blocked agent"
contexts = ["pane"]
command = ["bun", "run", "dist/answer.js"]

# The run board. overlay = temporary zoomed overlay over the active pane,
# restoring previous focus and zoom on close (plugins.mdx:287).
[[panes]]
id = "board"
title = "Flow board"
placement = "overlay"
command = ["bun", "run", "dist/board.js"]

# Fleet/machine picker; session-modal, no pane ID, outside all pane APIs.
[[panes]]
id = "machines"
title = "Flow machines"
placement = "popup"
width = "70%"
height = 18
command = ["bun", "run", "dist/machines.js"]

# Reconcile the run when an agent settles or a pane dies underneath us.
[[events]]
on = "pane.agent_status_changed"
command = ["bun", "run", "dist/on-status.js"]

[[events]]
on = "pane.exited"
command = ["bun", "run", "dist/on-exit.js"]

[[events]]
on = "pane.closed"
command = ["bun", "run", "dist/on-exit.js"]
```

Notes on the shape:

- `min_herdr_version` is required; the server refuses to link a plugin whose minimum
  exceeds the running binary (`plugins.mdx:101-104`).
- `platforms` omits `windows` for v1: the reference reporter (§4) is `/bin/sh` + `python3`
  and the remote transport (§7) assumes a POSIX remote shell (`ssh host '<herdr_bin>
  agent ...'`). Better declared than a `platform_unsupported` error at invoke time. Note this
  is about the *engine's* host and its SSH targets — a Windows machine can still be a
  worker if something else drives it.
- **Event hooks are one-shot commands, not a subscription.** Herdr spawns the argv command
  per event — a process per transition for a 15-agent run. The engine's real event path
  must be a long-lived `events.subscribe` connection owned by the run process; the
  `[[events]]` hooks exist only to nudge a *detached* run and to reconcile after a restart.
- `[[startup]]` is explicitly "one-shot initialization commands rather than supervised
  daemons" (`plugins.mdx:242`). Do not run the engine from it. Its documented job — reapply
  a saved Agent view from `HERDR_PLUGIN_STATE_DIR` (`plugins.mdx:244`) — is exactly what
  §10 needs.

### Injected environment

Herdr injects `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`, `HERDR_PLUGIN_ID`,
`HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`,
`HERDR_PLUGIN_CONTEXT_JSON`, and available `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` /
`HERDR_PANE_ID`. Actions also get `HERDR_PLUGIN_ACTION_ID`; event hooks get
`HERDR_PLUGIN_EVENT` and `HERDR_PLUGIN_EVENT_JSON`; pane commands get
`HERDR_PLUGIN_ENTRYPOINT_ID` (`plugins.mdx:251-261`).

Directory discipline (`plugins.mdx:263-270`): `HERDR_PLUGIN_ROOT` is a managed source
checkout — never write there. The fleet definition (machines, SSH aliases, per-machine kind
availability, concurrency caps) goes in `HERDR_PLUGIN_CONFIG_DIR`. Run journals, output
files, and the saved agent view go in `HERDR_PLUGIN_STATE_DIR`. There is no Herdr-managed
storage API in v1; the plugin owns format, migration, and cleanup.

And, restating §7 because it is the easiest bug to ship: the injected
`HERDR_SOCKET_PATH` points at the *host* session, not the worker session. Strip it.

---

## 10. Progress UI for free

pi ships `workflow-ui.ts` (1811 lines), `task-panel.ts`, and `display.ts` to render run
progress in a Pi TUI. herdr-dynamic-workflow deletes all of it and renders in Herdr's own sidebar using
two APIs that already exist.

### Tokens: `pane.report_metadata`

Each worker pane gets display-only tokens as the run advances:

```json
{"id":"flow_ui1","method":"pane.report_metadata","params":{
  "pane_id":"w1:p7",
  "source":"plugin:herdrflow.engine",
  "title":"review auth middleware",
  "display_agent":"flow: review",
  "state_labels":{
    "working":"phase 2/4 · review",
    "blocked":"needs a decision",
    "done":"result ready"
  },
  "tokens":{
    "flow_run":"run_9f2c",
    "flow_phase":"2/4",
    "flow_call":"7",
    "flow_kind":"codex",
    "flow_machine":"linux-01"
  },
  "ttl_ms":3600000
}}
```

Constraints (`socket-api.mdx:766-780`): at most 16 token keys per report, 32 retained per
resource, values normalized and capped at 80 chars, token names 1–32 chars of
`[A-Za-z0-9_-]`, `ttl_ms` between 1 and 86 400 000. Tokens render as `$flow_phase` in Agent
sidebar rows. They are **visual only** — waits, notifications, and rollups still use
semantic state, which is exactly the separation herdr-dynamic-workflow wants: the engine never
influences Herdr's authority model, it only annotates it.

Roll the run itself up with `workspace.report_metadata` on the worker workspace
(`$flow_progress` = `"11/23 · 2 blocked"`), giving the Spaces row a live summary.

### Projection: `agent.view.set`

One transient declarative projection over the built-in Agents view — no custom widget, no
render loop:

```json
{"id":"flow_ui2","method":"agent.view.set","params":{
  "source":"plugin:herdrflow.engine",
  "label":"flow run_9f2c",
  "filter":{
    "op":"all",
    "filters":[
      {"op":"eq","field":{"token":"flow_run"},"value":"run_9f2c"},
      {"op":"not","filter":{"op":"in","field":"status","values":["unknown"]}}
    ]
  },
  "sort":[
    {"field":"attention","order":"desc"},
    {"field":{"token":"flow_phase"},"order":"asc"},
    {"field":{"token":"flow_call"},"order":"asc"},
    {"field":"state_change_seq","order":"desc"}
  ]
}}
```

This is valid against `AgentViewSetParams` (`src/api/schema/agents.rs:49-161`):
`{"token":"name"}` is a legal filter field and a legal sort field; `op` accepts
`all|any|not|eq|in|exists`; sort fields accept the eight builtins plus tokens; sorts are
stable and evaluated in order, with missing values sorted after present ones.

The result: the user's Agents sidebar shows exactly this run's agents, blocked ones first,
then in phase and call order — the workflow's progress tree, rendered by Herdr.

Three operational rules:

1. **`source` must be `plugin:<HERDR_PLUGIN_ID>`.** Herdr rejects plugin-owned sets when
   that plugin is missing or disabled (`socket-api.mdx:463`).
2. **The view is transient.** It dies when cleared, replaced, its plugin is disabled or
   unlinked, or the server exits. The documented durable pattern — save the query under
   `HERDR_PLUGIN_STATE_DIR` and reapply it from a `[[startup]]` hook
   (`socket-api.mdx:467-469`) — is why the manifest in §9 has a startup hook.
3. **Clear with the owned form** on run completion, so a concurrent owner is not stomped:

```json
{"id":"flow_ui3","method":"agent.view.clear","params":{
  "source":"plugin:herdrflow.engine"
}}
```

A source mismatch leaves the active view unchanged.

### What still has to be built

`agent.view.set` projects the *Agents* view. It has no notion of phases, dependencies, or
completed-and-torn-down calls — an agent whose pane is closed disappears from it entirely.
So herdr-dynamic-workflow still needs the `board` overlay pane (§9) for the DAG view, the timeline, and
the history of finished calls. The sidebar gets the *live* tree for free; the *run* view is
still herdr-dynamic-workflow's to write. That is a large reduction from pi's ~2 500 lines of display
code, not an elimination.

---

## Open risks, ranked

1. **Screen-detection quality is the ceiling on runtime-agnosticism.** Six of 21 kinds have
   authoritative lifecycle hooks. The other 15 are as reliable as a TOML file's coverage of
   a UI that ships new versions weekly. `cline` is currently *broken* for wait-based
   orchestration (§3) and `gemini`/`kilo`-without-plugin will report idle early. This is the
   claim's real boundary: **Herdr is agnostic across 21 runtimes at very different quality
   levels**, and herdr-dynamic-workflow must expose those levels rather than hide them.
2. **The 53x23 headless geometry** (§8) interacts with #1 multiplicatively: narrow panes
   degrade exactly the screen rules that weak manifests depend on. The client-attach
   workaround is an operational dependency, not a guarantee.
3. **Output-contract compliance is unenforced** (§6). pi could not produce a non-compliant
   result; herdr-dynamic-workflow can. Track fallback rate per (kind, model) as a run metric.
4. **First-launch trust prompts** (§5) are the one place a per-runtime table is unavoidable.
   Keep it to an opt-in `trustPreflight` map and refuse to let it grow into an agent config
   table.
5. **Event-hook cost.** `[[events]]` spawns a process per event; a 15-agent run generates
   many. The engine must own a long-lived `events.subscribe` and keep manifest hooks
   trivial (§9).
