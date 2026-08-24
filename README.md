# Herdr Dynamic Workflow

A [Herdr](https://herdr.dev) plugin that packages a workflow CLI and an agent
skill. It does not register a new tool inside Codex, Claude, Cursor, or another
agent. The skill teaches an agent to write a workflow and invoke the CLI. The
CLI then runs each `agent()` call as a real coding-agent process in a Herdr
pane, in sequence, in parallel, in an isolated git worktree, or over SSH.

## Install

Requirements:

- Herdr 0.8.0 or newer
- Node.js 20 or newer
- Git
- At least one coding-agent CLI configured in Herdr

Install the plugin from GitHub, replacing `<owner>` with the repository owner:

```bash
herdr plugin install <owner>/herdr-dynamic-workflow
```

That installation also:

- copies `herdr-dynamic-workflow` next to the `herdr` binary, so the command
  works in any terminal
- uses the `skills` CLI to copy the bundled `herdr-workflow-authoring` skill
  into detected skill-capable agent clients

For local development, build and link the checkout, then install the command:

```bash
npm ci
npm run build
herdr plugin link .
npm run install-cli
npm run install-skill
```

Herdr runs plugin code with your user account and does not sandbox it. Review
[`herdr-plugin.toml`](./herdr-plugin.toml) and the source before installing.

## Run a workflow

The CLI is the runtime entry point, not an injected agent tool. It accepts one
JSON object with the same shape as Claude Code's `Workflow` tool, plus a few
host fields because the runtime is independent of Claude.

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

Resume is the same object with `resumeFromRunId` set. Run IDs use Claude's
`wf_[a-z0-9-]{6,}` format.

```bash
herdr-dynamic-workflow <<'JSON'
{ "scriptPath": "review.js", "resumeFromRunId": "wf_mt5cpbpy-i2ab" }
JSON
```

`herdr-dynamic-workflow skill` prints the bundled authoring guide for manual
inspection.

Large inline `script` values can blow argv. Pipe the object on stdin, or write
a file and pass `scriptPath`. Claude tells the model to pass `script` inline
and never Write a file first. We cannot do that: this host is a shell command.

The run opens a Herdr workspace named `<meta.name> · <last-4-of-run-id>` and
closes it when the script finishes. Journal data lives in the plugin state
directory Herdr manages.

## Claude's Workflow tool vs this CLI

Claude Code calls a first-party `Workflow` tool. This plugin deliberately uses
a CLI plus a skill. The skill tells an agent how to author and invoke a
workflow through its normal shell access; the CLI owns the runtime. Keeping
that boundary outside any one agent lets the same workflow launch every agent
CLI Herdr supports.

Claude:

```json
{
  "scriptPath": "/workspace/review.js",
  "args": {
    "pr": 412,
    "files": ["src/plugin/run.ts"]
  }
}
```

Us:

```json
{
  "scriptPath": "/workspace/review.js",
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
  "scriptPath": "/workspace/review.js",
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
| `resumeFromRunId` | `wf_[a-z0-9-]{6,}` | same |
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
- `ssh` selects a computer: a name that already works with `ssh` in your
  terminal. Omit it and the call runs here.

The runtime rejects options it cannot resolve. It does not silently ignore
them.

The bundled
[`herdr-workflow-authoring`](./skills/herdr-workflow-authoring/SKILL.md) skill
documents the full interface and links to runnable examples.

## Other computers

```js
const there = await agent("Run the benchmarks.", { ssh: "example-host" });
```

If `ssh example-host` works in your terminal, it works here. There is no
inventory file. Herdr on that host is found with a login-shell probe, and its
worker session's server is autostarted if it isn't running.

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

The Herdr runner connects the workflow engine to Herdr's socket and CLI APIs.
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

MIT. See [`LICENSE`](./LICENSE).
