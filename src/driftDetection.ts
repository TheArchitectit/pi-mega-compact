/**
 * driftDetection.ts — R4: cross-repo drift detection over the machine-wide
 * repo_registry (index.sqlite). Reads the registry, classifies each repo
 * against simple drift signals, and returns a structured report that the
 * dashboard's Multi-repo tab and the /api/drift endpoint can render.
 *
 * Signals (all derived from repo_registry alone — no checkpoint scans):
 *   - stale: last_seen older than STALE_DAYS (default 30). Repo is up but
 *     hasn't touched the dashboard in a while — usually parked work.
 *   - compaction_lag: last_seen within ACTIVE_DAYS (default 7) but
 *     last_compacted_at is null or > 24h behind. The repo is actively running
 *     work but compaction isn't keeping pace — usually a config regression.
 *   - model_churn: model_captured_at within MODEL_CHURN_DAYS (default 7) —
 *     the active model changed recently. Could be a routine upgrade or a
 *     silent fallback; both worth flagging.
 *
 * Scope: read-only by design. No writes — drift reporting should never mutate
 * the registry. Severity classification is conservative: warnings, not alarms.
 * @module
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getIndexDir } from "./store/sqlite.js";

const DAY_SEC = 86_400;
const STALE_DAYS = 30;
const ACTIVE_DAYS = 7;
const MODEL_CHURN_DAYS = 7;
/** Compaction lag threshold: last_seen newer than this AND last_compacted_at
 *  more than this far behind. 24h is generous — compactions usually fire in
 *  minutes; >24h usually means something is wedged. */
const COMPACTION_LAG_SEC = 24 * 3600;

export type DriftSeverity = "warn" | "info";

export interface RepoDrift {
  repoRoot: string;
  displayName: string;
  lastSeen: number;
  lastCompactedAt: number | null;
  modelCapturedAt: number | null;
  signals: Array<{ kind: "stale" | "compaction_lag" | "model_churn"; severity: DriftSeverity; detail: string }>;
  /** Highest severity across signals; "ok" if none. */
  status: "ok" | "warn";
}

export interface DriftReport {
  generatedAt: number;
  totals: { ok: number; warn: number; stale: number; compactionLag: number; modelChurn: number };
  repos: RepoDrift[];
}

/** Read all repos from the machine-wide registry, classify drift, return report. */
export function detectCrossRepoDrift(indexDir: string = getIndexDir()): DriftReport {
  const generatedAt = Math.floor(Date.now() / 1000);
  const indexPath = join(indexDir, "index.sqlite");
  const totals = { ok: 0, warn: 0, stale: 0, compactionLag: 0, modelChurn: 0 };
  if (!existsSync(indexPath)) return { generatedAt, totals, repos: [] };

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
    db.exec("PRAGMA journal_mode = WAL");
    const rows = db
      .prepare(
        `SELECT repo_root, display_name, last_seen, last_compacted_at,
                model_name, provider, model_captured_at
           FROM repo_registry`,
      )
      .all() as Array<{
        repo_root: string;
        display_name: string | null;
        last_seen: number | null;
        last_compacted_at: number | null;
        model_name: string | null;
        provider: string | null;
        model_captured_at: number | null;
      }>;

    const repos: RepoDrift[] = [];
    for (const r of rows) {
      const lastSeen = r.last_seen ?? 0;
      const lastCompacted = r.last_compacted_at ?? null;
      const modelCaptured = r.model_captured_at ?? null;
      const signals: RepoDrift["signals"] = [];

      if (lastSeen > 0 && generatedAt - lastSeen > STALE_DAYS * DAY_SEC) {
        const daysAgo = Math.floor((generatedAt - lastSeen) / DAY_SEC);
        signals.push({ kind: "stale", severity: "info", detail: `last activity ${daysAgo}d ago` });
        totals.stale++;
      }
      if (
        lastSeen > 0 &&
        generatedAt - lastSeen <= ACTIVE_DAYS * DAY_SEC &&
        (lastCompacted === null || generatedAt - lastCompacted > COMPACTION_LAG_SEC)
      ) {
        const lagSec = lastCompacted ? generatedAt - lastCompacted : generatedAt - lastSeen;
        const lagH = Math.floor(lagSec / 3600);
        signals.push({
          kind: "compaction_lag",
          severity: "warn",
          detail: lastCompacted ? `${lagH}h behind last activity` : "never compacted",
        });
        totals.compactionLag++;
      }
      if (modelCaptured && generatedAt - modelCaptured <= MODEL_CHURN_DAYS * DAY_SEC) {
        const label = [r.provider, r.model_name].filter(Boolean).join("/") || "model";
        signals.push({ kind: "model_churn", severity: "info", detail: `${label} captured recently` });
        totals.modelChurn++;
      }

      const status: RepoDrift["status"] = signals.some((s) => s.severity === "warn") ? "warn" : "ok";
      if (status === "warn") totals.warn++;
      else totals.ok++;

      repos.push({
        repoRoot: r.repo_root,
        displayName: r.display_name ?? r.repo_root,
        lastSeen,
        lastCompactedAt: lastCompacted,
        modelCapturedAt: modelCaptured,
        signals,
        status,
      });
    }
    // Sort: warn first, then by lastSeen desc so the active ones are on top.
    repos.sort((a, b) => {
      if (a.status !== b.status) return a.status === "warn" ? -1 : 1;
      return b.lastSeen - a.lastSeen;
    });
    return { generatedAt, totals, repos };
  } finally {
    db?.close();
  }
}