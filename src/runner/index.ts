/**
 * Public surface of the Herdr runner: the WorkflowAgentRunner backend that
 * executes agent() calls in real Herdr panes, its NDJSON socket client, and
 * the §6 output-file contract.
 */
export {
  buildEnv,
  buildRemoteEnv,
  coerceAndValidate,
  OUTPUT_CONTRACT_PREAMBLE,
  OutputFileMissingError,
  parseOutputPayload,
  validateOutputPayload,
  type FlowCallEnv,
} from "./contract.js";
export {
  assertWaitableKind,
  buildStartArgs,
  DEFAULT_KIND,
  DEFAULT_REMOTE_STATE_DIR,
  HERDR_BLOCKED,
  HerdrAgentRunner,
  HerdrWorkflowError,
  UNWAITABLE_KINDS,
  type HerdrAgentRunnerOptions,
} from "./herdr-runner.js";
export {
  HerdrRequestTimeoutError,
  HerdrRpcError,
  HerdrSocketClient,
  HerdrTransportError,
  type HerdrRequestOptions,
  type HerdrSocketClientOptions,
} from "./socket.js";
export {
  buildHerdrCliArgs,
  createDefaultSshExec,
  shellQuote,
  SshHerdrTransport,
  type SshExecFn,
  type SshExecRequest,
  type SshExecResult,
  type SshHerdrTransportOptions,
} from "./ssh-transport.js";
export {
  LocalHerdrTransport,
  type HerdrTransport,
  type HerdrTransportRequestOptions,
  type LocalHerdrTransportOptions,
} from "./transport.js";
