# Herdr Dynamic Workflow

A [Herdr](https://herdr.dev) plugin for running JavaScript workflows across the
coding-agent CLIs Herdr supports. Each `agent()` call starts a real CLI in a
Herdr pane. Calls can run in sequence, in parallel, in isolated git worktrees,
or on another computer over SSH.

## Install

Requirements:

- Herdr 0.8.0 or newer
- Node.js 20 or newer
- Git
- At least one coding-agent CLI configured in Herdr

Install the plugin from GitHub:

```bash
herdr plugin install andthezhang/herdr-dynamic-workflow
```

That build also copies `herdr-dynamic-workflow` next to the `herdr` binary, so
the command works in any terminal, not only inside Herdr.

For local development, build and link the checkout, then install the command:

```bash
npm ci
npm run build
herdr plugin link .
npm run install-cli
```

Herdr runs plugin code with your user account and does not sandbox it. Review
[`herdr-plugin.toml`](./herdr-plugin.toml) and the source before installing.

## Run a workflow

The CLI is the tool. You pass one JSON object, the same shape Claude Code's
`Workflow` tool takes, then a few host fields because we are not already
inside Claude.

Save this as `hello-workflow.js` in the project you want agents to work on:

```js
export const meta = {
  name: "hello_workflow",
  description: "One agent picks a topic and another writes a haiku",
  phases: [{ title: "Topic" }, { title: "Haiku" }],
};

phase("Topic");
const topic = await agent("Pick a concrete topic for a haiku about software.", {
  kind: "codex",
  label: "pick-topic",
});

phase("Haiku");
const haiku = await agent(`Write a 5-7-5 haiku about ${topic}.`, {
  kind: "claude",
  label: "write-haiku",
});

return { topic, haiku };
```

Then pipe the invoke object. A heredoc, like browser-use. Quoted `'{}'` works
for a one-liner and gets ugly the moment `args` has quotes.

```bash
herdr-dynamic-workflow <<'JSON'
{ "scriptPath": "hello-workflow.js" }
JSON
```

`args` becomes the script global `args`. Same as Claude. Not a side-channel file.

```bash
herdr-dynamic-workflow <<'JSON'
{ "scriptPath": "review.js", "args": { "pr": 412, "files": ["src/plugin/run.ts"] } }
JSON
```

Resume is the same object with `resumeFromRunId` set. Our ids look like
`run-mt5cpbpy-i2ab`, not Claude's `wf_…`.

```bash
herdr-dynamic-workflow <<'JSON'
{ "scriptPath": "review.js", "resumeFromRunId": "run-mt5cpbpy-i2ab" }
JSON
```

If you don't have the skill already: `herdr-dynamic-workflow skill`.

Large inline `script` values can blow argv. Pipe the object on stdin, or write
a file and pass `scriptPath`. Claude tells the model to pass `script` inline
and never Write a file first. We cannot do that: this host is a shell command.

The run opens a Herdr workspace named `<meta.name> · <last-4-of-run-id>` and
closes it when the script finishes. Journal data lives in the plugin state
directory Herdr manages.

## Claude's Workflow tool vs this CLI

Claude Code calls a first-party tool. We ship a CLI plus a skill, because a
Herdr plugin cannot inject a tool into Codex, Cursor, or Claude. The JSON
object is the part that stays aligned.

Claude:

```json
{
  "scriptPath": "/Users/andy/proj/review.js",
  "args": {
    "pr": 412,
    "files": ["src/plugin/run.ts"]
  }
}
```

Us:

```json
{
  "scriptPath": "/Users/andy/proj/review.js",
  "args": {
    "pr": 412,
    "files": ["src/plugin/run.ts"]
  },
  "kind": "codex"
}
```

```bash
herdr-dynamic-workflow <<'JSON'
{
  "scriptPath": "/Users/andy/proj/review.js",
  "args": { "pr": 412, "files": ["src/plugin/run.ts"] },
  "kind": "codex"
}
JSON
```

| Field | Claude | Us |
| --- | --- | --- |
| `script` | inline JS, max 524,288 chars | same |
| `scriptPath` | file on disk, wins over `script` and `name` | same |
| `name` | saved workflow (`.claude/workflows/`) | accepted, then rejected. no registry yet |
| `args` | any JSON, becomes the `args` global | same |
| `resumeFromRunId` | `wf_[a-z0-9-]{6,}` | `run-[a-z0-9]+-[a-z0-9]+` |
| `title` / `description` | accepted, ignored. real values live in `meta` | rejected. `additionalProperties: false` |
| `kind` | no. every subagent is Claude | optional run default when a call omits `kind` |
| `session` / `cwd` | no. Claude is the host | optional. omit them for zero-config |
| `ssh` | no | not here. `agent({ ssh: "linux-box" })` in the script |

No required fields. You must still supply `scriptPath`, `script`, `name`, or
`resumeFromRunId`. Precedence is `scriptPath > script > name`, same as Claude.
Unknown keys fail before any Herdr work. The JS parser and `meta` literal
check run after that, same split Claude uses.

`ssh` and per-call `kind` / `label` stay in the script. That is the
dialect, not the tool. Claude's own tool description is archived in
[`docs/claude-code-workflow-tool.md`](./docs/claude-code-workflow-tool.md).

## Workflow interface

The runtime implements Claude Code's Workflow dialect:

- Globals: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`,
  and `workflow`
- Agent options: `label`, `phase`, `schema`, `model`, `effort`, `isolation`,
  and `agentType`
- Quality helpers: `verify`, `judgePanel`, `loopUntilDry`,
  `completenessCheck`, `retry`, `gate`, and `checkpoint`
- Pi options: `tier`, `timeoutMs`, and `retries`

The plugin adds two options:

- `kind` selects the coding-agent CLI, such as `codex`, `claude`, or `pi`.
- `ssh` selects a computer by ssh Host name: an alias from `~/.ssh/config`, or
  `user@host`. Omit it and the call runs here.

The runtime rejects options it cannot resolve. It does not silently ignore
them.

The bundled
[`herdr-workflow-authoring`](./skills/herdr-workflow-authoring/SKILL.md) skill
documents the full interface and links to runnable examples.

## Other computers

```js
const there = await agent("Run the benchmarks.", { ssh: "build-mac" });
```

`ssh: "build-mac"` is an ssh Host name — an alias from `~/.ssh/config`, or
`user@host`. There is no inventory file: if `ssh build-mac` works in your
terminal, it works here. Herdr on that host is found with a login-shell probe,
and its worker session's server is autostarted if it isn't running.

Omit `ssh` and the call runs on this computer. A blank `ssh` is an error, not a
silent fall back to local. Worktree isolation cannot travel over ssh, because
the worktree only exists here.

See [`ssh-hello.js`](./skills/herdr-workflow-authoring/reference/ssh-hello.js)
for a runnable two-computer example.

## How it works

```text
workflow.js
    |
    v
workflow engine
    |
    v
Herdr runner -> workspace -> pane -> agent CLI -> result file
                         \
                          -> SSH host, when selected
```

The engine is adapted from
[`pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows).
The Herdr runner replaces the Pi SDK backend with Herdr's socket and CLI APIs.
Agents write results to `$HERDR_FLOW_OUT`; the runner validates that file and
uses Herdr's agent status to track completion.

The current release supports local and SSH workers, schema-checked output,
journal replay, blocked-agent policies, and local worktree isolation. Worktree
isolation over ssh and detached runs are not implemented yet.

## Development

```bash
npm ci
npm test
npm run build
```

The test suite uses mock Herdr sockets and SSH transports. The runner was also
exercised with real Codex and Claude CLIs in Herdr panes,
including a two-computer run and a journal replay with no live agent calls.

Design decisions and known limitations are recorded in [`SPEC.md`](./SPEC.md).
Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](./LICENSE). The vendored engine retains the upstream
copyright notices from `pi-dynamic-workflows`.
