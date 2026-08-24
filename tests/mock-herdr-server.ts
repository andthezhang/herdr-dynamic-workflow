/**
 * MockHerdrServer: a scriptable stand-in for a Herdr session socket, used by
 * the runner tests. Speaks the same newline-delimited JSON request/response
 * frames as the real server (`{"id","method","params"}` in, `{"id","result"}`
 * or `{"id","error":{"code","message"}}` out) over a Unix socket in a scratch
 * temp dir.
 *
 * TRANSPORT: mirrors the real server's one-request-per-connection contract
 * (herdr src/api/server.rs handle_connection reads a single request line,
 * writes one response, and closes the stream; measured live on 0.8.0). Only
 * the FIRST line of each connection is dispatched; the reply ends the
 * connection. A handler that never resolves keeps its connection open, like a
 * real long wait.
 *
 * Behavior is layered: per-method queued one-shot handlers (consumed first),
 * then a per-method override handler, then built-in happy defaults
 * (workspace.create / tab.create with env capture / tab.close /
 * workspace.close mirroring the D11 topology, agent.start, agent.prompt idle,
 * agent.send_keys, agent.get idle, agent.explain empty, agent.read empty,
 * pane.list). Result shapes mirror the real server's tagged ResponseResult
 * enum (herdr src/api/schema/response.rs, verified live against herdr 0.8.0):
 * workspace.create -> {type:"workspace_created", workspace, tab, root_pane},
 * tab.create -> {type:"tab_created", tab, root_pane}, closes -> {type:"ok"}.
 *
 * NOTE: sockets live under os.tmpdir() (not the session scratchpad) because
 * macOS caps sun_path at 104 bytes and the scratchpad path alone exceeds it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Throw from a handler to send an error frame with this Herdr error code. */
export class RpcFailure extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RpcFailure";
  }
}

export type MockHandler = (params: any, server: MockHerdrServer) => unknown | Promise<unknown>;

export interface RecordedCall {
  method: string;
  params: any;
  id: string;
}

export class MockHerdrServer {
  /** Every request received, in arrival order. */
  readonly calls: RecordedCall[] = [];
  /** The env object of every tab.create received, in order. */
  readonly tabEnvs: Array<Record<string, string>> = [];
  socketPath = "";

  private server: net.Server | undefined;
  private dir = "";
  private workspaceCounter = 0;
  /** Tab/pane counters mirror the real server: workspace.create mints the
   * workspace's root tab+pane (t1/p1), so the first tab.create yields t2/p2. */
  private tabCounter = 0;
  private paneCounter = 0;
  private readonly overrides = new Map<string, MockHandler>();
  private readonly queues = new Map<string, MockHandler[]>();
  private readonly sockets = new Set<net.Socket>();

  static async start(): Promise<MockHerdrServer> {
    const server = new MockHerdrServer();
    server.dir = mkdtempSync(path.join(os.tmpdir(), "herdr-mock-"));
    server.socketPath = path.join(server.dir, "herdr.sock");
    server.server = net.createServer((socket) => server.attach(socket));
    await new Promise<void>((resolve, reject) => {
      server.server!.once("error", reject);
      server.server!.listen(server.socketPath, () => resolve());
    });
    return server;
  }

  /** Replace the handler for a method (after any queued one-shots drain). */
  on(method: string, handler: MockHandler): this {
    this.overrides.set(method, handler);
    return this;
  }

  /** Push one-shot handlers for a method; each is consumed by one request. */
  queueResponses(method: string, ...handlers: MockHandler[]): this {
    const queue = this.queues.get(method) ?? [];
    queue.push(...handlers);
    this.queues.set(method, queue);
    return this;
  }

  /** Convenience: a handler that fails with a Herdr error code. */
  static fail(code: string, message?: string): MockHandler {
    return () => {
      throw new RpcFailure(code, message);
    };
  }

  callsFor(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  get lastTabEnv(): Record<string, string> | undefined {
    return this.tabEnvs[this.tabEnvs.length - 1];
  }

  /** Real-shaped TabInfo (herdr src/api/schema/tabs.rs), minted for a tab.create. */
  makeTab(workspaceId: string, tabId: string, label: unknown, focus: unknown): Record<string, unknown> {
    return {
      tab_id: tabId,
      workspace_id: workspaceId,
      number: this.tabCounter,
      label: typeof label === "string" ? label : String(this.tabCounter),
      focused: focus === true,
      pane_count: 1,
      agent_status: "unknown",
    };
  }

  /**
   * Real-shaped AgentInfo subset (herdr src/api/schema/agents.rs). The status
   * field is `agent_status` (never `status`); a live agent is ready when it is
   * settled AND `interactive_ready` — the readiness-poll contract.
   */
  makeAgentInfo(name: unknown, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      terminal_id: "term_mock_agent",
      ...(typeof name === "string" ? { name } : {}),
      agent_status: status,
      workspace_id: "w1",
      tab_id: "w1:t2",
      pane_id: "w1:p2",
      focused: false,
      interactive_ready: true,
      state_change_seq: 0,
      revision: 0,
      ...extra,
    };
  }

  /** Real-shaped PaneInfo subset (herdr src/api/schema/panes.rs), minted for a root pane. */
  makePane(workspaceId: string, tabId: string, paneId: string, cwd: unknown, focus: unknown): Record<string, unknown> {
    return {
      pane_id: paneId,
      tab_id: tabId,
      workspace_id: workspaceId,
      terminal_id: `term_mock_${paneId.replace(/\W/g, "_")}`,
      cwd: typeof cwd === "string" ? cwd : "/",
      foreground_cwd: typeof cwd === "string" ? cwd : "/",
      focused: focus === true,
      agent_status: "unknown",
      revision: 0,
      scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 23 },
    };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  private attach(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let dispatched = false;
    socket.on("data", (chunk: string) => {
      // One request per connection, like the real server: only the first
      // complete line is ever read; anything after it is never dispatched.
      if (dispatched) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      if (!line.trim()) return;
      dispatched = true;
      void this.handleLine(socket, line);
    });
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let frame: { id: string; method: string; params?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    this.calls.push({ method: frame.method, params: frame.params, id: frame.id });
    const handler =
      this.queues.get(frame.method)?.shift() ?? this.overrides.get(frame.method) ?? this.defaultHandler(frame.method);
    try {
      if (!handler) throw new RpcFailure("unknown_method", `no handler for ${frame.method}`);
      const result = (await handler(frame.params, this)) ?? {};
      this.reply(socket, { id: frame.id, result });
    } catch (error) {
      const failure =
        error instanceof RpcFailure ? error : new RpcFailure("internal_error", error instanceof Error ? error.message : String(error));
      this.reply(socket, { id: frame.id, error: { code: failure.code, message: failure.message } });
    }
  }

  private reply(socket: net.Socket, frame: unknown): void {
    // Write the response and close the connection, like the real server.
    if (!socket.destroyed) socket.end(`${JSON.stringify(frame)}\n`);
  }

  private defaultHandler(method: string): MockHandler | undefined {
    switch (method) {
      case "workspace.create": {
        // Mirrors the real server: creating a workspace also mints its root
        // tab and root pane (measured live; ResponseResult::WorkspaceCreated).
        return (params) => {
          const workspaceId = `w${++this.workspaceCounter}`;
          const tabId = `${workspaceId}:t${++this.tabCounter}`;
          const paneId = `${workspaceId}:p${++this.paneCounter}`;
          return {
            type: "workspace_created",
            workspace: {
              workspace_id: workspaceId,
              number: this.workspaceCounter,
              label: typeof params?.label === "string" ? params.label : String(this.workspaceCounter),
              focused: params?.focus === true,
              pane_count: 1,
              tab_count: 1,
              active_tab_id: tabId,
              agent_status: "unknown",
            },
            tab: this.makeTab(workspaceId, tabId, undefined, params?.focus),
            root_pane: this.makePane(workspaceId, tabId, paneId, params?.cwd, params?.focus),
          };
        };
      }
      case "tab.create":
        return (params) => {
          this.tabEnvs.push({ ...(params?.env ?? {}) });
          const workspaceId = typeof params?.workspace_id === "string" ? params.workspace_id : "w1";
          const tabId = `${workspaceId}:t${++this.tabCounter}`;
          const paneId = `${workspaceId}:p${++this.paneCounter}`;
          return {
            type: "tab_created",
            tab: this.makeTab(workspaceId, tabId, params?.label, params?.focus),
            root_pane: this.makePane(workspaceId, tabId, paneId, params?.cwd, params?.focus),
          };
        };
      case "tab.close":
      case "workspace.close":
        return () => ({ type: "ok" });
      case "pane.list":
        return () => ({ type: "pane_list", panes: [] });
      case "agent.start":
        // Real agent.start returns immediately with a launch-pending agent;
        // readiness comes from the agent.get poll, never from this response.
        return (params) => ({
          type: "agent_started",
          agent: this.makeAgentInfo(params?.name, "working", { launch_pending: true, interactive_ready: false }),
          argv: [String(params?.kind ?? "agent")],
        });
      case "agent.prompt":
        // Default agent settles idle but writes nothing — the
        // missing-output-file scenario.
        return (params) => ({ type: "agent_prompted", agent: this.makeAgentInfo(params?.target, "idle") });
      case "agent.send_keys":
        return () => ({ type: "ok" });
      case "agent.get":
        // Default: detected, interactive, genuinely settled — satisfies both
        // the post-start readiness poll and the harvest re-check.
        return (params) => ({ type: "agent_info", agent: this.makeAgentInfo(params?.target, "idle") });
      case "agent.wait":
        // Real shape: agent_wait_success -> ResponseResult::AgentInfo.
        return (params) => ({ type: "agent_info", agent: this.makeAgentInfo(params?.target, "done") });
      case "agent.explain":
        return () => ({ type: "agent_explain", explain: { status: "idle", evaluated_rules: [] } });
      case "agent.read":
        return (params) => ({
          type: "pane_read",
          read: {
            pane_id: "w1:p2",
            workspace_id: "w1",
            tab_id: "w1:t2",
            source: String(params?.source ?? "visible"),
            format: "text",
            text: "",
            revision: 0,
            truncated: false,
          },
        });
      default:
        return undefined;
    }
  }
}
