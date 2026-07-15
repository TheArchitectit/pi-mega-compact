# Fix: zstd load crash + tokens-grow-on-read + promote dormant RAPTOR (durable trim via pi native compaction)

**Date:** 2026-07-14
**Fix release:** pi-mega-compact v0.4.22
**Focus:** make the extension survive install AND net-reduce tokens at read time
**Priority:** P0
**Effort:** L (multi-part: Fix A–E)
**Status:** COMPLETE (Fix A–E committed; 301 tests green)
**Depends on:** Sprints 8–15 (full pipeline shipped), PLAN.md phases 1–7

---

## SAFETY PROTOCOLS

- PREVENT-PI-004: zero network at runtime. Trigram embedder + extractive summarizer are local. DR zstd path is user-triggered only. Guardrails-scan must stay green.
- PREVENT-PI-002: never split a toolCall/toolResult pair at a compaction boundary. `computeDropRange` (anchor floor + tool-pair) is the authority for the `firstKeptEntryId` we hand to pi.
- PREVENT-PI-003: recall still injects via `before_agent_start` systemPrompt prepend, never `role:"system"`.
- Fix E sync constraint: `add()` stays synchronous — stored checkpoints use sync brotli/gzip escalation, NOT zstd. zstd is only on the async DR-export path. Do NOT make `add()`/`compactSession` async.
- Verify gate (every commit): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- NO FORCE PUSH; branch + PR only (user-permission gate for push).

---

## PROBLEM STATEMENT

Two bugs + one unused lever, one root theme: the extension must survive install and must **net-reduce** tokens at read time.

1. **Load crash** — `@mongodb-js/zstd` is `import`ed at top level of `src/store/compression.ts:35`, which the entire store layer transitively imports. Its native `zstd.node` is not in the published npm package and is skipped under npm `allowScripts`, so a clean install fails to load the whole extension. zstd is **dead code** (only re-exported from `store.ts`; zero runtime callers outside the unit test).
2. **Tokens grow on read** — the `context`-hook drop (`dropCompactedRange` → `{ messages: kept }`) is **ephemeral per-request only**; the session manager is read-only for extensions, so the trim never hits disk. On resume pi reloads the FULL transcript and `before_agent_start` **adds** the recall block on top → net MORE tokens. The status bar's `tokensSaved` lies because it counts the non-durable drop without subtracting the re-injected block.
3. **RAPTOR is dormant** — the full hierarchical summary tree (`src/dedup/raptor/*`) is built, persisted to `raptor_nodes` (SQLite), and logged, but `vectorStore.search()` (what `recallAndInline` uses) **never consults it**; `runRaptor`/`recallRaptor` fire only from backfill + tests; `RAPTOR_ENABLED` defaults FALSE. Its staged retrieval is exactly the mechanism to recall O(log n) high-level summaries instead of O(n) flat leaves.

**Root cause (read growth):** `ContextEventResult.messages?` replaces the payload for *that one LLM call* (SDK `types.d.ts:762`). `ReadonlySessionManager` (SDK `types.d.ts:218`) gives no API to rewrite the on-disk transcript. So the trim cannot be made durable through the `context` hook. The durable lever is `SessionBeforeCompactResult { compaction?: CompactionResult }` (SDK `types.d.ts:799`): returning it makes pi persist OUR summary and truncate from `firstKeptEntryId` — durable across resume.

**Measurement evidence** (synthetic 60-turn session, `estimateBlockTokens` ≈ chars/4):
- Compaction itself is healthy: 36:1 on the compacted region (5829 → 162 tokens).
- With ephemeral drop: resume reloads full 6030 + recall 211 = **6241 net (+211 vs original)** → reproduces the beta-user report.
- Root cause is NOT summary size (summary is tiny); it is the **non-durable + additive** read path.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- Fix A: lazy-load zstd (kill load crash) — `src/store/compression.ts`.
- Fix B: drive pi native compaction for a durable trim — `extensions/mega-events.ts` + new `extensions/mega-compact-driver.ts`.
- Fix C: honest `tokensSaved` + bounded/inline-deduped recall — `src/recall.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`.
- Fix D: promote dormant RAPTOR to the live recall path — `src/vectorStore.ts`, `src/dedup/raptor/index.ts`, `src/store/backfill.ts`, `extensions/mega-pipeline.ts`, `src/config/dedup.ts`.
- Fix E: adaptive compression by context-window pressure — `src/store/compression.ts`, `src/vectorStore.ts`, `src/engine.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`.
- Install hardening: `.npmrc` (`ignore-scripts=false`) + `postinstall` rebuild of native addons.

**OUT OF SCOPE (do NOT touch):**
- The openclaw `registerCompactionProvider` adapter (separate concern; pi extension is primary).
- Removing `@mongodb-js/zstd` from dependencies (keep for DR path).
- Any new persistence format (SQLite stays the only store).
- The context-awareness/memory plan (`context-awareness-and-memory.md`) — separate branch.

---

## EXECUTION

### Fix A — Lazy-load zstd (kills load crash) — `src/store/compression.ts`
- Remove the top-level `import zstd from "@mongodb-js/zstd"`.
- In the two zstd helpers, `const zstd = await import("@mongodb-js/zstd")` (both already `async`).
- Wrap in try/catch; on failure throw a clear, actionable error so a DR-path user gets a readable message instead of a stack trace.
- `store.ts` re-exports unchanged. `@mongodb-js/zstd` stays in `package.json` for the DR path.

### Fix B — Drive pi native compaction (durable trim) — `extensions/mega-events.ts` + `extensions/mega-compact-driver.ts`
- New `mega-compact-driver.ts`: `driveNativeCompaction(event, runtime, config)`:
  - `event.branchEntries` → `toEngineFromEntries` → engine view (reuse `adapt.ts`).
  - Compute the Trident cut/keep boundary exactly as today (`preserveRecent`, `anchorUserMessages`, `computeDropRange`) → `compactedFrom` + engine-view keep index.
  - Map engine index back to the **pi `SessionEntry.id`** for `firstKeptEntryId` (entries index-aligned via `toEngineFromEntries`).
  - Run `compactSession({ sessionId, messages: engineView, keepFrom, summary?, timestamp })`.
  - Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter } }`. `summary` = RAPTOR root when available (Fix D tie-in), else extractive `topicSummary`.
- Rewrite `session_before_compact` handler: **remove** the `{ cancel: true }` branch; call `driveNativeCompaction`; return its compaction so pi persists durably, or `{}` to let pi run native when we can't supply one (empty slice / below floor). Keep `runtime.resetRuntime(...)` bookkeeping; track "we supplied a compaction this session."
- `context` handler: the `context`-hook drop is no longer the savings mechanism. Keep it as the decision point that calls `ctx.compact()` to start pi's flow (which fires `session_before_compact` where we supply the durable trim). `config.auto` stays the on/off switch: when off, `session_before_compact` returns `{}`.
- Keep `dropCompactedRange`/`computeDropRange` in code (used by the driver + commands); runtime savings now come from pi's durable trim.

### Fix C — Honest accounting + bounded/inline-deduped recall — `src/recall.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`
- Recall/auto-inline is now a **bonus** (cross-session / on-demand), not the per-turn savings path.
  - **Bound recall size**: `recallMaxTokens` (default ~1500) on `MegaConfig`; `formatRecallBlock`/`recallAndInline` stops adding once the block would exceed the cap. Expose `MEGACOMPACT_RECALL_MAX_TOKENS`.
  - **NetApp-style inline dedupe**: `recallAndInline` receives the live window; for each candidate, embed it (reuse `defaultEmbedder`) and cosine-compare to each live message's embedding; if ≥ `dedupSim` (0.9) similar, drop the hit. `windowDedupe: boolean` (default true). Reuse `src/embedder.ts` `cosineSimilarity` + `defaultEmbedder` (local, zero-network).
  - **Honest `tokensSaved`**: on `session_compact`, `tokensSaved += (compactionEntry.tokensBefore - estimatedTokensAfter)` when `fromExtension` — single source of truth, no double count, no additive-recall inflation. Remove the old "original − stored" accounting that assumed the ephemeral drop was durable.
- `before_agent_start` recall injection stays, additive-only as a bonus, bounded + deduped.

### Fix D — Promote dormant RAPTOR to the live recall path — `src/vectorStore.ts`, `src/dedup/raptor/index.ts`, `src/store/backfill.ts`, `extensions/mega-pipeline.ts`, `src/config/dedup.ts`
- **Serve the tree in `vectorStore.search()`**: when `RAPTOR_ENABLED`, after the flat cosine scan, run `stagedExpansion(query, tree, {embedder, k, topM, mmrLambda})` over the session's `raptor_nodes` (rehydrate via `listRaptorNodes`, as `recallRaptor` does). Merge high-level node summaries into the candidate set, then MMR-dedupe so RAPTOR hits and flat hits don't double-cover. RAPTOR becomes the **primary** recall surface; flat checkpoints stay fallback for small sessions.
- **Build/update the tree at compaction time** (not just backfill): in `mega-pipeline.ts` `runCompact`, after a *new* checkpoint is stored, trigger a tree refresh for the session (`buildRaptorTree` over checkpoints → `saveRaptorTree`). Honor `RAPTOR_BUDGET_MS`. Best-effort + non-fatal; never block compaction.
- **Feed the pi-native summary from RAPTOR** (ties to Fix B): `driveNativeCompaction` prefers the RAPTOR root/near-query parent summary as the durable `compaction.summary` when `RAPTOR_ENABLED` and a tree exists; falls back to extractive `topicSummary`.
- **Config**: flip `RAPTOR_ENABLED` default to `true` (or gate behind `MEGACOMPACT_RAPTOR_ENABLED`) so promotion is live. canary.ts sequences it last (L0→L1→L2→RAPTOR) and auto-disables on p95 breach. Keep `RAPTOR_SHADOW_MODE` honored during a transition window.

### Fix E — Adaptive compression by context-window pressure — `src/store/compression.ts`, `src/vectorStore.ts`, `src/engine.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`
- **Intent**: compression strength + `keepFrom` aggressiveness scale with how close the session is to the model context limit. Room to spare → cheap compression + keep more verbatim; near the limit → strongest compression + compact more.
- **Pressure signal**: `mega-events.ts` `context` handler computes `pct` + `contextWindow`; thread `compressionPressure` (0–1, from `pct` via `pressureFromPct`) into `compactSession` → `add`. When pi drives compaction via `session_before_compact` (Fix B), derive pressure there too.
- **Sync stored-checkpoint path stays sync** (Trident chose sync zlib to avoid an async cascade). Stored `compressedOriginal` escalates through **sync zlib tiers**:
  - `compressSmart(data, pressure?)`: `<512B raw`; `512B–4KB` gzip 1→9 (pressure); `4KB–32KB` gzip 6→9 (pressure); `>32KB` brotli 4→11 (pressure). Keep the versioned header so old blobs still decode.
- **zstd enters only for the genuinely-async DR-export path** (where `await` is fine): `compressZstd` (lvl 3) / `compressZstdMax` (lvl 9) selected by pressure for DR snapshots/large-blob exports. Lazy `import()` keeps load safe if the binary is absent; DR export throws clear error only if actually used.
- **`keepFrom` escalates with pressure**: map pressure → `preserveRecent`/keepFrom via `preserveRecentForPressure`; bounded so the anchor floor (`computeDropRange`) is always respected (PREVENT-PI-002). Expose `MEGACOMPACT_PRESERVE_RECENT_MIN`.
- Net effect: tighter checkpoints on disk + (via RAPTOR, Fix D) tighter recalled summaries; nothing additive at read. The pressure dial makes the whole thing *scale*.

### Install hardening
- `.npmrc`: `ignore-scripts=false` — local override so a user/global `ignore-scripts=true` can't silently skip the `better-sqlite3` + `@mongodb-js/zstd` node-gyp builds for THIS package.
- `package.json` `postinstall`: `npm rebuild better-sqlite3 @mongodb-js/zstd || true` — runs each native dep's own install script from source after install.

---

## FILES TO CHANGE

| File | Fix | Status |
|------|-----|--------|
| `src/store/compression.ts` | A (lazy zstd), E (pressure escalation) | ✅ committed |
| `src/config.ts` | E (`pressureFromPct`, `preserveRecentForPressure`) | ✅ committed |
| `src/engine.ts` | E (`compressionPressure` on input) | ✅ committed |
| `src/vectorStore.ts` | E (thread pressure into `add`) | ✅ committed |
| `.npmrc` | install hardening | ✅ committed |
| `package.json` | install hardening (postinstall) | ✅ committed |
| `extensions/mega-compact-driver.ts` | B (new), D-hook (RAPTOR root) | ✅ committed |
| `extensions/mega-events.ts` | B (`session_before_compact` returns compaction; drop `{cancel}`), E (pressure wiring) | ✅ committed |
| `extensions/mega-pipeline.ts` | B (import driver), E (deepen keepFrom) | ✅ committed |
| `extensions/mega-config.ts` | E (preserveRecentMin), C (recallMaxTokens/windowDedupe) | ✅ committed |
| `src/dedup/raptor/index.ts` | D (export `recallRaptorRootSummary` + `rehydrateRaptorTree`) | ✅ committed |
| `src/recall.ts` | C (live window + inline dedupe + bound) | ✅ committed |
| `src/vectorStore.ts` | D (serve tree in `search` via `raptorSearchHits`) | ✅ committed |
| `src/store/backfill.ts` / `mega-pipeline.ts` | D (build tree at compaction) | ✅ committed (mega-pipeline) |
| `src/config/dedup.ts` | D (flip `RAPTOR_ENABLED` default) | ✅ committed |
| tests: `store.test.ts`, `store/compression.test.ts`, `recall.test.ts`, `dedup/raptor/promote.test.ts` | A–E | ✅ all committed |

---

## ACCEPTANCE

1. `pi` loads the extension from a clean `allowScripts`-blocked install (zstd binary absent) — no load crash.
2. After compaction, the trimmed transcript is **durable**: resuming reloads the trimmed window + baked-in Trident summary; model-visible token count is **strictly less** than before (no additive recall inflation on resume).
3. `tokensSaved` accounting is honest — reflects durable savings, never claims savings the ephemeral drop didn't deliver.
4. Recall/auto-inline retained as a **bonus**, net non-inflating: bounded `recallMaxTokens`, inline dedupe against the live window, and RAPTOR promotion.
5. **RAPTOR promoted** to the live recall path (served by `vectorStore.search`, rebuilt at compaction time, feeding the durable pi summary).
6. **Adaptive compression by context pressure** (Fix E): checkpoint compression strength escalates (gzip → brotli-11) and `keepFrom` deepens as the session nears the model limit; zstd (lvl 3/9) used only for async DR-export.
7. `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green. PREVENT-PI-004 stays green.

---

## ROLLBACK

- Per-commit rollback to `93722c0` (Fix B) / `6c86913` (Fix A/E) if a regression surfaces; each commit is independently green.
- Fix B is the token-growth fix; if pi's native compaction threshold doesn't fire as expected, keep `config.auto` → `ctx.compact()` fallback (never remove the on/off switch).
- Fix D must stay behind `RAPTOR_ENABLED` + canary p95 auto-disable; the compaction-time rebuild is best-effort and must never block or fail a compaction. Budget guard (`RAPTOR_BUDGET_MS`) caps wall-clock.
- Fix A lazy-import: if DR-export regresses (binary genuinely absent), the DR path throws a clear, actionable error — non-fatal to the extension load.
- NO FORCE PUSH; revert/reset via PR only.
