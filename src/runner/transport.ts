/**
 * HerdrTransport: the seam between the runner and one MACHINE's Herdr session
 * (SPEC D12/D13). A transport is "everything the runner needs from the host a
 * pane lives on": the Herdr request/response channel plus the few file
 * operations the output-file contract needs on that same host (the agent
 * writes HERDR_FLOW_OUT on ITS machine, so the harvest read — and the schema
 * write — must happen wherever the pane is, never on the engine's own
 * filesystem; SPEC Q11).
 *
 * Implementations:
 * - LocalHerdrTransport (here): the NDJSON socket client + node:fs. Exactly
 *   the pre-M3 behavior, factored behind the seam.
 * - SshHerdrTransport (ssh-transport.ts): plain `herdr` CLI over ssh at the
 *   machine's declared absolute binary path (SPEC D13).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HerdrSocketClient, type HerdrRequestOptions } from "./socket.js";

/** Per-request options, shared by every transport (see HerdrRequestOptions). */
export type HerdrTransportRequestOptions = HerdrRequestOptions;

export interface HerdrTransport {
  /**
   * Send one Herdr request and resolve its `result` (or reject with
   * HerdrRpcError / HerdrTransportError / a TimeoutError-named error —
   * identical taxonomy across transports so the runner maps failures the
   * same way wherever the pane lives).
   */
  request(method: string, params?: Record<string, unknown>, options?: HerdrTransportRequestOptions): Promise<unknown>;
  /**
   * Read a text file ON THE TRANSPORT'S MACHINE. Resolves undefined when the
   * file is missing or unreadable (the harvest poll treats both as
   * "not there yet"); never rejects for a missing file.
   */
  readTextFile(filePath: string): Promise<string | undefined>;
  /** Write a text file on the transport's machine, creating parent directories. */
  writeTextFile(filePath: string, content: string): Promise<void>;
  /** Ensure a directory exists on the transport's machine (mkdir -p). */
  ensureDir(dirPath: string): Promise<void>;
  /** Release the transport's resources (sockets / control connections). Idempotent. */
  close(): Promise<void> | void;
}

export interface LocalHerdrTransportOptions {
  /** REQUIRED and explicit — never sourced from HERDR_SOCKET_PATH (reference §7). */
  socketPath: string;
  /** Default per-request timeout (ms). Default 30 000. */
  defaultTimeoutMs?: number;
}

/** The local machine: Herdr over its Unix socket, files over node:fs. */
export class LocalHerdrTransport implements HerdrTransport {
  private readonly client: HerdrSocketClient;

  constructor(options: LocalHerdrTransportOptions) {
    this.client = new HerdrSocketClient({
      socketPath: options.socketPath,
      ...(options.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
    });
  }

  request(method: string, params: Record<string, unknown> = {}, options: HerdrTransportRequestOptions = {}): Promise<unknown> {
    return this.client.request(method, params, options);
  }

  async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  async ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  close(): void {
    this.client.close();
  }
}
