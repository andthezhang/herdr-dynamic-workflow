/**
 * Minimal JSON request/response client for a Herdr session socket
 * (node:net over a Unix domain socket; one JSON frame per line).
 *
 * TRANSPORT FACT (measured live against herdr 0.8.0, and explicit in the Rust
 * source — src/api/server.rs handle_connection reads ONE initial request line,
 * writes one response, and returns, closing the stream): the server serves
 * exactly ONE request per connection. Streaming methods (events.subscribe)
 * and wait-style methods (agent.prompt with `wait`) hold their connection
 * open until they finish, but a second request frame on the same connection
 * is never read. This client therefore opens a fresh connection per request,
 * exactly like the herdr CLI does. Concurrent requests simply ride separate
 * connections, which is also what makes an abort-teardown request usable
 * while a long agent.prompt wait is still in flight.
 *
 * Frames out: `{"id":"flow_1","method":"tab.create","params":{...}}\n`
 * Frames in:  `{"id":"flow_1","result":{...}}` or
 *             `{"id":"flow_1","error":{"code":"agent_pane_busy","message":"..."}}`
 *
 * The socket path is ALWAYS the one the caller constructed explicitly. This
 * module NEVER reads HERDR_SOCKET_PATH from the environment: inside a
 * Herdr-managed pane that variable is injected by Herdr and points at the
 * USER'S OWN host session (reference/herdr-runtime-support.md §7) — reading it
 * would silently drive the wrong session. The constructor therefore requires
 * an explicit `socketPath` and throws without one, even when the env var is
 * set.
 */
import net from "node:net";

/** Connection-level failure: could not connect, socket closed mid-request, bad frame. */
export class HerdrTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrTransportError";
  }
}

/**
 * A per-request timeout expired before the server answered. `name` is
 * "TimeoutError" so the engine's `wrapError` seam classifies an unhandled one
 * as AGENT_TIMEOUT (recoverable).
 */
export class HerdrRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`herdr request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** The server answered with an error frame; `code` is Herdr's error code verbatim. */
export class HerdrRpcError extends Error {
  readonly method: string;
  readonly code: string;
  readonly data?: unknown;
  constructor(method: string, code: string, message?: string, data?: unknown) {
    super(message ?? `herdr request "${method}" failed: ${code}`);
    this.name = "HerdrRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export interface HerdrSocketClientOptions {
  /** REQUIRED and explicit — never sourced from HERDR_SOCKET_PATH (see module doc). */
  socketPath: string;
  /** Default per-request timeout (ms). Default 30 000. */
  defaultTimeoutMs?: number;
}

export interface HerdrRequestOptions {
  /** Per-request timeout override (ms). <= 0 disables the timeout. */
  timeoutMs?: number;
  /** Abort rejects the pending request (the frame may still reach the server). */
  signal?: AbortSignal;
  /**
   * Called if a success reply arrives AFTER this request already rejected via
   * timeout/abort. Because the frame may already be at the server, a state-
   * creating request (tab.create) can succeed server-side while the client has
   * given up — this hook hands the caller the late result so it can release
   * that orphaned resource (e.g. close the tab) instead of leaking it. The
   * request's own connection is kept open to catch that reply (each request
   * has its own — see module doc). Late error replies are dropped. Never
   * called once the client is closed.
   */
  onLateResult?: (result: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class HerdrSocketClient {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  /** Every live per-request connection, so close() can sever them all. */
  private readonly sockets = new Set<net.Socket>();
  private nextId = 0;
  private closed = false;

  constructor(options: HerdrSocketClientOptions) {
    const socketPath = options?.socketPath;
    if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
      throw new TypeError(
        "HerdrSocketClient requires an explicit socketPath. Never take it from HERDR_SOCKET_PATH — " +
          "inside a Herdr pane that env var points at the user's own session, not the workflow session.",
      );
    }
    this.socketPath = socketPath;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Send one request on its own fresh connection and resolve its `result`
   * (or reject with a typed error). The connection is torn down when the
   * request settles — unless it settled via timeout/abort with an
   * `onLateResult` hook, in which case it stays open (until the reply, the
   * server closing it, or client close()) to catch the late reply.
   */
  async request(method: string, params: Record<string, unknown> = {}, options: HerdrRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new HerdrTransportError("herdr socket client is closed");
    if (options.signal?.aborted) throw new Error(`herdr request "${method}" aborted`);
    const id = `flow_${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const signal = options.signal;
      const socket = net.createConnection(this.socketPath);
      this.sockets.add(socket);
      socket.setEncoding("utf8");

      let buffer = "";
      let established = false;
      /** Reply consumed (settle or late-handler) — nothing more to read. */
      let answered = false;
      /** The promise settled; a further reply belongs to onLateResult (if any). */
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const destroy = (): void => {
        this.sockets.delete(socket);
        socket.destroy();
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void, keepOpenForLateReply = false): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!keepOpenForLateReply) destroy();
        fn();
      };
      const abandon = (error: Error): void => {
        // Timeout/abort: the frame may already be at the server. When the
        // caller registered onLateResult, keep THIS request's connection open
        // — the reply on it is the only place the id of any resource the
        // request created will ever appear.
        settle(() => reject(error), options.onLateResult !== undefined && !this.closed);
      };
      const onAbort = (): void => abandon(new Error(`herdr request "${method}" aborted`));

      if (timeoutMs > 0) {
        timer = setTimeout(() => abandon(new HerdrRequestTimeoutError(method, timeoutMs)), timeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const onReply = (frame: { id?: string; result?: unknown; error?: { code?: string; message?: string; data?: unknown } }): void => {
        answered = true;
        if (!settled) {
          settle(() => {
            if (frame.error !== undefined) {
              const code = typeof frame.error?.code === "string" ? frame.error.code : String(frame.error);
              reject(new HerdrRpcError(method, code, frame.error?.message, frame.error?.data));
            } else {
              resolve(frame.result);
            }
          });
          return;
        }
        // Late reply for an abandoned request: hand a success result to the
        // caller's cleanup hook; late errors are dropped by contract.
        destroy();
        if (frame.error === undefined && options.onLateResult && !this.closed) {
          try {
            options.onLateResult(frame.result);
          } catch {
            // Late-cleanup hooks are best-effort by contract.
          }
        }
      };

      socket.once("connect", () => {
        established = true;
        socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error && !settled) settle(() => reject(new HerdrTransportError(`herdr socket write failed: ${error.message}`)));
        });
      });
      socket.on("data", (chunk: string) => {
        if (answered) return; // One response per connection; ignore trailing noise.
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        if (!line) return;
        let frame: { id?: string; result?: unknown; error?: { code?: string; message?: string; data?: unknown } };
        try {
          frame = JSON.parse(line);
        } catch {
          if (!settled) settle(() => reject(new HerdrTransportError(`herdr response was not valid JSON for "${method}"`)));
          else destroy();
          return;
        }
        // The response id must be ours — except invalid_request errors, which
        // the server sends with an empty id.
        if (frame.id !== id && !(frame.error !== undefined && frame.id === "")) {
          if (!settled) settle(() => reject(new HerdrTransportError(`herdr response id mismatch for "${method}"`)));
          else destroy();
          return;
        }
        onReply(frame);
      });
      socket.on("error", (error: Error) => {
        if (!settled) {
          const reason = established
            ? `herdr socket error: ${error.message}`
            : `herdr socket connect failed (${this.socketPath}): ${error.message}`;
          settle(() => reject(new HerdrTransportError(reason)));
        } else {
          destroy();
        }
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        if (!settled && !answered) {
          settle(() => reject(new HerdrTransportError("herdr socket closed before the response arrived")));
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
  }
}
