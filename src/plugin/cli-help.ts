/** CLI help. Short, like browser-use. */

export const CLI_HELP = `\
herdr-dynamic-workflow - any agent, here or over ssh

Typical usage:
  herdr-dynamic-workflow <<'JSON'
  { "scriptPath": "hello.js", "args": { "pr": 412 } }
  JSON

If you don't have the skill already:
  herdr-dynamic-workflow skill

Fields: script, scriptPath, name, args, resumeFromRunId
        kind, session, cwd

Example (hello.js):
  export const meta = { name: "hello", description: "One agent answers" }
  return { answer: await agent("What port does Herdr listen on?") }
`;

export const INVOKE_USAGE = `\
herdr-dynamic-workflow received no JSON. Pipe the invoke object on stdin:
  herdr-dynamic-workflow <<'JSON'
  { "scriptPath": "workflow.js" }
  JSON
`;
