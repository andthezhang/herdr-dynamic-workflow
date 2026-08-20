// Fleet hello-world: the same workflow drives one agent on the local machine
// and one on a remote fleet machine, placed explicitly by name (SPEC D12/D13).
//
//   herdr plugin action invoke herdrflow.engine.run -- "$PWD/skills/herdr-workflow-authoring/reference/fleet-hello.js" \
//     --cwd "$PWD" --fleet "$PWD/skills/herdr-workflow-authoring/reference/fleet.example.toml"

export const meta = {
  name: "fleet_hello",
  description: "One agent answers locally, a second answers from a remote fleet machine",
  model: "gpt-5.6-luna",
  phases: [{ title: "Local" }, { title: "Remote" }],
};

phase("Local");

const local = await agent(
  "State one true, well-known fact about the ARM64 CPU architecture, in one sentence.",
  {
    kind: "codex",
    machine: "local",
    label: "local-fact",
    schema: {
      type: "object",
      properties: { fact: { type: "string" } },
      required: ["fact"],
    },
  },
);

log(`local fact: ${local && local.fact}`);

phase("Remote");

// The prompt asks for the machine's hostname so the run's output proves the
// call really executed on the remote machine, not locally.
const remote = await agent(
  "Run the `hostname` shell command and report its exact output.",
  {
    kind: "codex",
    machine: "build-mac",
    label: "remote-hostname",
    schema: {
      type: "object",
      properties: { hostname: { type: "string" } },
      required: ["hostname"],
    },
  },
);

log(`remote hostname: ${remote && remote.hostname}`);

return { local, remote };
