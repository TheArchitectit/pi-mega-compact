# HyDE/RAG Visibility Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HyDE (Hypothetical Document Embeddings, S43 re-plan) and RAG recall quality visible end-to-end: HyDE telemetry in the recall pipeline, per-turn HyDE markers in the Turns tab, an aggregated RAG-metrics dashboard on the Metrics tab, a mini RAG health card on Overview, and a live HyDE/recall status line on the Setup tab.

**Architecture:** The pi-agnostic `src/` layer has NO access to `runtime`. So the telemetry contract (`HydeInvocationInfo` + recall-quality metrics) is computed in `src/recall/sync.ts` and returned on `RecallInjectResult`; the extension layer (`extensions/mega-pipeline/recall.ts`) reads that result and (a) emits `dashboard.event("hyde_executed")` + `dashboard.event("recall_metrics")` → `events.log` → dashboard SSE, and (b) persists per-turn HyDE/recall columns on the turn row via `recordTurnWrite`. The aggregated view is served by a new `GET /api/rag-metrics` route that reads the turns.db columns (append-only — telemetry written once at turn-record time, never `UPDATE`d). All reads/writes are pure local `node:sqlite`, parameterized (PREVENT-002), non-fatal, and SSE events travel over the existing JSONL `events.log` tail.

```
src/recall/sync.ts (HyDE fires or is skipped → hydeInfo on result; metrics score)
  → RecallInjectResult extended with hydeInfo   (src/ is pi-agnostic — NO runtime)
  → extensions/mega-pipeline/recall.ts reads hydeInfo from result
      → runtime.dashboard.event("hyde_executed") / ("recall_metrics") → events.log → dashboard SSE
      → recordTurnWrite(..., hyde, recallMetrics) → turns.db new columns (one INSERT, append-only)
  → routes-rag-metrics.ts aggregates turns.db columns → GET /api/rag-metrics → Metrics/Overview/Setup tabs
```

**Tech Stack:** TypeScript (ESM, Node ≥22.13), `node:sqlite` (`DatabaseSync`), `node --test`, React + shadcn/ui + recharts (dashboard client), `python3 scripts/regression_check.py --all`.

**Parent spec:** `docs/superpowers/specs/2026-08-02-hyde-rag-visibility-design.md` — read it first; this plan implements it.

**Branch:** new branch `feat/hyde-rag-visibility` off `master` @ `57a8067`. Do not commit to `master`. Verify gate every commit: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` and `node scripts/guardrails-scan.mjs`. For dashboard UI also run `npm run build:dashboard` + `node scripts/dashboard-tab-smoke.mjs`.

**In-flight coordination:** `SCHEMA_VERSION` 2→3 and the wiki tables are shared with Spec 3 (`2026-08-02-wiki-revival`) — both use the idempotent `ensureColumn` idiom, so they coexist. Coordinate the single bump with the wiki agent at commit time.

**Feature flags** (all default ON, env-overridable OFF — flag-OFF = byte-identical to pre-sprint):
- `MEGACOMPACT_RECALL_METRICS_DISABLED` — gates the `/api/rag-metrics` endpoint, `recall_metrics` SSE, Metrics-tab section.
- `MEGACOMPACT_HYDE_DISABLED` — gates HyDE telemetry (`hyde_executed` SSE + run columns).
- `MEGACOMPACT_NEW_UI_DISABLED` — gates the new dashboard components (from Spec 1).

## Progress Tracker (updated 2026-08-02)

| Sprint | Status | Commits | Notes |
|--------|--------|---------|-------|
| H1.1+H1.2 Contract types + sync threading | DONE | `72999ad` | `HydeInvocationInfo`, `RecallMetricsSnapshot`, `hydeTelemetry.ts` builders. Spec + quality reviews passed. |
| H1.3 Schema v3 + hydeStore | DONE | `be761c1` | SCHEMA_VERSION 2→3, 13 telemetry columns via ensureColumn. `hydeStore.ts` read helpers. |
| H1.4 Turn-write adapter + SSE | DONE | `f837c23` | `recordTurnWrite` pipes hyde/recallMetrics into appendTurn. SSE emit in `recall.ts`. |
| H2.1 API contracts | DONE | `e2844b2` | `RagMetricsResponse` type + SSE event types. |
| H2.2 Route handler + tests | DONE | `660b6c9` | `GET /api/rag-metrics` with parameterized SQL, flag gating. 3 handler tests passing. |
| H3 Dashboard UI | **IN PROGRESS** | — | HydeDetailPanel, RagDashboard, RagHealthCard, tab wiring. |
| H4 Integration + QA | PENDING | — | Full gate, live check, flag-off regression, doc map. |

**Guardrail notes (read before coding):** PREVENT-PI-004 (zero network at runtime — the only exception is the optional localhost dashboard server, already audited), PREVENT-002 (all SQL parameterized), PREVENT-011 (no `any`), PREVENT-001 (null-safe JSON at route boundaries). `src/` must stay pi-agnostic — **no `runtime` import anywhere under `src/`**. `toInject` is `SearchHit[]`, NOT a `RecallBlock`. SSE uses `ts: string` (ISO 8601), NOT `ts: number`. Turns table is append-only — telemetry lands in the single INSERT that creates the turn row, never via `UPDATE`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `src/recall/types.ts` | Add `HydeInvocationInfo` + `recallMetrics` to `RecallInjectResult` | modify |
| `src/recall/hydeTelemetry.ts` | NEW. `buildHydeInfo()` pure builder (120 lines) | create |
| `src/recall/sync.ts` | Populate `hydeInfo`; thread recall-metrics into result | modify |
| `src/recall/format.ts` | `scoreAndLogRecallMetrics` returns `RecallMetrics` (was void) | modify |
| `src/recall/hydeTelemetry.test.ts` | NEW. Builder + edge-case tests | create |
| `src/store/turns/schema.ts` | 13 new `turns` columns via `ensureColumn`; bump `SCHEMA_VERSION` 2→3 | modify |
| `src/store/turns/hydeStore.ts` | NEW. HyDE/recall column read helpers (80 lines) | create |
| `src/store/turns/index.ts` | Re-export `hydeStore` readers | modify |
| `extensions/mega-turn-store.ts` | Thread `hyde` + `recallMetrics` through `recordTurnWrite` | modify |
| `extensions/mega-pipeline/recall.ts` | Emit `hyde_executed` + `recall_metrics` SSE; pass telemetry to `recordTurnWrite` | modify |
| `extensions/dashboard-server/api-contracts/rag-metrics.ts` | NEW. Response + SSE types (60 lines) | create |
| `extensions/dashboard-server/api-contracts/core.ts` | Append `SseHydeExecuted` + `SseRecallMetrics` | modify |
| `extensions/dashboard-server/api-contracts/index.ts` | Re-export new types + SSE union members | modify |
| `extensions/dashboard-server/routes-rag-metrics.ts` | NEW. `GET /api/rag-metrics` handler (200 lines) | create |
| `extensions/dashboard-server/routes.ts` | Barrel-export `handleRagMetrics` | modify |
| `extensions/dashboard-server/server.ts` | Add `if (handleRagMetrics(...)) return;` dispatch | modify |
| `extensions/dashboard-server/routes-rag-metrics.test.ts` | NEW. Aggregate-endpoint tests | create |
| `extensions/dashboard-client/src/api/ragMetrics.ts` | NEW. `fetchRagMetrics()` client (40 lines) | create |
| `extensions/dashboard-client/src/api/client.ts` | Register `rag-metrics` endpoint + wrapper | modify |
| `extensions/dashboard-client/src/components/HydeDetailPanel.tsx` | NEW. Expandable HyDE detail (120 lines) | create |
| `extensions/dashboard-client/src/components/RagDashboard.tsx` | NEW. RAG metrics section — 5 sub-charts (180 lines) | create |
| `extensions/dashboard-client/src/components/RagHealthCard.tsx` | NEW. Mini RAG health summary card (80 lines) | create |
| `extensions/dashboard-client/src/tabs/TurnsTab.tsx` | HyDE column + expandable `HydeDetailPanel` | modify |
| `extensions/dashboard-client/src/tabs/MetricsTab.tsx` | Render `<RagDashboard/>` below existing charts | modify |
| `extensions/dashboard-client/src/tabs/OverviewTab.tsx` | Render `<RagHealthCard/>` in card grid | modify |
| `extensions/dashboard-client/src/tabs/SetupTab.tsx` / `RagSettingsCard` | HyDE status line under the HyDE toggle | modify |
| `extensions/dashboard-client/src/tabs/EventsTab.tsx` | Add `hyde_executed` + `recall_metrics` to the event filter | modify |
| `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md` | Register new files | modify |
| `docs/superpowers/specs/2026-08-02-hyde-rag-visibility-design.md` | Mark plan-done in status | modify |

**Helper reference (read these before coding):**
- `src/store/turns/connection.ts` — `openTurnStore(stateDir)`.
- `src/store/sqlite/schema.ts:25` — the `ensureColumn` idiom (PRAGMA `table_info` guard + `ALTER TABLE`).
- `src/store/turns/schema.ts` — `SCHEMA_VERSION` + the `// Stamp schema version once` block.
- `src/store/turns/sqlite-store.ts` — `appendTurn`/`selectTurn` column lists (must add the 13 columns there).
- `src/recall/sync.ts` — the HyDE block (lines 97–129) + `scoreAndLogRecallMetrics` call (line 165).
- `src/recall/format.ts` — `scoreAndLogRecallMetrics` is the metrics entry point; change it to return the result.
- `src/recall/recallMetrics.ts` — `computeRecallMetrics(query, hits): RecallMetrics` (has `.breakdown.{relevance,coverage,diversity,specificity}`, `.score`, `.pass`).
- `extensions/mega-pipeline/recall.ts:100` — the `recordTurnWrite` call that already has `result` + `runtime` in scope.
- `extensions/mega-turn-store.ts` — `recordTurnWrite` (the �the seam to thread hyde/recall columns).
- `extensions/dashboard-server/routes-rag-settings.ts` — route-handler idiom (`RouteContext`, `sendJson`).
- `extensions/dashboard-server/routes.ts` + `server.ts` — barrel + dispatch registration pattern.
- `extensions/dashboard-server/api-contracts/core.ts:195` — `SseRecallInject` (the `ts: string` SSE idiom to mirror).
- `extensions/dashboard-client/src/api/client.ts` — `getJson` + `ENDPOINTS` registry.
- `docs/superpowers/plans/2026-08-02-visual-design-migration.md` — the `MEGACOMPACT_NEW_UI_DISABLED` gating idiom for new components.

---

## Sprint H1 — Telemetry Pipeline (src/ + extension SSE)

Goal: HyDE + recall-quality telemetry flows from the pi-agnostic recall core up into `RecallInjectResult`, then into the dashboard SSE stream and the turns.db columns.

### Task H1.1: Contract types + HyDE info builder

**Files:**
- Modify: `src/recall/types.ts`
- Create: `src/recall/hydeTelemetry.ts`
- Test: `src/recall/hydeTelemetry.test.ts`

- [ ] **Step 1: Add `HydeInvocationInfo` + the metrics field to `RecallInjectResult`**

In `src/recall/types.ts`, after the `RecallInjectResult` interface (line 49), add the new interface and extend `RecallInjectResult`. Mirror the existing file's tab-indent style.

```ts
export interface HydeInvocationInfo {
	/** True when HyDE ran (LLM generated a hypothetical doc + embedded + searched). */
	ran: boolean;
	/** True when HyDE was considered but explicitly skipped (e.g. no LLM surface). */
	skipped: boolean;
	/** Human-readable reason: "ran", "disabled", "no-llm", "generation-failed". */
	reason: string;
	/** The hypothetical answer document the LLM produced ("" when skipped/failed). */
	hypotheticalDoc: string;
	/** Wall-clock ms spent generating + embedding the hypothetical doc (0 when skipped). */
	generationMs: number;
	/** Hit count from the raw-query search before fusion. */
	rawHitCount: number;
	/** Hit count from the hypothetical-doc search before fusion. */
	hydeHitCount: number;
	/** Hit count of the RRF-fused result actually injected (after dedupe+cap). */
	fusedHitCount: number;
	/** Lift = fusedHitCount / max(1, rawHitCount) — how much HyDE changed recall breadth. */
	lift: number;
}

export interface RecallInjectResult {
	/** Blocks that are ready to inline (already deduped against the window). */
	toInject: SearchHit[];
	/** Human-readable lines for status/notify reporting. */
	report: string[];
	/** The concatenated, model-visible recall block (empty when nothing new). */
	block: string;
	/** True when nothing new was inlined. */
	empty: boolean;
	/** H1: HyDE invocation telemetry for this recall pass. Non-null always (null only
	 *  when the result predates this sprint — callers guard for null). */
	hydeInfo: HydeInvocationInfo | null;
	/** H1: recall-quality metrics (only populated when RAG_RECALL_METRICS() is ON). */
	recallMetrics: RecallMetricsSnapshot | null;
}

/** Slim, serialization-safe slice of RecallQualityResult for persistence + SSE. */
export interface RecallMetricsSnapshot {
	hitCount: number;
	score: number;
	pass: boolean;
	relevance: number;
	coverage: number;
	diversity: number;
	specificity: number;
}
```

- [ ] **Step 2: Write `src/recall/hydeTelemetry.ts`**

A pure builder — no I/O, no logging. It synthesizes a `HydeInvocationInfo` from the inputs `recallAndInline` already has, so `sync.ts` stays a thin caller. Pi-agnostic (no pi types, no runtime).

```ts
/**
 * hydeTelemetry.ts — H1: build the HydeInvocationInfo telemetry for a recall pass.
 *
 * Pure builder: given the inputs sync.ts already computed, produce a
 * serialization-safe snapshot of whether/how HyDE ran and what it changed.
 * Pi-agnostic: no I/O, no logging, no pi runtime types. Non-fatal by nature.
 */

/** Four named reasons a HyDE pass takes one of its shapes. */
export type HydeOutcome =
	| "ran"
	| "disabled"
	| "no-llm"
	| "generation-failed";

export function buildHydeInfo(
	outcome: HydeOutcome,
	hypotheticalDoc: string,
	generationMs: number,
	rawHitCount: number,
	hydeHitCount: number,
	fusedHitCount: number,
): HydeInvocationInfo {
	const ran = outcome === "ran";
	const skipped = !ran;
	const lift =
		ran && rawHitCount > 0 ? fusedHitCount / rawHitCount : fusedHitCount;
	return {
		ran,
		skipped,
		reason: outcome,
		hypotheticalDoc,
		generationMs: ran ? generationMs : 0,
		rawHitCount,
		hydeHitCount: ran ? hydeHitCount : 0,
		fusedHitCount,
		lift: Math.round(lift * 100) / 100,
	};
}

/** A "HyDE did not run at all" snapshot — the common case on TrigramEmbedder. */
export function hydeSkipped(
	reason: "disabled" | "no-llm" | "generation-failed",
	rawHitCount: number,
	fusedHitCount: number,
): HydeInvocationInfo {
	return buildHydeInfo(
		reason,
		"",
		0,
		rawHitCount,
		0,
		fusedHitCount,
	);
}
```

- [ ] **Step 3: Write `src/recall/hydeTelemetry.test.ts`**

Uses real (empty) pure function calls — no store needed. Tests the four outcome shapes and the lift math. Follow the repo's `node --test` + `node:assert/strict` style.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHydeInfo, hydeSkipped } from "./hydeTelemetry.js";

test("buildHydeInfo: ran with lift", () => {
	const info = buildHydeInfo("ran", "hypo doc", 42, 4, 6, 5);
	assert.equal(info.ran, true);
	assert.equal(info.skipped, false);
	assert.equal(info.reason, "ran");
	assert.equal(info.hypotheticalDoc, "hypo doc");
	assert.equal(info.generationMs, 42);
	assert.equal(info.rawHitCount, 4);
	assert.equal(info.hydeHitCount, 6);
	assert.equal(info.fusedHitCount, 5);
	// fused 5 / raw 4 → lift 1.25
	assert.equal(info.lift, 1.25);
});

test("buildHydeInfo: generation-failed zeroes hyde-only fields", () => {
	const info = buildHydeInfo("generation-failed", "", 0, 4, 0, 4);
	assert.equal(info.ran, false);
	assert.equal(info.skipped, true);
	assert.equal(info.generationMs, 0);
	assert.equal(info.hydeHitCount, 0);
	assert.equal(info.hypotheticalDoc, "");
	assert.equal(info.lift, 1); // fused === raw → no change
});

test("buildHydeInfo: no raw hits never divides by zero", () => {
	const info = buildHydeInfo("ran", "doc", 5, 0, 0, 3);
	assert.equal(info.rawHitCount, 0);
	assert.equal(info.lift, 3); // falls back to fusedHitCount
});

test("hydeSkipped: disabled shape", () => {
	const info = hydeSkipped("disabled", 4, 4);
	assert.equal(info.reason, "disabled");
	assert.equal(info.ran, false);
	assert.equal(info.hydeHitCount, 0);
});
```

- [ ] **Step 4: Run the new unit test + gate**

```bash
npm run build && node --test dist/src/recall/hydeTelemetry.test.js
```
Expected output: the test file passes (all 4 tests green), no type errors from Step 1/2.

**Commit:** `H1.1 — HyDE telemetry contract + pure builder` (all three files).

### Task H1.2: Thread telemetry through `src/recall/sync.ts`

**Files:**
- Modify: `src/recall/sync.ts`
- Modify: `src/recall/format.ts`

- [ ] **Step 1: Make `scoreAndLogRecallMetrics` return the snapshot**

In `src/recall/format.ts`, change `scoreAndLogRecallMetrics` (line 153) from `void` to return `RecallMetricsSnapshot | null` so `sync.ts` can forward it. Import the snapshot type and `computeRecallMetrics`'s breakdown. Keep the existing logging exactly as-is (flag behavior unchanged).

```ts
import { computeRecallMetrics, type RecallQualityResult } from "../recallMetrics.js";
import type { RecallMetricsSnapshot } from "./types.js";

/**
 * B3: Compute recall-quality metrics on the injected hits, log them, and return
 * a serialization-safe snapshot for the extension to persist + SSE. Only called
 * when RAG_RECALL_METRICS() is ON. Non-fatal — returns null on any error.
 */
export function scoreAndLogRecallMetrics(
	query: string,
	toInject: SearchHit[],
): RecallMetricsSnapshot | null {
	try {
		const logger = new Logger();
		const metrics = computeRecallMetrics(query, toInject);
		logger.info("recall_metrics", {
			hitCount: toInject.length,
			score: metrics.score,
			pass: metrics.pass,
		});
		if (!metrics.pass && toInject.length > 0) {
			logger.info("recall_metrics_low_quality", {
				score: metrics.score,
				relevance: metrics.breakdown.relevance,
				coverage: metrics.breakdown.coverage,
				diversity: metrics.breakdown.diversity,
			});
		}
		return {
			hitCount: toInject.length,
			score: metrics.score,
			pass: metrics.pass,
			relevance: metrics.breakdown.relevance,
			coverage: metrics.breakdown.coverage,
			diversity: metrics.breakdown.diversity,
			specificity: metrics.breakdown.specificity,
		};
	} catch {
		/* non-fatal: metrics never break recall */
		return null;
	}
}
```

- [ ] **Step 2: Wire HyDE telemetry + metrics into `recallAndInline`**

In `src/recall/sync.ts`:
1. Import `buildHydeInfo, hydeSkipped` from `./hydeTelemetry.js`.
2. Track `hydeDoc`, `hydeGenMs`, `hydeRaw`, `hydeHyde` around the existing HyDE block (lines 97–129) so a skip (no-LLM / disabled / generation-failed / fused-empty) records the correct outcome.
3. Populate `hydeInfo` and `recallMetrics` on the returned result.

Replace the HyDE block (lines 97–129) with the telemetry-tracking version:

```ts
	let hydeHits: SearchHit[] | null = null;
	let hydeDoc = "";
	let hydeGenMs = 0;
	// H1: telemetry inputs — counts reflect the pre-fusion sets.
	const hydeRawCount = 0; // raw-query search count is computed below
	if (RAG_HYDE_ENABLED() && embedder.kind === "http") {
		const t0 = Date.now();
		const hyde = generateHypotheticalDoc(opts.query, embedder);
		hydeGenMs = Date.now() - t0;
		if (hyde) {
			hydeDoc = hyde;
			try {
				const r2 = searchRecall(
					{ sessionId: opts.sessionId, query: hyde, limit, skipInjected: skip },
					store,
				);
				hydeHits = r2.newHits;
			} catch {
				hydeHits = null;
			}
		}
	}
```

Then, after `newHits` is resolved (after the tiered-router branch, line 122) and before the fusion (line 127), record the raw count, and after fusion record the fused count:

```ts
	const hydeRawCount = newHits.length; // raw-query search breadth (pre-fusion)
	let fusedCount = newHits.length;
	if (hydeHits && hydeHits.length > 0) {
		newHits = fuseRecallHits(newHits, hydeHits, limit);
		fusedCount = newHits.length;
	}
```

Finally, before the `return` (replace the current return block, lines 191–196):

```ts
	// H1: synthesize HyDE telemetry. Ran only when an LLM HttpEmbedder generated a
	// doc AND produced hits; otherwise record the narrower reason.
	let hydeInfo: HydeInvocationInfo;
	if (RAG_HYDE_ENABLED() && embedder.kind === "http") {
		hydeInfo =
			hydeHits && hydeHits.length > 0
				? buildHydeInfo(
						"ran",
						hydeDoc,
						hydeGenMs,
						hydeRawCount,
						hydeHits.length,
						fusedCount,
					)
				: hydeSkipped(
						hydeDoc ? "generation-failed" : "no-llm",
						hydeRawCount,
						fusedCount,
					);
	} else {
		hydeInfo = hydeSkipped("disabled", hydeRawCount, fusedCount);
	}

	// H1: recall-quality metrics (flag-ON only). scoreAndLogRecallMetrics already
	// logs under the same flag; we forward its snapshot for persistence + SSE.
	let recallMetrics: RecallMetricsSnapshot | null = null;
	if (RAG_RECALL_METRICS()) {
		recallMetrics = scoreAndLogRecallMetrics(opts.query, toInject);
	}

	return {
		toInject,
		report,
		block,
		empty: block.length === 0,
		hydeInfo,
		recallMetrics,
	};
```

- [ ] **Step 3: Verify the src/ recall gate**

```bash
npm run build && npm test
```
Expected output: build clean, full `node --test` suite green (existing recall integration tests still pass — the new fields are additive; any test that constructs a literal `RecallInjectResult` will need the two new fields added, fix those in the same commit).

**Commit:** `H1.2 — recall core emits hydeInfo + recallMetrics on result`.

### Task H1.3: turns.db schema — 13 telemetry columns + SCHEMA_VERSION 3

**Files:**
- Modify: `src/store/turns/schema.ts` (also the wiki agent's file — coordinate the single version bump)
- Create: `src/store/turns/hydeStore.ts`
- Modify: `src/store/turns/index.ts`

- [ ] **Step 1: Add the 13 columns via `ensureColumn` in `initTurnSchema`**

In `src/store/turns/schema.ts`, inside `initTurnSchema` (before the `// Stamp schema version once` block — find it after the `memory_topics` index), add an idempotent `ensureColumn` pass. These columns go on the ALREADY-EXISTING `turns` table in the wild, so `CREATE TABLE IF NOT EXISTS` is a no-op — use the PRAGMA guard + `ALTER TABLE` idiom (identical to the wiki plan's `memory_topics.session_id` approach).

```ts
	// ── H1 HyDE/RAG visibility (Spec 2): 13 additive telemetry columns on turns ──
	// Idempotent: PRAGMA table_info guards each ALTER so running twice is a no-op.
	// NULL default → existing turns show "—" (no-recall) until a turn records.
	const ensureCol = (name: string, ddl: string): void => {
		const has = (
			db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>
		).some((c) => c.name === name);
		if (!has) db.exec(`ALTER TABLE turns ADD COLUMN ${ddl}`);
	};
	ensureCol("hyde_ran", "hyde_ran INTEGER DEFAULT 0");
	ensureCol("hyde_doc", "hyde_doc TEXT DEFAULT ''");
	ensureCol("hyde_raw_count", "hyde_raw_count INTEGER DEFAULT 0");
	ensureCol("hyde_hyde_count", "hyde_hyde_count INTEGER DEFAULT 0");
	ensureCol("hyde_fused_count", "hyde_fused_count INTEGER DEFAULT 0");
	ensureCol("hyde_lift", "hyde_lift REAL DEFAULT 0");
	ensureCol("hyde_generation_ms", "hyde_generation_ms INTEGER DEFAULT 0");
	ensureCol("recall_score", "recall_score REAL DEFAULT 0");
	ensureCol("recall_pass", "recall_pass INTEGER DEFAULT 0");
	ensureCol("recall_relevance", "recall_relevance REAL DEFAULT 0");
	ensureCol("recall_coverage", "recall_coverage REAL DEFAULT 0");
	ensureCol("recall_diversity", "recall_diversity REAL DEFAULT 0");
	ensureCol("recall_specificity", "recall_specificity REAL DEFAULT 0");
```

- [ ] **Step 2: Bump `SCHEMA_VERSION` 2→3**

Change the `const SCHEMA_VERSION = 2;` (line 19) to `3`. Coordinate the single bump with the Spec-3 wiki agent (they also target v3) — whoever lands first bumps it; the other confirms the value is already `3` and does not re-bump. The `ensureColumn` pattern is idempotent so ordering is irrelevant.

- [ ] **Step 3: Write `src/store/turns/hydeStore.ts`**

Read helpers over the telemetry columns (aggregation for `/api/rag-metrics`). Uses `openTurnStore` internally via the connection module. All queries parameterized (PREVENT-002).

```ts
/**
 * hydeStore.ts — H1: read helpers over the turns.db HyDE/recall telemetry columns.
 *
 * Aggregates the 13 additive columns on `turns` for the dashboard
 * (/api/rag-metrics). Read-only — the columns are written once at turn-record
 * time; nothing here mutates (append-only invariant). Pi-agnostic: takes a
 * raw DatabaseSync (the extension owns the connection lifecycle).
 */
import type { DatabaseSync } from "node:sqlite";

/** One turn's telemetry row (only the columns this sprint added). */
export interface TurnTelemetryRow {
	turnId: string;
	conversationId: string;
	turnIndex: number;
	role: string;
	endedAt: number;
	hydeRan: number;
	hydeDoc: string;
	hydeRawCount: number;
	hydeHydeCount: number;
	hydeFusedCount: number;
	hydeLift: number;
	hydeGenerationMs: number;
	recallScore: number;
	recallPass: number;
	recallRelevance: number;
	recallCoverage: number;
	recallDiversity: number;
	recallSpecificity: number;
}

/** Rows that have at least one telemetry signal (HyDE ran OR metrics recorded),
 *  newest first, capped to `limit`. */
export function listTelemetryTurns(
	db: DatabaseSync,
	opts: { limit?: number } = {},
): TurnTelemetryRow[] {
	const limit = Math.max(1, opts.limit ?? 200);
	const rows = db
		.prepare(
			`SELECT turn_id AS turnId, conversation_id AS conversationId,
			        turn_index AS turnIndex, role, ended_at AS endedAt,
			        hyde_ran AS hydeRan, hyde_doc AS hydeDoc,
			        hyde_raw_count AS hydeRawCount, hyde_hyde_count AS hydeHydeCount,
			        hyde_fused_count AS hydeFusedCount, hyde_lift AS hydeLift,
			        hyde_generation_ms AS hydeGenerationMs,
			        recall_score AS recallScore, recall_pass AS recallPass,
			        recall_relevance AS recallRelevance, recall_coverage AS recallCoverage,
			        recall_diversity AS recallDiversity, recall_specificity AS recallSpecificity
			 FROM turns
			 WHERE hyde_ran = 1 OR recall_pass IS NOT NULL
			 ORDER BY ended_at DESC
			 LIMIT ?`,
		)
		.all(limit) as TurnTelemetryRow[];
	return rows;
}

/** Aggregate one-day buckets for the hit-rate + latency trends. Returns
 *  {day, recallCount, hydeRanCount, avgScore, avgLift, avgGenMs}. */
export function aggregateDailyTelemetry(
	db: DatabaseSync,
	days: number,
): DailyTelemetry[] {
	const since = Date.now() - days * 86_400_000;
	return db
		.prepare(
			`SELECT date(ended_at / 1000, 'unixepoch') AS day,
			        COUNT(*) AS recallCount,
			        SUM(hyde_ran) AS hydeRanCount,
			        AVG(recall_score) AS avgScore,
			        AVG(hyde_lift) AS avgLift,
			        AVG(hyde_generation_ms) AS avgGenMs
			 FROM turns
			 WHERE ended_at >= ? AND (hyde_ran = 1 OR recall_pass IS NOT NULL)
			 GROUP BY day ORDER BY day ASC`,
		)
		.all(since) as DailyTelemetry[];
}

export interface DailyTelemetry {
	day: string;
	recallCount: number;
	hydeRanCount: number;
	avgScore: number | null;
	avgLift: number | null;
	avgGenMs: number | null;
}
```

- [ ] **Step 4: Re-export from `src/store/turns/index.ts`**

Add to the barrel:

```ts
export {
	listTelemetryTurns,
	aggregateDailyTelemetry,
} from "./hydeStore.js";
export type {
	TurnTelemetryRow,
	DailyTelemetry,
} from "./hydeStore.js";
```

- [ ] **Step 5: Add the 13 columns to the `sqlite-store.ts` INSERT/read lists**

Find the `appendTurn` INSERT column list and the `selectTurn` row mapping in `src/store/turns/sqlite-store.ts`; append the 13 `hyde_*`/`recall_*` columns to the INSERT (from the `TurnEntry` fields the adapter will now populate) and to the row-projection map. Follow the existing column-ordering style. This is the only place the columns are *written* (single INSERT at appendTurn — append-only preserved).

**Commit:** `H1.3 — turns.db HyDE/recall telemetry columns (SCHEMA v3)`.

### Task H1.4: Turn-write adapter + extension SSE emission

**Files:**
- Modify: `extensions/mega-turn-store.ts`
- Modify: `extensions/mega-pipeline/recall.ts`
- Test: `extensions/mega-turn-store.test.ts` (extend)

- [ ] **Step 1: Thread telemetry through `recordTurnWrite`**

In `extensions/mega-turn-store.ts`, extend `recordTurnWrite`'s input with optional `hyde` + `recallMetrics` fields and forward them onto the `TurnEntry` passed to `appendTurn`. The `TurnEntry` in `src/store/turns/types.ts` is extended in the same commit with matching optional fields so the sqlite-store INSERT picks them up.

```ts
export function recordTurnWrite(
	config: MegaConfig,
	input: {
		conversationId: string;
		sessionId: string;
		turnIndex: number;
		role: string;
		startedAt?: number;
		endedAt?: number;
		ctxTokens?: number;
		ctxPercent?: number;
		pressureBand?: string;
		modelId?: string;
		epochId?: string;
		/** H1: HyDE telemetry for this turn's recall pass (best-effort). */
		hyde?: RecallHydeWrite;
		/** H1: recall-quality metrics snapshot (flag-ON only). */
		recallMetrics?: RecallMetricsSnapshot | null;
	},
	stateDir: string,
): string {
	// ...legacy branch unchanged...
	const entry: TurnEntry = {
		conversationId: input.conversationId,
		sessionId: input.sessionId,
		turnIndex: input.turnIndex,
		role: input.role as TurnEntry["role"],
		endedAt: input.endedAt ?? input.startedAt ?? Date.now(),
		ctxTokens: input.ctxTokens,
		ctxPercent: input.ctxPercent,
		pressureBand: input.pressureBand as TurnEntry["pressureBand"],
		model: input.modelId,
		epochId: input.epochId,
		// H1 telemetry — best-effort: undefined/null → the INSERT writes defaults.
		hydeRan: input.hyde?.ran ? 1 : 0,
		hydeDoc: input.hyde?.hypotheticalDoc ?? "",
		hydeRawCount: input.hyde?.rawHitCount ?? 0,
		hydeHydeCount: input.hyde?.hydeHitCount ?? 0,
		hydeFusedCount: input.hyde?.fusedHitCount ?? 0,
		hydeLift: input.hyde?.lift ?? 0,
		hydeGenerationMs: input.hyde?.generationMs ?? 0,
		recallScore: input.recallMetrics?.score ?? 0,
		recallPass: input.recallMetrics?.pass ? 1 : 0,
		recallRelevance: input.recallMetrics?.relevance ?? 0,
		recallCoverage: input.recallMetrics?.coverage ?? 0,
		recallDiversity: input.recallMetrics?.diversity ?? 0,
		recallSpecificity: input.recallMetrics?.specificity ?? 0,
	};
	return storeFor(stateDir).appendTurn(entry);
}
```

Add the small `RecallHydeWrite` import/type (a structural subset of `HydeInvocationInfo`) and the matching optional fields to `TurnEntry` in `types.ts`.

- [ ] **Step 2: Emit SSE + pass telemetry in `extensions/mega-pipeline/recall.ts`**

In `doRecall`, after `runtime.dashboard.event("recall", {...})` (line 63) and while `runtime` + `result` are in scope, emit the two new events. Then feed `result.hydeInfo` + `result.recallMetrics` into the existing `recordTurnWrite` call (line 100).

```ts
	// H1: HyDE invocation telemetry → events.log → dashboard SSE. Flag-gated on
	// RECALL_METRICS (the panel that surfaces it) — still emitted when HyDE itself
	// is disabled so the panel can show "off". Best-effort, non-fatal.
	if (config.ragRecallMetrics && result.hydeInfo) {
		runtime.dashboard.event("hyde_executed", {
			sessionId: sid,
			ran: result.hydeInfo.ran,
			skipped: result.hydeInfo.skipped,
			reason: result.hydeInfo.reason,
			hypotheticalDoc: result.hydeInfo.hypotheticalDoc.slice(0, 400),
			generationMs: result.hydeInfo.generationMs,
			rawHitCount: result.hydeInfo.rawHitCount,
			hydeHitCount: result.hydeInfo.hydeHitCount,
			fusedHitCount: result.hydeInfo.fusedHitCount,
			lift: result.hydeInfo.lift,
		});
	}
	if (config.ragRecallMetrics && result.recallMetrics) {
		runtime.dashboard.event("recall_metrics", {
			sessionId: sid,
			hitCount: result.recallMetrics.hitCount,
			score: result.recallMetrics.score,
			pass: result.recallMetrics.pass,
			relevance: result.recallMetrics.relevance,
			coverage: result.recallMetrics.coverage,
			diversity: result.recallMetrics.diversity,
			specificity: result.recallMetrics.specificity,
		});
	}
```

And in the `recordTurnWrite` call (inside the existing `if (result.toInject.length > 0) {` block / provenance `try`), add the two fields:

```ts
				const turnId = recordTurnWrite(
					config,
					{
						conversationId: convId,
						sessionId: sid,
						turnIndex: runtime.currentTurn,
						role: "assistant",
						startedAt: Date.now(),
						hyde: result.hydeInfo ?? undefined,
						recallMetrics: result.recallMetrics,
					},
					runtime.currentStateDir,
				);
```

`config.ragRecallMetrics` is the real `MegaConfig` field (extensions/mega-config.ts:377, from `MEGACOMPACT_RECALL_METRICS`) — use it, not any invented name. Wire `runtime.currentStateDir`/`runtime.store`/`runtime.dashboard` as already used in this file.

- [ ] **Step 3: Extend `extensions/mega-turn-store.test.ts`**

Add a case asserting that `recordTurnWrite` with `hyde` + `recallMetrics` produces a `TurnEntry` whose `appendTurn`-persisted row carries the hyde/recall values (query via `asReader()` and assert the new `TurnEntry` optional fields). Follow the existing test's mkdtemp/`createTurnStore` setup.

**Commit:** `H1.4 — extension emits hyde_executed/recall_metrics SSE + persists turn columns` (then run the full gate `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`).

---

## Sprint H2 — Backend API (`GET /api/rag-metrics`)

Goal: expose aggregated HyDE + recall stats, trends, flag status, and latency breakdown to the dashboard, plus the two SSE contract types.

### Task H2.1: API contracts

**Files:**
- Create: `extensions/dashboard-server/api-contracts/rag-metrics.ts`
- Modify: `extensions/dashboard-server/api-contracts/core.ts`
- Modify: `extensions/dashboard-server/api-contracts/index.ts`

- [ ] **Step 1: Write `extensions/dashboard-server/api-contracts/rag-metrics.ts`**

```ts
/**
 * rag-metrics.ts — H2: contracts for GET /api/rag-metrics + the two recall SSE
 * events surfaced by the RAG Visibility dashboard.
 */
import type { TurnTelemetryRow, DailyTelemetry } from "../../../src/store/turns/hydeStore.js";

/** Aggregated HyDE + recall-quality stats response. */
export interface RagMetricsResponse {
	/** Enabled-state of the feature flags that gate this surface. */
	flags: {
		hydeEnabled: boolean;
		recallMetricsEnabled: boolean;
	};
	/** Rolling totals across telemetry-bearing turns. */
	totals: {
		telemetryTurns: number;
		hydeRanTurns: number;
		avgLift: number;
		avgScore: number | null;
		avgGenerationMs: number;
		recentPassRate: number; // recent fraction of recall metrics that passed
	};
	/** One point per recent turn (for the lift/score scatter + line charts). */
	recent: TurnTelemetryRow[];
	/** Daily buckets (for hit-rate area + latency stacked bar). */
	daily: DailyTelemetry[];
}

/** SSE: emitted once per before_agent_start when recall runs. */
export interface SseHydeExecuted {
	type: "hyde_executed";
	ts: string; // ISO 8601
	sessionId: string;
	ran: boolean;
	skipped: boolean;
	reason: string;
	hypotheticalDoc: string;
	generationMs: number;
	rawHitCount: number;
	hydeHitCount: number;
	fusedHitCount: number;
	lift: number;
}

/** SSE: emitted per recall pass when RAG_RECALL_METRICS() is ON. */
export interface SseRecallMetrics {
	type: "recall_metrics";
	ts: string; // ISO 8601
	sessionId: string;
	hitCount: number;
	score: number;
	pass: boolean;
	relevance: number;
	coverage: number;
	diversity: number;
	specificity: number;
}
```

- [ ] **Step 2: Append the two SSE types to `core.ts`**

In `extensions/dashboard-server/api-contracts/core.ts`, after `SseRecallInject` (line 206), add both interfaces re-imported from `rag-metrics.js` (exported from there, but the union needs local declarations in `core.ts` to keep the barrel clean — mirror how `SseRecallInject` is declared in `core.ts`). Add:

```ts
/**
 * H1: SSE event emitted once per before_agent_start when recall runs, carrying
 * whether HyDE fired, why not, the hypothetical doc, and the hit/lift math.
 */
export interface SseHydeExecuted {
	type: "hyde_executed";
	/** ISO 8601 timestamp. */
	ts: string;
	sessionId: string;
	ran: boolean;
	skipped: boolean;
	reason: string;
	hypotheticalDoc: string;
	generationMs: number;
	rawHitCount: number;
	hydeHitCount: number;
	fusedHitCount: number;
	lift: number;
}

/** H1: SSE event carrying recall-quality metrics for one recall pass. */
export interface SseRecallMetrics {
	type: "recall_metrics";
	/** ISO 8601 timestamp. */
	ts: string;
	sessionId: string;
	hitCount: number;
	score: number;
	pass: boolean;
	relevance: number;
	coverage: number;
	diversity: number;
	specificity: number;
}
```

- [ ] **Step 3: Update the barrel `index.ts`**

Add the two new types to the import block, the re-export block, and the `SseEvent` union (lines 22, 100, 156–177):

```ts
export type {
	RagMetricsResponse,
	SseHydeExecuted,
	SseRecallMetrics,
} from "./rag-metrics.js";
```
and in the union:
```ts
	| SseHydeExecuted
	| SseRecallMetrics
```

**Commit:** `H2.1 — rag-metrics + SSE contracts`.

### Task H2.2: Route handler + registration

**Files:**
- Create: `extensions/dashboard-server/routes-rag-metrics.ts`
- Create: `extensions/dashboard-server/routes-rag-metrics.test.ts`
- Modify: `extensions/dashboard-server/routes.ts`
- Modify: `extensions/dashboard-server/server.ts`

- [ ] **Step 1: Write `routes-rag-metrics.ts`**

Model on `routes-turns.ts` (which defines its own local three-arg `sendJson(res, status, body)` and opens the turn DB per request). The hydeStore readers take a raw `DatabaseSync`, so open it via `openTurnStore(ctx.stateDir)` (mirroring `routes-turns.ts`). Flag state comes straight from the `src/config.js` helpers (`RAG_RECALL_METRICS()`, `RAG_HYDE_ENABLED()`).

```ts
/**
 * routes-rag-metrics.ts — H2: GET /api/rag-metrics — aggregated HyDE + recall
 * quality stats, trends, flag status, latency breakdown.
 *
 * Guardrails: PREVENT-002 (parameterized reads — hydeStore owns the SQL),
 * PREVENT-011 (no `any`), PREVENT-PI-004 (loopback-only). Read-only via the
 * pi-agnostic hydeStore readers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import {
	listTelemetryTurns,
	aggregateDailyTelemetry,
} from "../../src/store/turns/hydeStore.js";
import { RAG_HYDE_ENABLED, RAG_RECALL_METRICS } from "../../src/config.js";
import type { RagMetricsResponse } from "./api-contracts/rag-metrics.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.end(JSON.stringify(body));
}

/** Handle GET /api/rag-metrics. Returns false when not the matching path. */
export function handleRagMetrics(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (url !== "/api/rag-metrics" || req.method !== "GET") return false;

	let db;
	try {
		db = openTurnStore(ctx.stateDir);
	} catch {
		db = null; // non-fatal: no turns.db → empty response
	}
	const recent = db ? listTelemetryTurns(db, { limit: 200 }) : [];
	const daily = db ? aggregateDailyTelemetry(db, 14) : [];

	const hydeRanTurns = recent.filter((t) => t.hydeRan === 1).length;
	const liftSum = recent.reduce((s, t) => s + t.hydeLift, 0);
	const genSum = recent.reduce((s, t) => s + t.hydeGenerationMs, 0);
	const scored = recent.filter((t) => t.recallScore > 0 || t.recallPass === 1);
	const avgScore =
		scored.length > 0
			? Math.round((scored.reduce((s, t) => s + t.recallScore, 0) / scored.length) * 100) / 100
			: null;
	const passCount = scored.filter((t) => t.recallPass === 1).length;
	const recentPassRate =
		scored.length > 0 ? Math.round((passCount / scored.length) * 100) / 100 : 0;

	const body: RagMetricsResponse = {
		flags: {
			hydeEnabled: RAG_HYDE_ENABLED(),
			recallMetricsEnabled: RAG_RECALL_METRICS(),
		},
		totals: {
			telemetryTurns: recent.length,
			hydeRanTurns,
			avgLift: recent.length > 0 ? Math.round((liftSum / recent.length) * 100) / 100 : 0,
			avgScore,
			avgGenerationMs: recent.length > 0 ? Math.round(genSum / recent.length) : 0,
			recentPassRate,
		},
		recent: recent.slice(0, 50),
		daily,
	};
	sendJson(res, 200, body);
	return true;
}
```

> **Note:** do NOT add `openTurnStore()`/flag accessors to `RouteContext` — mirrors how `routes-turns.ts` opens its own store and how `src/config.js` helpers are called directly. `openTurnStore` is the per-`ctx.stateDir` connection helper already imported by `routes-turns.ts`.

- [ ] **Step 2: Barrel + dispatch registration**

In `extensions/dashboard-server/routes.ts`, add:
```ts
export { handleRagMetrics } from "./routes-rag-metrics.js";
```
In `extensions/dashboard-server/server.ts`, import `handleRagMetrics` and add near the other dispatch lines (after `handleRagSettings`, ~line 245):
```ts
		if (handleRagMetrics(req, res, ctx)) return;
```

- [ ] **Step 3: Write `routes-rag-metrics.test.ts`**

Handler-level test mirroring `routes-memory.test.ts`/`routes-servers.test.ts`: build a temp stateDir with a turns store that has a couple of telemetry rows (via `recordTurnWrite` from a `createTurnStore`), invoke `handleRagMetrics` with a stub `req`/`res`, and assert the JSON `totals`/`recent` shape. Keep it real (real sqlite), no mocks — per the no-mock-data rule.

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTurnStore } from "../../src/store/turns/index.js";
import { handleRagMetrics } from "./routes-rag-metrics.js";
// ...stub RouteContext as routes-memory.test.ts does, seeding the store...

test("GET /api/rag-metrics aggregates telemetry", () => {
	// seed store with one hyde_ran turn + one metrics turn
	// call handleRagMetrics(req,res,ctx)
	// assert totals.hydeRanTurns === 1, totals.telemetryTurns === 2
});
```

**Commit:** `H2.2 — GET /api/rag-metrics route + registration + tests` (run `npm run build && npm test`).

---

## Sprint H3 — Dashboard UI

Goal: surface HyDE + recall metrics across Turns / Metrics / Overview / Setup / Events tabs.

### Task H3.1: Client fetch wrapper

**Files:**
- Create: `extensions/dashboard-client/src/api/ragMetrics.ts`
- Modify: `extensions/dashboard-client/src/api/client.ts`

- [ ] **Step 1: Write `extensions/dashboard-client/src/api/ragMetrics.ts`**

```ts
/**
 * ragMetrics.ts — H3: typed client wrapper for GET /api/rag-metrics.
 */
import type { RagMetricsResponse } from "../../../dashboard-server/api-contracts/rag-metrics.js";
import { getJson } from "./client.js";

/** Fetch aggregated HyDE + recall metrics. Falls back to a null-safe default. */
export async function fetchRagMetrics(): Promise<RagMetricsResponse | null> {
	try {
		return await getJson<RagMetricsResponse>("/api/rag-metrics");
	} catch {
		return null; // non-fatal: dashboard grid degrades to empty
	}
}
```

- [ ] **Step 2: Register the endpoint in `client.ts`**

Add `/api/rag-metrics` to the `ENDPOINTS` registry (it is a `GET`), matching the surrounding entries.

**Commit:** `H3.1 — ragMetrics client wrapper`.

### Task H3.2: Components — HydeDetailPanel, RagDashboard, RagHealthCard

**Files:**
- Create: `extensions/dashboard-client/src/components/HydeDetailPanel.tsx`
- Create: `extensions/dashboard-client/src/components/RagDashboard.tsx`
- Create: `extensions/dashboard-client/src/components/RagHealthCard.tsx`

- [ ] **Step 1: Write `HydeDetailPanel.tsx`** (expandable detail for a single turn's HyDE row)

```tsx
/** HydeDetailPanel.tsx — H3: expandable HyDE detail for a turn row. */
import { useState } from "react";

export interface HydeDetailData {
	ran: boolean;
	reason: string;
	hypotheticalDoc: string;
	rawHitCount: number;
	hydeHitCount: number;
	fusedHitCount: number;
	lift: number;
	generationMs: number;
}

export function HydeDetailPanel({ data }: { data: HydeDetailData | null }) {
	const [open, setOpen] = useState(false);
	if (!data) {
		return <span className="text-muted-foreground">—</span>;
	}
	const badge = data.ran ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground";
	return (
		<div>
			<button
				onClick={() => setOpen((v) => !v)}
				className={`rounded px-2 py-0.5 text-xs font-medium ${badge}`}
			>
				{data.ran ? "HyDE" : data.reason}
			</button>
			{open && (
				<div className="mt-2 rounded border p-2 text-xs text-muted-foreground">
					<div className="mb-1 grid grid-cols-2 gap-1">
						<span>raw→fused: {data.rawHitCount}→{data.fusedHitCount}</span>
						<span>hyde hits: {data.hydeHitCount}</span>
						<span>lift: ×{data.lift.toFixed(2)}</span>
						<span>gen: {data.generationMs}ms</span>
					</div>
					{data.hypotheticalDoc && (
						<p className="italic">“{data.hypotheticalDoc.slice(0, 220)}”</p>
					)}
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Write `RagDashboard.tsx`** — the Metrics-tab section, 5 recharts sub-charts. Uses `react` + `recharts` (already a project dep). Default per the visual-design plan (this is a NEW component → wrap the whole section in `if (MEGACOMPACT_NEW_UI_DISABLED) return null;` flag guard).

```tsx
/** RagDashboard.tsx — H3: full RAG metrics section for the Metrics tab. */
import {
	Area, Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
	ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { RagMetricsResponse } from "../../../dashboard-server/api-contracts/rag-metrics.js";
import { fetchRagMetrics } from "../api/ragMetrics.js";
import { useEffect, useState } from "react";

export function RagDashboard() {
	const [data, setData] = useState<RagMetricsResponse | null>(null);
	useEffect(() => {
		let live = true;
		fetchRagMetrics().then((d) => { if (live) setData(d); });
		return () => { live = false; };
	}, []);
	if (!data) return null;

	const liftRows = data.recent.map((t, i) => ({
		name: `#${i + 1}`, lift: t.hydeLift, score: t.recallScore || 0,
	}));
	const flags = data.flags;
	return (
		<section className="space-y-3">
			<h3 className="text-sm font-semibold">RAG Quality · {flags.recallMetricsEnabled ? "on" : "off"}</h3>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Stat k="telemetry turns" v={String(data.totals.telemetryTurns)} />
				<Stat k="hyde ran" v={String(data.totals.hydeRanTurns)} />
				<Stat k="avg lift" v={`×${data.totals.avgLift.toFixed(2)}`} />
				<Stat k="pass rate" v={`${Math.round(data.totals.recentPassRate * 100)}%`} />
			</div>
			<Card title="HyDE Recall Lift (bar)">
				<ResponsiveContainer width="100%" height={120}>
					<BarChart data={liftRows}>
						<CartesianGrid strokeDasharray="3 3" />
						<XAxis dataKey="name" hide />
						<YAxis width={30} />
						<Tooltip />
						<Bar dataKey="lift" fill="#34d399" />
					</BarChart>
				</ResponsiveContainer>
			</Card>
			{/* CRAG quality line, flag dots, latency stacked bar, hit-rate area:
			    mirror the same ResponsiveContainer idioms with data.daily / flags. */}
		</section>
	);
}

/// Render helpers — keep under the 500-line cap with these small components.
function Stat({ k, v }: { k: string; v: string }) {
	return (
		<div className="rounded border p-2">
			<div className="text-xs text-muted-foreground">{k}</div>
			<div className="text-lg font-semibold">{v}</div>
		</div>
	);
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded border p-3">
			<div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
			{children}
		</div>
	);
}
```

> **Note:** The spec calls for 5 sub-charts (HyDE Recall Lift Bar, CRAG Quality Line, Per-Flag Status dots, Recall Latency StackedBar, Hit-Rate Area). Implement all five in this file, each a `Card` wrapping a `ResponsiveContainer` fed from `data.recent`/`data.daily`/`data.flags`. Keep the file ≤ 180 lines — if it grows past 200, split each chart into a sibling `RagDashboardChart.tsx`. Do not add charts beyond what `data` provides.

- [ ] **Step 3: Write `RagHealthCard.tsx`** (mini summary for Overview)

```tsx
/** RagHealthCard.tsx — H3: mini RAG health summary for the Overview card grid. */
import { useEffect, useState } from "react";
import { fetchRagMetrics } from "../api/ragMetrics.js";

export function RagHealthCard() {
	const [data, setData] = useState<{ passRate: number; lift: number; on: boolean } | null>(null);
	useEffect(() => {
		let live = true;
		fetchRagMetrics().then((d) => {
			if (!live || !d) return;
			setData({ passRate: d.totals.recentPassRate, lift: d.totals.avgLift, on: d.flags.recallMetricsEnabled });
		});
		return () => { live = false; };
	}, []);
	if (!data) return null;
	return (
		<div className="rounded border p-3">
			<div className="flex items-center justify-between">
				<span className="text-sm font-semibold">RAG Health</span>
				<span className={`h-2 w-2 rounded-full ${data.on ? "bg-emerald-400" : "bg-muted"}`} />
			</div>
			<div className="mt-2 text-xs text-muted-foreground">
				Crag pass {Math.round(data.passRate * 100)}% · avg HyDE lift ×{data.lift.toFixed(2)}
			</div>
		</div>
	);
}
```

**Commit:** `H3.2 — HyDE detail + RAG dashboard + health card components`.

### Task H3.3: Wire tabs

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/TurnsTab.tsx`
- Modify: `extensions/dashboard-client/src/tabs/MetricsTab.tsx`
- Modify: `extensions/dashboard-client/src/tabs/OverviewTab.tsx`
- Modify: `extensions/dashboard-client/src/tabs/SetupTab.tsx` (RagSettingsCard)
- Modify: `extensions/dashboard-client/src/tabs/EventsTab.tsx`

- [ ] **Step 1: TurnsTab — HyDE column + expandable detail**

Add a "HyDE" column to the turns table. For each turn, derive a `HydeDetailData` from the turn's telemetry fields (the turns API must now surface the 13 columns — extend the turns contract/read to include them). Render `<HydeDetailPanel data={...} />`; turns with `hyde_ran=0` and no metrics show "—".

- [ ] **Step 2: MetricsTab — render `<RagDashboard/>`** below the existing charts, gated by `MEGACOMPACT_NEW_UI_DISABLED`.

- [ ] **Step 3: OverviewTab — render `<RagHealthCard/>`** in the card grid, same flag gate.

- [ ] **Step 4: SetupTab/RagSettingsCard — HyDE status line** under the HyDE toggle: read `data.flags.hydeEnabled` from `fetchRagMetrics()` and show "HyDE: on (llm)" / "off (trigram)" / "off (disabled)".

- [ ] **Step 5: EventsTab — filter options** `hyde_executed` + `recall_metrics` added to the event-type filter list.

- [ ] **Step 6: Verify the dashboard build + smoke**

```bash
npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```
Expected output: dashboard bundle rebuilds clean; the tab smoke passes (Metrics/Overview/Setup/Turns/Events tabs render without runtime errors).

**Commit:** `H3.3 — wire HyDE/RAG visibility into 5 tabs` (then `npm run lint && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs`).

---

## Sprint H4 — Integration + QA

### Task H4.1: Full gate + manual verification

- [ ] **Step 1: Full gate**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```
Expected output: all green (1088+ tests pass, regression_check --all clean, guardrails-scan reports no new violations — especially PREVENT-PI-004: no network added in `src/`; the dashboard endpoint stays within the audited localhost server).

- [ ] **Step 2: Live dashboard check** (local-only)

Start the dashboard server and confirm `/api/rag-metrics` returns the expected JSON and that a recall pass emits `hyde_executed`/`recall_metrics` into `events.log`:
```bash
# with an HttpEmbedder configured (MEGACOMPACT_EMBEDDING_URL pointing at loopback Ollama)
curl -s localhost:9320/api/rag-metrics | head
# trigger a /mega-recall and then:
grep -c '"event":"hyde_executed"\|"event":"recall_metrics"' ~/.pi/mega-compact/events.log
```

- [ ] **Step 3: Flag-out regression check**

Run the gate once more with `MEGACOMPACT_RECALL_METRICS_DISABLED=true` and `MEGACOMPACT_HYDE_DISABLED=true` and confirm behavior is byte-identical to pre-sprint (no metrics, no SSE, dashboard sections hidden).

- [ ] **Step 4: Doc map registration**

Update `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` for all new files; mark this spec plan-done in `docs/superpowers/specs/2026-08-02-hyde-rag-visibility-design.md`.

**Commit:** `H4 — HyDE/RAG visibility integration + QA sign-off`.

---

## Verification Checklist (final)

- [ ] `npm run build` clean (src + extension + dashboard).
- [ ] `npm test` green (incl. `hydeTelemetry.test.js`, `mega-turn-store.test.ts`, `routes-rag-metrics.test.ts`).
- [ ] `npm run lint` + `python3 scripts/regression_check.py --all` + `node scripts/guardrails-scan.mjs` all green.
- [ ] `npm run build:dashboard` + `node scripts/dashboard-tab-smoke.mjs` pass.
- [ ] Flag-OFF (`RECALL_METRICS`/`HYDE` disabled) is byte-identical to pre-sprint.
- [ ] `SCHEMA_VERSION` is 3 (single bump shared with Spec 3).
- [ ] No `UPDATE` on `turns` — the 13 columns are written only in the `appendTurn` INSERT.
- [ ] `src/` contains no `runtime` import (pi-agnostic invariant preserved).
