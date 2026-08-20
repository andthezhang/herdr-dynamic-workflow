# Herdr Dynamic Workflow

A [Herdr](https://herdr.dev) plugin for running JavaScript workflows across the
coding-agent CLIs Herdr supports. Each `agent()` call starts a real CLI in a
Herdr pane. Calls can run in sequence, in parallel, in isolated git worktrees,
or on another machine over SSH.

## Install

Requirements:

- Herdr 0.8.1 or newer
- Node.js 20 or newer
- Git
- At least one coding-agent CLI configured in Herdr

Install the plugin from GitHub:

```bash
herdr plugin install andthezhang/herdr-dynamic-workflow
herdr plugin action list --plugin herdrflow.engine
```

For local development, build the checkout before linking it:

```bash
npm ci
npm run build
herdr plugin link .
```

Herdr runs plugin code with your user account and does not sandbox it. Review
[`herdr-plugin.toml`](./herdr-plugin.toml) and the source before installing.

## Run a workflow

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

Run it from that project:

```bash
herdr plugin action invoke herdrflow.engine.run -- \
  "$PWD/hello-workflow.js" --cwd "$PWD"
```

Passing `--cwd "$PWD"` makes the worker location explicit. This matters when
the Herdr UI is focused on a different pane from the shell invoking the action.

The workflow appears in your Herdr sidebar as `<meta.name> · <run-id>`. To
resume the most recent journaled run:

```bash
herdr plugin action invoke herdrflow.engine.resume
```

Use `--run <run-id>` to select a specific run. Journal data lives in the
plugin state directory managed by Herdr.

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
- `machine` selects a configured computer by name or tag.

The runtime rejects options it cannot resolve. It does not silently ignore
them.

The bundled
[`herdr-workflow-authoring`](./skills/herdr-workflow-authoring/SKILL.md) skill
documents the full interface and links to runnable examples.

## Fleet setup

Without a fleet file, calls run on the local machine with the default agent
kind. To use multiple machines, copy
[`fleet.example.toml`](./skills/herdr-workflow-authoring/reference/fleet.example.toml),
edit it for your hosts, and pass it to the action:

```bash
herdr plugin action invoke herdrflow.engine.run -- \
  "$PWD/workflow.js" --cwd "$PWD" --fleet "$PWD/fleet.toml"
```

You can also place `fleet.toml` in the directory printed by:

```bash
herdr plugin config-dir herdrflow.engine
```

See [the fleet guide](./docs/fleet.md) for SSH setup, runtime routing, machine
selection, and current limitations.

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
journal replay, blocked-agent policies, per-machine concurrency limits, and
local worktree isolation. Remote worktree isolation and detached runs are not
implemented yet.

## Development

```bash
npm ci
npm test
npm run build
```

The test suite uses mock Herdr sockets and SSH transports. The runner was also
exercised with real Codex and Claude CLIs in Herdr panes,
including a two-machine run and a journal replay with no live agent calls.

Design decisions and known limitations are recorded in [`SPEC.md`](./SPEC.md).
Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](./LICENSE). The vendored engine retains the upstream
copyright notices from `pi-dynamic-workflows`.
