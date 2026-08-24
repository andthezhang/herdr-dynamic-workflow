/**
 * Shared plumbing for the plugin action entry points (run/resume):
 * state-dir resolution, worker-session socket path construction, and the
 * persisted journal document format under `<stateDir>/runs/<runId>.json`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { JournalEntry } from "../index.js";

/**
 * Herdr's own config dir, mirrored exactly for the platforms the plugin
 * supports (linux/macos — herdr src/config/io.rs config_dir):
 * $XDG_CONFIG_HOME/herdr when set, else ~/.config/herdr. Everything that
 * computes a path herdr also computes (session sockets) MUST go through this —
 * hardcoding ~/.config silently diverges from a herdr running with
 * XDG_CONFIG_HOME set. (Per the XDG spec an empty value counts as unset.)
 */
export function herdrConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "herdr");
  return path.join(os.homedir(), ".config", "herdr");
}

/**
 * Where run state lives. Inside a Herdr plugin invocation this is the injected
 * HERDR_PLUGIN_STATE_DIR; standalone it falls back to a stable per-user dir.
 */
export function resolveStateDir(): string {
  const injected = process.env.HERDR_PLUGIN_STATE_DIR;
  if (injected && injected.trim() !== "") return injected;
  return path.join(os.homedir(), ".local", "state", "herdr-dynamic-workflow");
}

/**
 * Working directory of the Herdr workspace/pane that invoked this action.
 * Plugin commands themselves run from HERDR_PLUGIN_ROOT, so using process.cwd()
 * would send workflow agents into the plugin's checkout. Standalone entry-point
 * execution has no injected context and keeps its shell cwd.
 */
export function resolveInvocationCwd(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = process.cwd(),
): string {
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return fallback;
  try {
    const context = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["focused_pane_cwd", "workspace_cwd"]) {
      const value = context[key];
      if (typeof value === "string" && value.trim() !== "") return path.resolve(value);
    }
  } catch {
    // A malformed host context must not break standalone-compatible execution.
  }
  return fallback;
}

/**
 * Socket path of the WORKER session the runner should drive. Computed from
 * the session name via herdrConfigDir (which honors XDG_CONFIG_HOME exactly
 * as herdr does — a hardcoded ~/.config would autostart servers on sockets
 * the poller never checks), never taken from HERDR_SOCKET_PATH — inside a
 * Herdr pane that variable points at the user's own host session (§7).
 */
export function sessionSocketPath(sessionName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(herdrConfigDir(env), "sessions", sessionName, "herdr.sock");
}

/**
 * The user's own (default) session socket — the zero-config placement target
 * that puts the run's workspace live in the user's sidebar instead of a
 * hidden worker session. Computed (XDG-aware, like herdr itself), never read
 * from HERDR_SOCKET_PATH (the D11/§7 rule stands: library code must not
 * inherit the injected socket, and this path IS that session's socket by
 * construction).
 */
export function defaultSessionSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(herdrConfigDir(env), "herdr.sock");
}

/** The hidden worker session used when the user's own session is unreachable. */
export const DEFAULT_WORKER_SESSION = "flow";

/**
 * Which session a run's LOCAL placement targeted:
 * - "default": the user's own session — its workspace shows in their sidebar.
 * - "worker": a named worker session (the "flow" fallback or an explicit
 *   --session), autostarted when its server is not running.
 * ssh hosts are unaffected either way: they always use the named worker
 * session (never another host's personal session).
 */
export type SessionMode = "default" | "worker";

/** The resolved local placement target for a run (or a resume of one). */
export interface ResolvedSessionTarget {
  /**
   * Worker session NAME — what ssh hosts are driven under and what
   * attach commands print. Stays "flow" (or the explicit --session value)
   * even in "default" mode; it is never the string "default".
   */
  session: string;
  /** LOCAL socket the runner drives. */
  socketPath: string;
  mode: SessionMode;
}

/** True when a Unix socket exists AND accepts a connection (not just a stale file). */
export function probeUnixSocket(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Start a headless server for a worker session, detached so it outlives this
 * process. The binary comes from HERDR_BIN_PATH (Herdr injects it for plugin
 * invocations) else PATH's `herdr`.
 */
export function spawnSessionServer(session: string, env: NodeJS.ProcessEnv = process.env): void {
  const bin = env.HERDR_BIN_PATH?.trim() || "herdr";
  const child = spawn(bin, ["--session", session, "server"], { detached: true, stdio: "ignore", env });
  // A missing binary surfaces as the autostart timeout below, never a crash.
  child.on("error", () => {});
  child.unref();
}

/** Test seams and tuning for resolveSessionTarget. */
export interface ResolveSessionDeps {
  probe?: (socketPath: string) => Promise<boolean>;
  spawnServer?: (session: string) => void;
  /** How long to wait for an autostarted server's socket (ms). Default 10 000. */
  autostartTimeoutMs?: number;
  /** Initial poll delay while waiting for the autostarted socket (ms). Default 100. */
  pollMs?: number;
}

/**
 * Resolve where a run's LOCAL placement goes — the zero-config default:
 *
 * 1. An explicit --session always wins and targets that named worker session.
 * 2. Otherwise, when `preferDefault` (the default), the user's OWN session is
 *    probed first: socket exists and connects -> the run lands there, live in
 *    their sidebar ("default" mode).
 * 3. Otherwise the named worker session ("flow" unless a resume carries
 *    another name), AUTOSTARTING its headless server when the socket is not
 *    connectable and waiting for it with bounded backoff (~10s).
 *
 * Resume passes `preferDefault: doc.sessionMode === "default"` so a resumed
 * run goes back to the same place it started in.
 */
export async function resolveSessionTarget(
  options: { explicitSession?: string; workerSession?: string; preferDefault?: boolean } = {},
  deps: ResolveSessionDeps = {},
): Promise<ResolvedSessionTarget> {
  const probe = deps.probe ?? probeUnixSocket;
  const spawnServer = deps.spawnServer ?? spawnSessionServer;
  const autostartTimeoutMs = deps.autostartTimeoutMs ?? 10_000;
  const pollMs = deps.pollMs ?? 100;
  const worker = options.explicitSession?.trim() || options.workerSession?.trim() || DEFAULT_WORKER_SESSION;
  // Herdr reserves the session NAME "default" for the user's own root session
  // (herdr src/session.rs normalize_name -> the ~/.config/herdr/herdr.sock
  // socket, NOT sessions/default/). Accepting it as a worker name would poll
  // a socket herdr never creates while `herdr --session default server`
  // squats on the user's personal session — and over ssh it would drive
  // ANOTHER host's default session, the invariant this resolution exists
  // to make impossible. Reject it up front with the zero-config answer.
  if (worker === "default") {
    throw new Error(
      'session name "default" is reserved by herdr for the user\'s own session and cannot name a ' +
        "worker session. Omit --session to run in the user's own session (the zero-config default), " +
        "or pick another name.",
    );
  }

  if (!options.explicitSession?.trim() && options.preferDefault !== false) {
    const own = defaultSessionSocketPath();
    if (await probe(own)) return { session: worker, socketPath: own, mode: "default" };
  }

  const socketPath = sessionSocketPath(worker);
  if (await probe(socketPath)) return { session: worker, socketPath, mode: "worker" };
  // Autostart covers a missing socket AND a stale one (file present, server
  // gone): either way the probe failed and only a fresh server fixes it.
  spawnServer(worker);
  const deadline = Date.now() + autostartTimeoutMs;
  let delay = pollMs;
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - Date.now()))));
    if (await probe(socketPath)) return { session: worker, socketPath, mode: "worker" };
    if (Date.now() >= deadline) {
      throw new Error(
        `worker session "${worker}" server did not come up within ${autostartTimeoutMs}ms ` +
          `(socket ${socketPath}). Start it yourself with: herdr --session ${worker} server`,
      );
    }
    delay = Math.min(delay * 2, 2000);
  }
}

/**
 * The JSON envelope run.js/resume.js print on success. Deliberately NO
 * tokenUsage: herdr has no token signal for a PTY agent (§8) — reporting
 * zeros would be a lie. agentCount + durationMs are the honest measures.
 */
export function successEnvelope(
  runId: string,
  outcome: {
    runId?: string;
    meta: { name: string };
    result: unknown;
    phases: string[];
    agentCount: number;
    durationMs: number;
  },
  extra: { resumed?: boolean; workspace?: string; kept?: boolean } = {},
): Record<string, unknown> {
  return {
    ok: true,
    runId: outcome.runId ?? runId,
    ...(extra.resumed ? { resumed: true } : {}),
    workflow: outcome.meta.name,
    result: outcome.result,
    phases: outcome.phases,
    agentCount: outcome.agentCount,
    durationMs: outcome.durationMs,
    ...(extra.workspace ? { workspace: extra.workspace } : {}),
    ...(extra.kept ? { kept: true } : {}),
  };
}

/** Persisted journal document: enough to resume without re-supplying the script. */
export interface JournalDocument {
  version: 1;
  runId: string;
  /** Worker session name the run was started against (resume default). */
  session: string;
  /**
   * Where the run's LOCAL placement went ("default" = the user's own sidebar
   * session, "worker" = the named worker session), so resume goes back to the
   * same place. Absent in pre-mode journals, which were always "worker".
   */
  sessionMode?: SessionMode;
  /** Default agent kind the run was started with. */
  kind: string;
  /** Working directory inherited by workflow calls and reused on resume. */
  cwd?: string;
  /** Full workflow script text, so resume replays exactly what ran. */
  script: string;
  /** Invoke `args`, restored on resume when the new call omits them. */
  args?: unknown;
  /** Sidebar label (`meta.name · last-4-of-runId`). */
  workspaceLabel?: string;
  entries: JournalEntry[];
}

export function journalPath(stateDir: string, runId: string): string {
  return path.join(stateDir, "runs", `${runId}.json`);
}

/** Synchronous write so the journal is durable even if the process dies next tick. */
export function saveJournal(stateDir: string, doc: JournalDocument): void {
  const file = journalPath(stateDir, doc.runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

/**
 * The most recently WRITTEN run journal's id, or undefined when none exist —
 * "last run" for the manifest's argument-less "Resume last run" action.
 * Recency is journal-file mtime: the
 * journal is re-saved after every agent
 * call, so mtime tracks last activity, not just creation.
 */
export function latestRunId(stateDir: string): string | undefined {
  const dir = path.join(stateDir, "runs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { runId: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue; // Deleted between readdir and stat.
    }
    if (!best || mtimeMs > best.mtimeMs) best = { runId: name.slice(0, -".json".length), mtimeMs };
  }
  return best?.runId;
}

export function loadJournal(stateDir: string, runId: string): JournalDocument {
  const raw = readFileSync(journalPath(stateDir, runId), "utf8");
  const doc = JSON.parse(raw) as JournalDocument;
  if (doc.version !== 1 || typeof doc.script !== "string" || !Array.isArray(doc.entries)) {
    throw new Error(`journal ${journalPath(stateDir, runId)} is not a v1 journal document`);
  }
  return doc;
}

/**
 * The engine's journal/store key format for one agent call: `${runId}:${index}`
 * (see workflow.ts deltaKey). Entries written before JournalEntry.runId existed
 * fall back to the document's own runId.
 */
export function journalEntryKey(entry: JournalEntry, doc: JournalDocument): string {
  return `${entry.runId ?? doc.runId}:${entry.index}`;
}

/** Rebuild the resume map with the engine's `${runId}:${index}` key format. */
export function toResumeMap(doc: JournalDocument): Map<string, JournalEntry> {
  return new Map(doc.entries.map((entry) => [journalEntryKey(entry, doc), entry]));
}

/**
 * Insert or replace one journaled agent entry, keyed the same way as
 * toResumeMap. Replace-not-duplicate matters on resume: live (non-replayed)
 * agents re-journal calls the document already carries, and a duplicate would
 * make the next resume's Map construction keep whichever entry happens to come
 * last.
 */
export function upsertJournalEntry(doc: JournalDocument, entry: JournalEntry): void {
  const key = journalEntryKey(entry, doc);
  const at = doc.entries.findIndex((existing) => journalEntryKey(existing, doc) === key);
  if (at >= 0) doc.entries[at] = entry;
  else doc.entries.push(entry);
}

/**
 * Sidebar workspace name: meta.name, then last-4 of the run id so concurrent
 * runs of the same workflow stay tellable apart.
 */
export function formatWorkspaceLabel(name: string, runId: string): string {
  const prefix = name.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim() || "workflow";
  return `${prefix} · ${runId.slice(-4)}`;
}

/** Minimal flag parser: positionals plus `--name value` options. */
export function parseArgs(
  argv: string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      flags.set(name, value);
      i++;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function newRunId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `wf_${stamp}-${rand}`;
}
