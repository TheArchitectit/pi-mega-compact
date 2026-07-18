/**
 * mega-db-cmds.ts — S27 Task 10 DB maintenance /commands.
 *
 * Registers /mega-db-stats, /mega-db-prune, /mega-db-vacuum, /mega-db-check,
 * /mega-db-reconcile slash commands backed by the maintenance primitives in
 * src/store/sqlite.ts. All operations are local SQLite (PREVENT-PI-004) with
 * parameterized queries (PREVENT-002).
 *
 * Auto-maintenance (prune + WAL checkpoint) also runs once per session_start
 * via the wiring in mega-events.ts (best-effort, non-blocking).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "./mega-runtime.js";
import {
  getDbStats,
  pruneOldRows,
  checkpointWal,
  vacuumDb,
  integrityCheck,
  reconcileDedupMirror,
  type DedupReconcileResult,
} from "../src/store/sqlite.js";

/** Format a byte count as a human-readable string (KB / MB / GB). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/** Register the /mega-db-* maintenance commands. */
export function registerDbCommands(pi: ExtensionAPI, runtime: MegaRuntime): void {
  const stateDir = runtime.currentStateDir;

  pi.registerCommand("mega-db-stats", {
    description:
      "Show mega-compact SQLite DB stats: table row counts, disk footprint (db + WAL + SHM), page count, freelist, WAL frames.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const s = getDbStats(stateDir);
      ctx.ui.notify(`[mega-compact] DB stats — ${stateDir}`);
      ctx.ui.notify(`  main: ${fmtBytes(s.dbBytes)}  wal: ${fmtBytes(s.walBytes)}  shm: ${fmtBytes(s.shmBytes)}`);
      ctx.ui.notify(
        `  pages: ${s.pageCount} (${s.pageSize}B each), freelist: ${s.freelistPages} (${s.pageCount > 0 ? ((s.freelistPages / s.pageCount) * 100).toFixed(1) : "0"}% reusable), wal frames: ${s.walFrames}`,
      );
      const tableLines = Object.entries(s.tableCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `  ${t.padEnd(22)} ${String(c).padStart(8)}`);
      if (tableLines.length === 0) {
        ctx.ui.notify("  (no tables populated yet)");
      } else {
        ctx.ui.notify("  table row counts:");
        for (const l of tableLines) ctx.ui.notify(l);
      }
    },
  });

  pi.registerCommand("mega-db-prune", {
    description:
      "Prune raw_transcript + checkpoint_epochs + orphan dedup_mirror rows older than N days (default 30). Usage: /mega-db-prune [days]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const days = Number.parseInt(args.trim().split(/\s+/)[0] ?? "30", 10);
      const d = Number.isFinite(days) && days > 0 ? days : 30;
      const r = pruneOldRows(stateDir, d);
      ctx.ui.notify(`[mega-compact] ${r.summary} (reclaimed ${fmtBytes(r.reclaimedBytes)})`);
    },
  });

  pi.registerCommand("mega-db-vacuum", {
    description:
      "VACUUM the mega-compact SQLite DB (rebuild pages, reclaim freelist space). Heavy: briefly doubles disk usage.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const r = vacuumDb(stateDir);
      ctx.ui.notify(`[mega-compact] ${r.summary}`);
    },
  });

  pi.registerCommand("mega-db-check", {
    description:
      "Run PRAGMA integrity_check + a WAL checkpoint on the mega-compact SQLite DB. Use after a crash or to fold the WAL into the main file.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const lines = integrityCheck(stateDir);
      const healthy = lines.length === 1 && lines[0] === "ok";
      ctx.ui.notify(
        `[mega-compact] integrity_check: ${healthy ? "✓ ok" : `⚠ ${lines.length} issue(s)`}`,
      );
      if (!healthy) {
        for (const l of lines.slice(0, 10)) ctx.ui.notify(`  ${l}`);
        if (lines.length > 10) ctx.ui.notify(`  … and ${lines.length - 10} more`);
      }
      const ck = checkpointWal(stateDir);
      ctx.ui.notify(`[mega-compact] ${ck.summary}`);
    },
  });

  pi.registerCommand("mega-db-reconcile", {
    description:
      "Reconcile dedup_mirror.ref_count vs actual raw_transcript refs: fix drift, delete orphan dedup rows, backfill missing content_ref. Run after /mega-db-prune or a crash.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const r: DedupReconcileResult = reconcileDedupMirror(stateDir);
      ctx.ui.notify(
        `[mega-compact] dedup reconcile: fixed ${r.fixedRefCount} ref_count drift, deleted ${r.orphansDeleted} orphan(s), backfilled ${r.refsBackfilled} content_ref`,
      );
    },
  });
}
