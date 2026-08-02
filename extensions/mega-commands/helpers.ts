/**
 * mega-commands/helpers.ts — shared helpers for the data/inspection commands.
 *
 * Extracted from mega-commands.ts (delegate-shell split). findCheckpoint
 * resolves a checkpoint by id (or "recent"/"last"); checkRecallQuality peeks at
 * recent events.log / mega-compact.log for low recall-quality signals.
 */
import type { MegaRuntime } from "../mega-runtime.js";
import { listCheckpoints } from "../../src/store/sqlite.js";
import { defaultEventsPath } from "../../src/monitoring.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Resolve a checkpoint by id (or "recent"/"last") from this session's store. */
export function findCheckpoint(runtime: MegaRuntime, sid: string, ref: string) {
  const all = listCheckpoints(sid, runtime.currentStateDir);
  if (all.length === 0) return undefined;
  if (!ref || ref === "recent" || ref === "last") return all[all.length - 1];
  return all.find((c) => c.checkpointId === ref) ?? all.find((c) => c.checkpointId.endsWith(ref));
}

/**
 * Try to peek at recent events.log and mega-compact.log for low recall quality signals.
 * Best-effort, non-fatal — returns true if a low-quality signal was found.
 */
export function checkRecallQuality(stateDir: string): boolean {
  const eventPaths = [
    defaultEventsPath(stateDir),
    path.join(stateDir, "mega-compact.log"),
  ];
  for (const fp of eventPaths) {
    try {
      if (!existsSync(fp)) continue;
      const buf = readFileSync(fp, { encoding: "utf-8" });
      // Only scan last 64 KiB of the file
      const tail = buf.length > 65536 ? buf.slice(buf.length - 65536) : buf;
      const lines = tail.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          // guardrails-allow PREVENT-001: JSON.parse with null check
          const parsed = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null) continue;
          // Check for recall_metrics_low_quality event (latest format)
          if (parsed.event === "recall_metrics_low_quality" && parsed.score !== undefined) {
            if (typeof parsed.score === "number" && parsed.score < 0.4) return true;
          }
          // Check for recall_metrics with low relevanceScore
          if (parsed.event === "recall_metrics" && parsed.relevanceScore !== undefined) {
            if (typeof parsed.relevanceScore === "number" && parsed.relevanceScore < 0.4) return true;
          }
          // Check for RecallQualityEvent format from monitoring.ts
          if (parsed.score !== undefined && typeof parsed.score === "number" && parsed.score < 0.4) return true;
        } catch {
          // skip unparseable lines
        }
      }
    } catch {
      // non-fatal: skip if can't read
    }
  }
  return false;
}
