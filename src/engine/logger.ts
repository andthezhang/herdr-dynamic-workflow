/**
 * Minimal workflow logger.
 *
 * Adapted from pi-dynamic-workflows v3.5.1 (MIT), with pi's workflow-paths
 * coupling removed: log persistence writes under a caller-supplied state
 * directory, and is a no-op when none is supplied.
 * Copyright (c) 2026 QuintinShaw
 * Copyright (c) Michael Livs (original pi-dynamic-workflows)
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  /** Flush the accumulated log to disk; returns the file path, or null when not persisting. */
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID used to name the log file. */
  runId?: string;
  /**
   * Directory to write `<runId>.log` under. When omitted, persistence is a
   * no-op — the engine never invents its own on-disk layout.
   */
  stateDir?: string;
  /** Whether to persist logs to disk (requires stateDir). Default: true. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const logs: string[] = [];
  const persistLogs = (options.persist ?? true) && typeof options.stateDir === "string" && options.stateDir.length > 0;
  const runId = options.runId ?? "run";
  let logFile: string | null = null;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    logs.push(entry);
    options.onLog?.(message);

    if (persistLogs && logFile) {
      try {
        appendFileSync(logFile, `${entry}\n`);
      } catch {
        // Silent fail for log persistence
      }
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs || !options.stateDir) return null;
      try {
        mkdirSync(options.stateDir, { recursive: true });
        logFile = join(options.stateDir, `${runId}.log`);
        writeFileSync(logFile, `${logs.join("\n")}\n`);
        return logFile;
      } catch {
        return null;
      }
    },
  };

  // Initialize log file if persisting
  if (persistLogs && options.stateDir) {
    try {
      mkdirSync(options.stateDir, { recursive: true });
      logFile = join(options.stateDir, `${runId}.log`);
    } catch {
      // Silent fail
    }
  }

  return logger;
}
