/**
 * repoKey.ts — S25-B: the single repo-scope key for BOTH global PGlite indexes.
 *
 * Before S25 the checkpoint index (vector_index) keyed on stateDir while the
 * memory index (memory_index) keyed on the git root — two scopes that meant
 * cross-repo checkpoint hydration had no way back from repo_id → the repo's
 * store. This helper unifies both indexes on ONE key: the resolved git root,
 * falling back to stateDir outside git worktrees.
 *
 * stateDirForRepo() reverses the mapping via the machine-wide
 * repo_registry (src/store/sqlite/global-index.ts): a repo_id hit from the
 * index resolves to that repo's stateDir so getCheckpoint() can hydrate from
 * the authoritative node:sqlite store. Returns undefined when unresolvable —
 * the caller skips the hit (degrade, never crash).
 *
 * PREVENT-PI-004: `git rev-parse` is local + read-only (annotated below).
 */

import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only `git rev-parse` to scope the vector index per-repo
import { getRepoRegistry } from "./sqlite/global-index.js";

/**
 * Resolve the canonical repo key for a state dir. Git root when inside a
 * worktree, stateDir otherwise. Two repos sharing a git root (e.g. nested
 * checkouts pointing at the same repo) collapse to one scope — intended.
 */
export function repoKey(stateDir: string): string {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: stateDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || stateDir;
  } catch {
    return stateDir;
  }
}

/**
 * Reverse map: repo_id → stateDir. Registry hit wins (git-root scope, S25);
 * otherwise the key is assumed to be a legacy/ungit-scoped stateDir and
 * returned verbatim (callers treat undefined-unopenable dirs as skip/degrade).
 */
export function stateDirForRepo(
  repoId: string,
  indexDir?: string,
): string | undefined {
  return getRepoRegistry(repoId, indexDir)?.stateDir ?? repoId;
}
