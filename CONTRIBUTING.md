# Contributing

Herdr Dynamic Workflow is small by design. Changes should keep the workflow
language independent of any one coding-agent CLI and keep Herdr-specific code
inside `src/runner` and `src/plugin`.

## Set up the checkout

```bash
npm ci
npm test
npm run build
```

The test command type-checks both source and tests, then runs the full Node test
suite. Add or update tests for behavior changes.

## Test with Herdr

Unit tests use mock sockets and SSH transports. Changes to plugin actions,
agent lifecycle handling, pane placement, SSH execution, or output harvesting
also need a real Herdr run before release.

Build and link the checkout:

```bash
npm run build
herdr plugin link .
herdr plugin action list --plugin herdrflow.engine
```

Run a workflow from a disposable test repository. Confirm that the worker pane
appears in Herdr, the result file is harvested, and the workspace is cleaned up
when the run finishes. For SSH changes, test both a successful remote call and
a failed connection.

## Pull requests

Keep pull requests focused. Include:

- the behavior being changed
- the tests run
- any real Herdr or SSH validation performed
- user-visible limitations that remain

Do not commit `dist`, `node_modules`, credentials, real ssh hostnames, or
host-specific home-directory paths.
