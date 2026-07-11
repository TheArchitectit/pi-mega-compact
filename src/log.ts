/**
 * log.ts — tiny append-only structured logger.
 *
 * Writes one JSON object per line to a log file (default:
 * ~/.pi/agent/extensions/mega-compact.log). Best-effort: logging never throws
 * into the extension. Pi-agnostic and dependency-free so it can be unit-tested.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR_DEFAULT } from "./config.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  event: string;
  [k: string]: unknown;
}

/** Default log path lives alongside the state dir. */
export function defaultLogPath(): string {
  return join(STATE_DIR_DEFAULT, "mega-compact.log");
}

export class Logger {
  private readonly path: string;
  private readonly enabled: boolean;
  /** Monotonic clock injected by the caller so the module stays deterministic. */
  private readonly now: () => number;

  constructor(opts: { path?: string; enabled?: boolean; now?: () => number } = {}) {
    this.path = opts.path ?? defaultLogPath();
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Append one structured line. Swallows all I/O errors. */
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const entry: LogEntry = { ts: this.now(), level, event, ...fields };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    } catch {
      /* best-effort: never break the extension on a log failure */
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
}
