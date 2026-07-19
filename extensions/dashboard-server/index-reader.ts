/**
 * dashboard-server/index-reader.ts — machine-wide repo registry reader.
 *
 * The extension writes a machine-wide repo registry into a single SQLite DB
 * (<indexDir>/index.sqlite) as the concurrency-safe write path; the dashboard
 * reads that table directly (one read-only connection, opened per request so a
 * concurrent writer's WAL never blocks the request). All registry data lives in
 * SQLite (the project's one-store invariant) — there is no JSON mirror. Same
 * index-dir resolution as src/store/sqlite.ts getIndexDir().
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexRepo, IndexIndex } from "./types.js";

export function getIndexDir(): string {
  const override = process.env.MEGACOMPACT_INDEX_DIR;
  if (override && override.trim() !== "") return override;
  try {
    return join(homedir(), ".mega-compact-index");
  } catch {
    return join("/tmp", ".mega-compact-index");
  }
}

/** Read the machine-wide repo registry from SQLite (read-only, single shot). */
export function readIndex(): IndexIndex | null {
  const indexPath = join(getIndexDir(), "index.sqlite");
  if (!existsSync(indexPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    // Read-only + immutable WAL so a concurrent writer's WAL never blocks us.
    db = new DatabaseSync(indexPath, { readOnly: true });
    db.exec("PRAGMA journal_mode = WAL");
    const rows = db
      .prepare("SELECT * FROM repo_registry ORDER BY last_seen DESC")
      .all() as Record<string, unknown>[];
    const mapped: IndexRepo[] = rows.map((r) => ({
      repoRoot: String(r.repo_root ?? ""),
      displayName: String(r.display_name ?? ""),
      stateDir: String(r.state_dir ?? ""),
      checkpointCount: Number(r.checkpoint_count ?? 0),
      tokensSaved: Number(r.tokens_saved ?? 0),
      compressedOriginalBytes: Number(r.compressed_original_bytes ?? 0),
      lastCompactedAt: (r.last_compacted_at as number | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      providerName: (r.provider_name as string | null) ?? null,
      modelName: (r.model_name as string | null) ?? null,
      inputRate: (r.input_rate as number | null) ?? null,
      outputRate: (r.output_rate as number | null) ?? null,
      lastSeen: Number(r.last_seen ?? 0),
      // Defaults — enriched below from each repo's own store.
      tokensKept: 0,
      tokensDropped: 0,
      sessions: 0,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
    }));
    // Enrich each repo with per-store token + model detail read directly via
    // node:sqlite (same zero-dependency invariant as readIndex; no store graph
    // import). Best-effort: a missing/corrupt store degrades to the defaults
    // above so the dashboard never fails to render.
    for (const repo of mapped) {
      try {
        const storePath = join(repo.stateDir, "sqlite.db");
        if (existsSync(storePath)) {
          const sdb = new DatabaseSync(storePath, { readOnly: true });
          try {
            const tok = sdb
              .prepare(
                `SELECT COALESCE(SUM(token_estimate),0) AS kept,
                        COALESCE(SUM(original_token_estimate),0) AS dropped,
                        COUNT(DISTINCT session_id) AS sess
                 FROM context_chunks WHERE dedup_status != 'removed'`,
              )
              .get() as { kept: number; dropped: number; sess: number };
            repo.tokensKept = Number(tok.kept ?? 0);
            repo.tokensDropped = Number(tok.dropped ?? 0);
            repo.sessions = Number(tok.sess ?? 0);
            const mrow = sdb
              .prepare(
                `SELECT context_window, max_tokens, reasoning
                 FROM model_snapshots ORDER BY captured_at DESC LIMIT 1`,
              )
              .get() as { context_window: number; max_tokens: number; reasoning: number } | undefined;
            if (mrow) {
              repo.contextWindow = Number(mrow.context_window ?? 0) || null;
              repo.maxTokens = Number(mrow.max_tokens ?? 0) || null;
              repo.reasoning = Number(mrow.reasoning ?? 0) === 1;
            }
          } finally {
            sdb.close();
          }
        }
      } catch {
        /* best-effort — keep the defaults */
      }
    }
    // Defensive display hygiene (belt-and-suspenders — the real fix is that
    // tests now isolate via MEGACOMPACT_INDEX_DIR): drop transient test/temp
    // paths that should never have been real repos, and collapse duplicate
    // display names to the most-recently-seen row (rows are last_seen DESC, so
    // the first occurrence wins). Keeps the All-repos list readable.
    const isTransient = (p: string) =>
      /^\/tmp\//.test(p) || /^\/private\/tmp\//.test(p) || /^\/var\/folders\//.test(p) ||
      /\/mc-(ext|e2e|resume|recall)-/.test(p);
    const seenName = new Set<string>();
    const repos: IndexRepo[] = [];
    for (const r of mapped) {
      if (isTransient(r.repoRoot)) continue;
      if (seenName.has(r.displayName)) continue;
      seenName.add(r.displayName);
      repos.push(r);
    }
    const summary = {
      totalRepos: repos.length,
      totalCheckpoints: repos.reduce((a, r) => a + r.checkpointCount, 0),
      totalTokensSaved: repos.reduce((a, r) => a + r.tokensSaved, 0),
      totalCompressedOriginalBytes: repos.reduce((a, r) => a + r.compressedOriginalBytes, 0),
    };
    return { updatedAt: new Date().toISOString(), summary, repos };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
