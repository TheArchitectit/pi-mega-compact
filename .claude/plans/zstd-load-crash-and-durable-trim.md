# Plan: Fix zstd load crash + tokens-grow-on-read + promote dormant RAPTOR (durable trim via pi native compaction)

> Date: 2026-07-14. Scope: pi-mega-compact v0.4.21.
> Two bugs + one unused lever, one root theme: the extension must survive install and must **net-reduce** tokens at read time.
> Constraint (user): **all persistence goes into SQLite** (`better-sqlite3`). Our VectorStore is the source of truth; pi's `compactionSummary` entry is pi's file (out of our control) and we leave it alone. No new store formats. PREVENT-PI-004: no network; the trigram embedder + extractive summarizer are local; optional localhost-only Ollama is already annotated.

## TL;DR

1. **Load crash** — `@mongodb-js/zstd` is `import`ed at top level of `src/store/compression.ts:35`, which the entire store layer transitively imports. Its native `zstd.node` is not in the npm tarball and is skipped under npm `allowScripts` (see `npm install-scripts ls`), so a clean install fails to load the whole extension. zstd is **dead code** (only re-exported from `store.ts`; zero runtime callers outside the unit test). Fix: lazy `await import()` inside the two zstd helpers.
2. **Tokens grow on read** — the `context`-hook drop (`dropCompactedRange` → `{ messages: kept }`) is **ephemeral per-request only**; the session manager is read-only for extensions, so the trim never hits disk. On resume pi reloads the FULL transcript and `before_agent_start` **adds** the recall block on top → net MORE tokens. The status bar's `tokensSaved` lies because it counts the non-durable drop without subtracting the re-injected block. Fix: **stop cancelling pi's native compaction**; instead return our Trident summary + cut point from `session_before_compact` so pi durably trims the transcript. Then recall/auto-inline becomes a cross-session bonus, not the savings mechanism, and the read path is net-negative.
3. **RAPTOR is dormant** — the full hierarchical summary tree (`src/dedup/raptor/*`) is built, persisted to `raptor_nodes` (SQLite), and logged, but `vectorStore.search()` (what `recallAndInline` uses) **never consults it**; `runRaptor`/`recallRaptor` fire only from backfill + tests; `RAPTOR_ENABLED` defaults FALSE. Its staged retrieval (`stagedExpansion`: score top-level nodes by cosine → expand top-M → BFS to leaves → MMR) is exactly the mechanism to recall O(log n) high-level summaries instead of O(n) flat leaves. **Promote it to the live recall path** — this is the real answer to read-path token growth: fewer, broader, cheaper summaries than the additive flat recall it replaces.

Measurement evidence (synthetic 60-turn session, `estimateBlockTokens` ≈ chars/4):
- Compaction itself is healthy: 36:1 on the compacted region (5829 → 162 tokens).
- With ephemeral drop: resume reloads full 6030 + recall 211 = **6241 net (+211 vs original)** → reproduces the beta-user report.
- Root cause is NOT summary size (summary is tiny); it is the **non-durable + additive** read path.

## Root-cause details (read first)

- **Load crash**: `compression.ts:35` `import zstd from "@mongodb-js/zstd"` is static. `@mongodb-js/zstd@7.0.0` ships no prebuilt binary in its npm tarball; its `install` script (`prebuild-install || node-gyp rebuild`) is skipped under `allowScripts`. Result: `Cannot find module '../build/Debug/zstd.node'`, whole extension fails to load. The import is reachable from `mega-runtime`/`mega-events`/`mega-commands`/`vectorStore` → `store.ts` → `compression.ts`. zstd is async DR-export only; never called on the live path.
- **Token growth**: `ContextEventResult.messages?` replaces the payload for *that one LLM call* (SDK `types.d.ts:762`). `ReadonlySessionManager` (SDK `types.d.ts:218`) gives no API to rewrite the on-disk transcript. So the trim cannot be made durable through the `context` hook. A local MCP server would be strictly weaker (tool-only, out-of-process, no context-assembly access) — rejected. The durable lever is `SessionBeforeCompactResult { compaction?: CompactionResult }` (SDK `types.d.ts:799`): returning it makes pi persist OUR summary and truncate the transcript from `firstKeptEntryId` — durable across resume. This matches the prior plan (`context-awareness-and-memory.md:20`) which already flagged this as "the real lever."

## Goal / Definition of Done

1. `pi` loads the extension from a clean `allowScripts`-blocked install (zstd binary absent) — no load crash.
2. After a compaction, the trimmed transcript is **durable**: resuming the session reloads the trimmed window + baked-in Trident summary, and the model-visible token count is **strictly less** than before compaction (no additive recall inflation on resume).
3. `tokensSaved` accounting is honest: it reflects durable savings, never claims savings the ephemeral drop didn't deliver.
4. Recall/auto-inline is retained as a **bonus** (cross-session / on-demand) and is net non-inflating: bounded `recallMaxTokens`, NetApp-style **inline dedupe** against the live window, and **RAPTOR promotion** so recall returns O(log n) high-level summaries instead of O(n) flat leaves.
5. **RAPTOR is promoted** to the live recall path (served by `vectorStore.search`, rebuilt at compaction time, and feeding the durable pi summary) — the dormant tree becomes the primary recall surface.
6. **Adaptive compression by context pressure** (Fix E): checkpoint compression strength escalates (gzip → brotli-4 → brotli-11) and `keepFrom` deepens as the session nears the model context limit; zstd (level 3/9) is used for the async DR-export path. Delivers the original "variable compression as we approach the limit" design without breaking the sync `add()` contract.
7. `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green. PREVENT-PI-004 stays green (no network; trigram embedder + extractive summarizer are local; RAPTOR/Ollama is localhost-only and already annotated).

## Approach

### Fix A — Lazy-load zstd (kills load crash) — `src/store/compression.ts`
- Remove the top-level `import zstd from "@mongodb-js/zstd"` (line 35).
- In `compressZstdWithLevel` (line 166) and `decompressZstd` (line 187), do `const zstd = await import("@mongodb-js/zstd")`. Both are already `async`, so the signature is unchanged.
- Wrap the dynamic import in try/catch; on failure throw a clear, actionable error (`zstd binary not built — run the extension's native install step`), so a user who actually hits DR-export gets a readable message instead of a stack trace. This preserves the DR path's intent while removing the load-time dependency.
- `store.ts` re-exports (lines 20–22) are unaffected (still named exports of the functions).
- Note: this does NOT remove the `@mongodb-js/zstd` dependency from `package.json`; the dependency stays available for the DR path. The fix is purely making it lazy so a missing binary can't crash load.

### Fix B — Drive pi native compaction (durable trim, kills token growth) — `extensions/mega-events.ts` + new `extensions/mega-compact-driver.ts`
- New module `mega-compact-driver.ts`: `driveNativeCompaction(event, ctx, runtime, config)`:
  - Take `event.branchEntries` (full entry list) → `toEngineFromEntries` → engine view (reuse `adapt.ts`).
  - Compute the Trident cut/keep boundary exactly as today (`preserveRecent`, `anchorUserMessages`, `computeDropRange`), producing `compactedFrom` and the engine-view index to keep.
  - Map that engine index back to the **pi `SessionEntry.id`** for `firstKeptEntryId` (entries are index-aligned via `toEngineFromEntries`; track id per entry).
  - Run `compactSession({ sessionId, messages: engineView, keepFrom, summary?, timestamp })`.
  - Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter } }`.
    - `summary` = the Trident extractive `topicSummary` (+ optional key files line).
    - `tokensBefore` = estimate of dropped region; `estimatedTokensAfter` = kept + summary.
- Rewrite `session_before_compact` handler in `mega-events.ts`:
  - **Remove** the `{ cancel: true }` branch (the thing that made trim ephemeral).
  - Call `driveNativeCompaction`; if it returns a compaction, return it so pi persists durably. If it can't (e.g. empty slice, below floor), return `{}` and let pi do its native compaction.
  - Keep `runtime.resetRuntime(...)` and the bookkeeping; switch `runtime.rt.persistedThisSession` tracking to "we supplied a compaction this session."
  - **`summary` = RAPTOR root when available** (Fix D): after building/refreshing the tree for the session, prefer the RAPTOR root (or the near-query top-level parent) as the durable `compaction.summary` instead of one slice's extractive summary. This gives pi a session-level compressed summary, not a single slice's. Fall back to the extractive `topicSummary` when no tree exists yet.
- Adjust `context` handler (`mega-events.ts:123`): since pi now owns the durable trim, the `context`-hook `dropCompactedRange` is **no longer the savings mechanism**. Keep it as a *defensive per-request* trim only if needed, but it must not double-count savings. Simplest: **drop the `context`-hook drop + `autoCompactCheck` trigger entirely** (pi's native threshold/overflow now drives compaction via `session_before_compact`). This removes the double-compaction risk and the ephemeral-drop accounting entirely. (Verify pi's native threshold matches our intent; expose via existing `MEGACOMPACT_THRESHOLD_TOKENS` → `ctx.compact({ customInstructions })` if we need to force it. Keep `config.auto` as the on/off switch: when off, `session_before_compact` returns `{}` and we fall back to pi native or no compaction.)
- Keep `dropCompactedRange`/`computeDropRange` in code (still used by the driver to compute `firstKeptEntryId` and by commands), but the *runtime* savings now come from pi's durable trim.

### Fix C — Honest accounting + bounded/inline-deduped recall — `src/recall.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`
- Recall/auto-inline is now a **bonus** (cross-session / on-demand `/recall-context`), not the per-turn savings path. So:
  - **Bound recall size**: cap the re-injected block by tokens. Add `recallMaxTokens` (default e.g. 1500) to `MegaConfig`; `formatRecallBlock`/`recallAndInline` stops adding checkpoints once the block would exceed the cap. Expose `MEGACOMPACT_RECALL_MAX_TOKENS`.
  - **NetApp-style inline dedupe**: `recallAndInline` receives the live window messages; for each candidate hit, embed it (reuse `defaultEmbedder`) and compare to each live message's embedding via `cosineSimilarity`; if any live message is ≥ `dedupSim` (0.9) similar, **drop** the hit (it's already resident) — "dedupe on inline/read." Add `windowDedupe: boolean` (default true). Reuse `src/embedder.ts` `cosineSimilarity` + `defaultEmbedder` (local, zero-network).
  - **Honest `tokensSaved`**: since the durable trim is now pi's, our `runtime.rt.tokensSaved` should reflect what pi trimmed. On `session_compact` (`SessionCompactEvent`), update `runtime.rt.tokensSaved += (event.compactionEntry.tokensBefore - estimatedTokensAfter)` when `fromExtension` (our compaction) — single source of truth, no double count, no additive-recall inflation. Remove the old "original − stored" accounting that assumed our ephemeral drop was durable.
- `before_agent_start` recall injection stays, but is now additive-only as a *bonus* and bounded + deduped, so it can never net-inflate beyond a small cap.

### Fix D — Promote dormant RAPTOR to the live recall path — `src/vectorStore.ts`, `src/dedup/raptor/index.ts`, `src/store/backfill.ts`, `extensions/mega-pipeline.ts`, `src/config/dedup.ts`
- **Serve the tree in `vectorStore.search()`**: when `RAPTOR_ENABLED`, after the flat cosine scan, run `stagedExpansion(query, tree, {embedder, k, topM, mmrLambda})` over the session's `raptor_nodes` (rehydrate via `listRaptorNodes`, exactly as `recallRaptor` already does). Merge the returned high-level node summaries into the candidate set, then MMR-dedupe the combined set so RAPTOR hits and flat hits don't double-cover. RAPTOR becomes the **primary** recall surface; flat checkpoints remain the fallback for small sessions (tree not built yet). Token cost: O(log n) high-level nodes vs O(n) leaves → fewer, broader summaries.
- **Build/update the tree at compaction time, not just backfill**: in `mega-pipeline.ts` `runCompact`, after a *new* (non-deduped) checkpoint is stored, trigger a tree refresh for the session. Use the existing `buildRaptorTree` over the session's checkpoints (leaves = `StoredCheckpoint.summary`/normalizedText + embedding, exactly as `backfillRaptor` builds them) and `saveRaptorTree`. Honor `RAPTOR_BUDGET_MS` (the builder already guards wall-clock). Keep it best-effort + non-fatal (never block compaction). For large sessions this is a full rebuild per compaction; acceptable behind `RAPTOR_ENABLED` (default false) and the budget guard; a later optimization can do incremental leaf-append.
- **Feed the pi-native summary from RAPTOR** (ties to Fix B): `driveNativeCompaction` prefers the RAPTOR root/near-query parent summary as the durable `compaction.summary` when `RAPTOR_ENABLED` and a tree exists; falls back to extractive `topicSummary`.
- **Config**: flip `RAPTOR_ENABLED` default to `true` (or gate behind a clearly-documented env/`MEGACOMPACT_RAPTOR_ENABLED`) so the promotion is actually live; canary.ts already sequences it last (L0→L1→L2→RAPTOR) and auto-disables on p95 breach, so promotion is safe. Keep `RAPTOR_SHADOW_MODE` honored during a transition window if desired.

### Fix E — Adaptive compression by context-window pressure (your original design) — `src/store/compression.ts`, `src/vectorStore.ts`, `src/engine.ts`, `extensions/mega-events.ts`, `extensions/mega-config.ts`
- **The intent (now implemented)**: compression strength + `keepFrom` aggressiveness scale with how close the session is to the model context limit. Room to spare → cheap compression + keep more verbatim; near the limit → strongest compression + compact more.
- **Pressure signal**: `mega-events.ts` `context` handler already computes `pct` (line 126) and `contextWindow` (line 130). Thread a `compressionPressure` value (0–1, derived from `pct`) into `compactSession` → `add`. When pi drives compaction via `session_before_compact` (Fix B), derive pressure from `event`/ctx usage there too.
- **Sync stored-checkpoint path stays sync** (Trident deliberately chose sync zlib to avoid an async cascade — `compression.ts:6-8`). So the *stored* `compressedOriginal` escalates through **sync zlib tiers**, not zstd:
  - `compressSmart` becomes `compressSmart(data, pressure?)`: `<512B raw`; `512B–4KB` gzip-l1; `4KB–32KB` gzip-l6; `>32KB` **brotli-4 by default, brotli-11 under high pressure**. (brotli-11 is still sync via `brotliCompressSync`.) Keep the versioned header so old blobs still decode.
- **zstd enters for the genuinely-async DR-export path** (where `await` is already fine): `compressZstd` (level 3) / `compressZstdMax` (level 9) are selected by pressure for DR snapshots/large-blob exports. This is the only place zstd is *called* at runtime, and it's already async — no change to `add()`'s sync contract. Lazy `import()` (Fix A) keeps the load safe if the binary is absent; DR export throws a clear error only if actually used.
- **`keepFrom` escalates with pressure**: in `mega-events.ts`/`mega-compact-driver.ts`, map pressure → `preserveRecent`/keepFrom: low pressure keeps more recent turns verbatim; high pressure compacts deeper (smaller `preserveRecent`). Bounded so the anchor floor (`computeDropRange`) is always respected (PREVENT-PI-002). Expose `MEGACOMPACT_PRESERVE_RECENT_MIN` for the high-pressure floor.
- Net effect on the token problem: tighter checkpoints on disk + (via RAPTOR, Fix D) tighter recalled summaries; nothing is additive at read. The pressure dial makes the whole thing *scale* instead of being a fixed threshold.

## Files to change
- `src/store/compression.ts` — lazy `import()` for zstd (Fix A).
- `extensions/mega-events.ts` — `session_before_compact` returns our compaction (Fix B); drop ephemeral `context`-hook drop (Fix B); honest `tokensSaved` on `session_compact` (Fix C).
- `extensions/mega-compact-driver.ts` — NEW: `driveNativeCompaction` (Fix B); prefers RAPTOR root summary (Fix D).
- `src/recall.ts` — accept live window, bounded block + inline dedupe (Fix C).
- `src/vectorStore.ts` — serve RAPTOR tree in `search()` when `RAPTOR_ENABLED` (Fix D); thread `compressionPressure` into `add` → `compressSmart` (Fix E).
- `src/dedup/raptor/index.ts` — export a `searchRaptor(sessionId, query, opts)` helper (reuse `recallRaptor` internals) for `vectorStore.search` to call; keep shadow-mode guard for the build path only.
- `extensions/mega-pipeline.ts` — rebuild/refresh RAPTOR tree after a new checkpoint (Fix D); derive `compressionPressure` + escalated `keepFrom` (Fix E).
- `src/config/dedup.ts` — flip `RAPTOR_ENABLED` default (Fix D); keep canary sequencing.
- `extensions/mega-config.ts` — `recallMaxTokens`, `windowDedupe` (Fix C); `preserveRecentMin` + compression-pressure bands (Fix E).
- `src/store/compression.ts` — `compressSmart(data, pressure?)` escalates brotli under pressure (Fix E); lazy zstd (Fix A).
- `src/engine.ts` — accept `compressionPressure` on `CompactInput`, pass to `add` (Fix E).
- `src/store.ts` — re-exports unchanged (Fix A no-op for exports).

## Tests (per guardrails: production first, then tests; run `npm test`)
- **compression.test.ts**: `compressZstd`/`decompressZstd` roundtrip when binary present (existing); assert module loads with no top-level zstd import (lazy). **Add**: `compressSmart` with `pressure` picks brotli-11 (or higher quality) under high pressure and still decodes via `decompressSmart`.
- **New `mega-compact-driver.test.ts`** (handler-level): `session_before_compact` returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter } }` with correct `firstKeptEntryId`; empty/below-floor returns `{}`; high-pressure variant deepens `keepFrom`.
- **RAPTOR promotion tests** (new `src/dedup/raptor/promote.test.ts` or extend `raptor.test.ts`): with `RAPTOR_ENABLED`, `vectorStore.search` returns fewer, higher-level nodes than the flat path for the same query; a built tree is served and the root summary covers all leaves; tree refresh after a new checkpoint persists updated `raptor_nodes`.
- **Adaptive compression test** (extend `compression.test.ts` / `vectorStore.test.ts`): as a synthetic session's `pct` rises, `compressedOriginal` size shrinks (brotli-11 at high pressure) and `keepFrom` deepens, while anchor floor is always respected (PREVENT-PI-002).
- **recall.test.ts** additions: inline-dedupe drops a checkpoint whose summary is ≥ `dedupSim` similar to a live window message; block capped at `recallMaxTokens`.
- **Integration**: extend `recall.integration.test.ts` to assert net tokens on a simulated resume (full reload + RAPTOR recall) are ≤ original, and that RAPTOR recall returns broader coverage at lower token cost than flat recall.

## Risks / HALT checks
- PREVENT-PI-002 (never split toolCall/toolResult): `driveNativeCompaction` must reuse `computeDropRange` (anchor floor + tool-pair) when mapping to `firstKeptEntryId` — pi's own cut also respects this, but we must not hand pi a firstKeptEntryId that splits a pair. Keep `computeDropRange` as the authority for the boundary.
- PREVENT-PI-004: `defaultEmbedder` (trigram) is local; no `fetch`. The DR zstd path stays user-triggered only. Guardrails-scan must stay green.
- PREVENT-PI-003: recall still injects via `before_agent_start` `systemPrompt` prepend, never `role:"system"`.
- If pi's native compaction threshold doesn't fire when we expect, keep `config.auto` → `ctx.compact()` fallback. Do NOT remove the on/off switch.
- Verify pi actually persists `compactionResult.summary` into a durable `compactionSummary` entry by reading the session file in a spike before wiring for real (or assert via `session_compact` event in the test).
- RAPTOR promotion must stay behind `RAPTOR_ENABLED` + canary p95 auto-disable; the rebuild at compaction time is best-effort and must never block or fail a compaction. Budget guard (`RAPTOR_BUDGET_MS`) must cap wall-clock.
- PREVENT-PI-004 for RAPTOR: extractive summarizer is the default (no network); the localhost-only Ollama path in `summarizer.ts` is already annotated. Guardrails-scan must stay green.
- **Fix E sync constraint**: `add()` stays synchronous — stored checkpoints use sync brotli escalation (brotli-11 via `brotliCompressSync`), NOT zstd. zstd is only on the async DR-export path. Do NOT make `add()`/`compactSession` async. The async cascade was the original reason Trident chose sync zlib (compression.ts:6-8).
- Pressure bands must be deterministic + bounded; `keepFrom` escalation must always respect `computeDropRange` anchor floor + tool-pair (PREVENT-PI-002). No `Date.now`/`Math.random` in hot paths (the workflow scripts forbid it, and it breaks resume determinism).

## Out of scope (do NOT touch)
- The openclaw `registerCompactionProvider` adapter (separate concern; pi extension is primary).
- Removing `@mongodb-js/zstd` from dependencies (keep for DR path).
- Any new persistence format (SQLite stays the only store).
