// Same workflow, two computers: one agent here, one on the ssh host named by
// `ssh` (an alias from ~/.ssh/config, or user@host). No inventory file.
//
//   herdr-dynamic-workflow '{"scriptPath":"skills/herdr-workflow-authoring/reference/ssh-hello.js"}'

export const meta = {
  name: "ssh_hello",
  description: "One agent answers on this computer, a second answers on an ssh host",
  phases: [{ title: "Here" }, { title: "Over ssh" }],
};

phase("Here");

const here = await agent(
  "State one true, well-known fact about the ARM64 CPU architecture, in one sentence.",
  {
    kind: "codex",
    label: "local-fact",
    schema: {
      type: "object",
      properties: { fact: { type: "string" } },
      required: ["fact"],
    },
  },
);

log(`local fact: ${here && here.fact}`);

phase("Over ssh");

// The prompt asks for the host's hostname so the run's output proves the call
// really executed over there, not here.
const there = await agent(
  "Run the `hostname` shell command and report its exact output.",
  {
    kind: "codex",
    ssh: "build-mac",
    label: "remote-hostname",
    schema: {
      type: "object",
      properties: { hostname: { type: "string" } },
      required: ["hostname"],
    },
  },
);

log(`remote hostname: ${there && there.hostname}`);

return { here, there };
