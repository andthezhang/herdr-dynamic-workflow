/**
 * Tests for the NDJSON Unix-socket client (src/runner/socket.ts): id-matched
 * request/response, out-of-order settlement, typed RPC errors, per-request
 * timeouts, transport failure, abort, and — the reference-doc §7 trap — that
 * the socket path is ONLY ever the explicitly constructed one, never
 * HERDR_SOCKET_PATH from the environment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HerdrRequestTimeoutError,
  HerdrRpcError,
  HerdrSocketClient,
  HerdrTransportError,
} from "../src/runner/socket.js";
import { MockHerdrServer } from "./mock-herdr-server.js";

test("request/response round trip resolves the result payload", async () => {
  const server = await MockHerdrServer.start();
  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    const result = (await client.request("pane.list", {})) as { type: string; panes: unknown[] };
    assert.deepEqual(result, { type: "pane_list", panes: [] });
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0]!.method, "pane.list");
    assert.ok(server.calls[0]!.id, "frames carry a request id");
  } finally {
    client.close();
    await server.close();
  }
});

test("concurrent requests settle by id even when responses arrive out of order", async () => {
  const server = await MockHerdrServer.start();
  let releaseSlow!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  server.on("slow.op", async () => {
    await gate;
    return { which: "slow" };
  });
  server.on("fast.op", () => ({ which: "fast" }));

  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    const slow = client.request("slow.op", {});
    const fast = await client.request("fast.op", {});
    assert.deepEqual(fast, { which: "fast" }, "fast response resolves while slow is still pending");
    releaseSlow();
    assert.deepEqual(await slow, { which: "slow" });
  } finally {
    client.close();
    await server.close();
  }
});

test("server error frames reject with HerdrRpcError carrying the code", async () => {
  const server = await MockHerdrServer.start();
  server.on("agent.start", MockHerdrServer.fail("agent_pane_busy", "pane w1:p2 is busy"));
  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    await assert.rejects(client.request("agent.start", { name: "flow-x-0" }), (error: unknown) => {
      assert.ok(error instanceof HerdrRpcError);
      assert.equal(error.code, "agent_pane_busy");
      assert.match(error.message, /busy/);
      return true;
    });
  } finally {
    client.close();
    await server.close();
  }
});

test("per-request timeout rejects with a timeout error and ignores a late response", async () => {
  const server = await MockHerdrServer.start();
  let releaseLate!: () => void;
  server.on("agent.prompt", async () => {
    await new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    return { status: "idle" };
  });
  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    await assert.rejects(client.request("agent.prompt", {}, { timeoutMs: 40 }), (error: unknown) => {
      assert.ok(error instanceof HerdrRequestTimeoutError);
      assert.equal(error.name, "TimeoutError", "named so the engine's wrapError classifies it as AGENT_TIMEOUT");
      assert.match(error.message, /timeout|timed out/i);
      return true;
    });
    // The late response for the timed-out id must not corrupt a later request.
    releaseLate();
    const ok = await client.request("pane.list", {});
    assert.deepEqual(ok, { type: "pane_list", panes: [] });
  } finally {
    client.close();
    await server.close();
  }
});

test("an abort signal rejects the pending request", async () => {
  const server = await MockHerdrServer.start();
  server.on("agent.prompt", () => new Promise(() => {}));
  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    const controller = new AbortController();
    const pending = client.request("agent.prompt", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /abort/i);
      return true;
    });
  } finally {
    client.close();
    await server.close();
  }
});

test("transport failure (server gone) rejects pending requests with a transport error", async () => {
  const server = await MockHerdrServer.start();
  server.on("agent.prompt", () => new Promise(() => {}));
  const client = new HerdrSocketClient({ socketPath: server.socketPath });
  try {
    const pending = client.request("agent.prompt", {});
    // Ensure the request is in flight before killing the server.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await server.close();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof HerdrTransportError);
      return true;
    });
  } finally {
    client.close();
    await server.close().catch(() => {});
  }
});

test("the client NEVER reads HERDR_SOCKET_PATH from the environment", async () => {
  // Two live servers: the env var points at the "user's own session" (the §7
  // trap); the explicit constructor path points at the flow session. Every
  // frame must land on the explicit one.
  const trapServer = await MockHerdrServer.start();
  const flowServer = await MockHerdrServer.start();
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = trapServer.socketPath;
  const client = new HerdrSocketClient({ socketPath: flowServer.socketPath });
  try {
    await client.request("pane.list", {});
    assert.equal(flowServer.calls.length, 1, "explicit path received the request");
    assert.equal(trapServer.calls.length, 0, "env-injected path received nothing");
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
    client.close();
    await trapServer.close();
    await flowServer.close();
  }
});

test("constructing without an explicit socketPath throws even when the env var is set", async () => {
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/tmp/should-never-be-used.sock";
  try {
    assert.throws(
      () => new HerdrSocketClient({ socketPath: undefined as unknown as string }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /explicit/i);
        return true;
      },
    );
    assert.throws(() => new HerdrSocketClient({ socketPath: "   " }), TypeError);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
  }
});
