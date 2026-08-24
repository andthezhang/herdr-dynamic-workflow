// Hello-world for herdr-dynamic-workflow: two agents in sequence, each running
// as a real coding-agent CLI in its own Herdr pane. `kind` picks the CLI.
//
//   herdr-dynamic-workflow '{"scriptPath":"skills/herdr-workflow-authoring/reference/hello-workflow.js"}'

export const meta = {
  name: "hello_workflow",
  description: "One agent invents a haiku topic, a second agent writes the haiku",
  phases: [{ title: "Topic" }, { title: "Haiku" }],
};

phase("Topic");

const topic = await agent(
  "Pick one evocative, concrete topic for a haiku about software. " +
    "Reply with the topic only — a short noun phrase, no explanation.",
  {
    kind: "codex",
    label: "pick-topic",
    schema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
);

// A dead agent resolves to null; fall back rather than crash the run.
const chosen = (topic && topic.topic) || "a flaky test";
log(`topic: ${chosen}`);

phase("Haiku");

const poem = await agent(`Write a single haiku (5-7-5) about: ${chosen}. Reply with the haiku only.`, {
  kind: "codex",
  label: "write-haiku",
});

return { topic: chosen, haiku: poem };
