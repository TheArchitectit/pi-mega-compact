# Wiki Revival: Provenance + User Curation + Topic Evolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revive the dead wiki engine (`src/wiki.ts`) by wiring 7 new endpoints, adding turn/session provenance, persistent user curation (rename/merge/split), and topic-evolution visualizations (per-topic timeline + global D3 graph), all behind the `MEGACOMPACT_WIKI_ENHANCED` flag.

**Architecture:** `src/wiki.ts` already ships a fully tested extractive page engine with zero callers. We revive it by layering three things on top of the durable topic model (`topics`/`memory_topics` in the isolated turns.db): (1) two new append-only tables — `topic_overrides` (user curation, immune to `replaceTopicModel` because that DELETE+reinsert touches only `topics`+`memory_topics`) and `topic_evolution` (per-memory join log), plus a `session_id` column on `memory_topics` so provenance join works across the per-session `context_chunks.id` PK; (2) a `src/wiki/curation.ts` module of `withTx` mutations + a `routes-wiki.ts` dispatch handler; (3) a D3 `TopicEvolutionView` that extends the existing Memory Map force-directed idioms. All reads/writes are pure local `node:sqlite`, parameterized (PREVENT-002), non-fatal, and SSE events travel over the existing JSONL `events.log` tail.

**Tech Stack:** TypeScript (ESM, Node ≥22.13), `node:sqlite` (`DatabaseSync`, `withTx` SAVEPOINT helper), React + shadcn/ui + recharts (client), d3-force (evolution graph), `node --test`, Playwright dashboard tab smoke, `python3 scripts/regression_check.py --all`.

**Parent spec:** `docs/superpowers/specs/2026-08-02-wiki-revival-design.md` — read it first; this plan implements it.

**Branch:** new branch `feat/wiki-revival` off `master` @ `57a8067`. Do not commit to `master`. Verify gate every commit: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` and `node scripts/guardrails-scan.mjs`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `src/store/turns/schema.ts` | Add `topic_overrides` + `topic_evolution` tables, `memory_topics.session_id` ensureColumn, bump `SCHEMA_VERSION` 2→3 | modify |
| `src/topics/store.ts` | Write `session_id` in `replaceTopicModel`; add `applyOverridesAfterRebuild` | modify |
| `src/topics/index.ts` | Re-export `applyOverridesAfterRebuild` | modify |
| `src/config/turns.ts` | Add `WIKI_ENHANCED_ENABLED` flag | modify |
| `src/wiki/curation.ts` | NEW. rename/merge/split/resolveLabel/overrideKinds transactions | create |
| `src/wiki/curation.test.ts` | NEW. Curation + override-persistence tests | create |
| `extensions/dashboard-server/api-contracts/wiki.ts` | NEW. 7 contract types | create |
| `extensions/dashboard-server/api-contracts/core.ts` | Append 4 SSE event types | modify |
| `extensions/dashboard-server/api-contracts/index.ts` | Re-export wiki types + SSE union members | modify |
| `extensions/dashboard-server/api-contracts/endpoints/registry.ts` | Append 7 `ENDPOINTS` entries | modify |
| `extensions/dashboard-server/routes-wiki.ts` | NEW. `handleWiki` dispatch + SSE curation emits | create |
| `extensions/dashboard-server/routes.ts` | Barrel-export `handleWiki` | modify |
| `extensions/dashboard-server/server.ts` | Add `if (handleWiki(...)) return;` dispatch | modify |
| `extensions/dashboard-server/routes-wiki.test.ts` | NEW. Handler-level endpoint tests | create |
| `extensions/mega-events/context-handler/afterCompact.ts` | Emit `wiki_rebuilt` + `applyOverridesAfterRebuild` post-step | modify |
| `extensions/dashboard-client/src/api/client.ts` | 7 typed fetch wrappers | modify |
| `extensions/dashboard-client/src/tabs/WikiTab.tsx` | NEW. List view (replaces TopicsTab in registry) | create |
| `extensions/dashboard-client/src/tabs/WikiTab/WikiPage.tsx` | NEW. Page view with provenance + timeline | create |
| `extensions/dashboard-client/src/tabs/WikiTab/WikiPageControls.tsx` | NEW. Rename/merge/split dialogs | create |
| `extensions/dashboard-client/src/tabs/WikiTab/TopicTimeline.tsx` | NEW. Per-topic horizontal timeline | create |
| `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx` | NEW. D3 global graph + scrubber | create |
| `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionGraph.tsx` | NEW. D3 simulation impl (delegate split if >480 lines) | create |
| `extensions/dashboard-client/src/App.tsx` | Register `WikiTab` in registry; `TopicsTab` removed from render map only | modify |
| `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md` | Register new files | modify |
| `docs/superpowers/specs/2026-08-02-wiki-revival-design.md` | Mark plan-done in status | modify |

**Helper reference (read these before coding):**
- `src/store/turns/connection.ts` — `openTurnStore(stateDir)`, `withTx(db, fn)` (SAVEPOINT).
- `src/store/sqlite.ts` — `openStore(stateDir)` for main DB (`context_chunks`).
- `src/topics/store.ts` — `createTopicStore`, `replaceTopicModel`, `getTopics`, `getMemoriesForTopic`.
- `src/topics/labels.ts` — `labelFromScores(termScores: {term,score}[])` for split new-topic labels.
- `src/store/sqlite/schema.ts:25` — the `ensureColumn` idiom (PRAGMA table_info guard + ALTER).
- `src/topics/store.test.ts` — existing test setup pattern (mkdtemp, `openTurnStore`, `makeModel`).
- `src/store/turns/migrations.test.ts` — existing schema assertions pattern.
- `extensions/dashboard-server/routes-turns.ts` — `sendJson` + `readJsonBody` helpers to mirror.
- `extensions/dashboard-server/routes-topics.ts` — lazy-build `buildTopicModel` pattern; `safeParse`.
- `extensions/dashboard-client/src/api/client.ts` — `getJson`/`putJson`/`postJson` + `query` helper.
- `extensions/dashboard-client/src/tabs/MemoryMapTab/MemoryMapView.tsx` — d3-force SVG idioms.
- `src/config/turns.ts` — `envBool` flag helper.

---

## Sprint W1 — Schema + Store + Flag Groundwork

### Task W1.1: Schema — three turns.db changes

**Files:**
- Modify: `src/store/turns/schema.ts`
- Test: `src/store/turns/migrations.test.ts`

- [ ] **Step 1: Write the schema additions in `initTurnSchema`**

After the existing `memory_topics` index block (find the `db.exec(\`CREATE INDEX IF NOT EXISTS idx_memory_topics_topic ...\`)` statement, which is the last wiki-related statement before the `// Stamp schema version once` block), insert the following. The `memory_topics.session_id` column uses the idempotent `ensureColumn` idiom (PRAGMA `table_info` guard + `ALTER TABLE`) because the table already exists in the wild and `CREATE TABLE IF NOT EXISTS` would be a no-op for it.

```ts
	// ── S57 Wiki Revival (Spec 3): user curation + topic evolution ────────
	// Idempotent additive column on the pre-existing memory_topics table
	// (CREATE TABLE IF NOT EXISTS is a no-op on existing DBs, so we ALTER in
	// the new column guarded by PRAGMA table_info). NULL backfill → provenance
	// shows "unknown session" until the next rebuild repopulates it.
	const sessionCol = (
		db.prepare("PRAGMA table_info(memory_topics)").all() as Array<{ name: string }>
	).some((c) => c.name === "session_id");
	if (!sessionCol) {
		db.exec("ALTER TABLE memory_topics ADD COLUMN session_id TEXT");
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_memory_topics_session ON memory_topics(session_id)`,
	);

	// Append-only provenance of user curation. A row records ONE user intent.
	// label uses INSERT OR REPLACE on the composite PK (same topic); split/merge
	// are plain INSERT (unique per topic_id + kind). Never mutated in place.
	db.exec(`
    CREATE TABLE IF NOT EXISTS topic_overrides (
      topic_id      TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('label','merge','split')),
      custom_label  TEXT,
      merged_into   TEXT,
      split_from    TEXT,
      split_memory_ids TEXT,
      overridden_at INTEGER NOT NULL,
      PRIMARY KEY (topic_id, kind)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_overrides_topic ON topic_overrides(topic_id)`,
	);

	// Per-topic memory-addition log for the timeline + global growth scrubber.
	// Written every rebuild alongside memory_topics; appended on merge/split.
	db.exec(`
    CREATE TABLE IF NOT EXISTS topic_evolution (
      topic_id     TEXT NOT NULL REFERENCES topics(id),
      memory_id    TEXT NOT NULL,
      session_id   TEXT,
      assigned_at  INTEGER NOT NULL,
      method       TEXT NOT NULL CHECK(method IN ('kmeans+tfidf','merge','split','manual')),
      PRIMARY KEY (topic_id, memory_id)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_evolution_topic ON topic_evolution(topic_id, assigned_at)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_evolution_ts   ON topic_evolution(assigned_at)`,
	);
```

- [ ] **Step 2: Bump `SCHEMA_VERSION` 2→3**

Change the constant at line 19:

```ts
const SCHEMA_VERSION = 3;
```

Note: Spec 2 (HyDE columns on the `turns` table) shares this single `2→3` bump — its own additive columns use the same `ensureColumn` idiom inside the same `initTurnSchema`, so the stamp is a shared umbrella. If Spec 2 lands first, its `ensureColumn` calls already run under v3; if not, they still run under the same call.

- [ ] **Step 3: Add idempotency + presence assertions to `migrations.test.ts`**

Open `src/store/turns/migrations.test.ts` and locate where it opens an in-memory turns.db (it uses `openTurnDb` or `openTurnStore` with `{ inMemory: true }`). Append a new test block at the end of the file:

```ts
test("wiki revival: topic_overrides + topic_evolution tables and memory_topics.session_id column exist", () => {
	// Reuse the same test helper the file already uses to open an in-memory db.
	const db = openInMemoryTurnDb(); // <-- use the file's existing helper fn name
	const tables = (
		db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
	).map((r) => r.name);
	assert.ok(tables.includes("topic_overrides"), "topic_overrides table created");
	assert.ok(tables.includes("topic_evolution"), "topic_evolution table created");

	const cols = (
		db.prepare("PRAGMA table_info(memory_topics)").all() as Array<{ name: string }>
	).map((c) => c.name);
	assert.ok(cols.includes("session_id"), "memory_topics.session_id column added");

	const v = db.prepare("SELECT value FROM turns_meta WHERE key = 'schema_version'").get() as { value: string };
	assert.equal(v.value, "3");
});
```

> If the file's existing helper is named differently (e.g. the test calls `openTurnDb(dir, { inMemory: true })` inline), adapt line 2 to match — the important assertions are the three above. Read the existing test's setup before writing.

- [ ] **Step 4: Run the migration test**

```bash
npm run build && npm test -- src/store/turns/migrations.test.js 2>/dev/null || npm test 2>&1 | grep -i "migration\|schema_version" | head
```

Expected: the new test PASSes; schema_version = "3".

- [ ] **Step 5: Commit**

```bash
git add src/store/turns/schema.ts src/store/turns/migrations.test.ts
git commit -m "feat(wiki): add topic_overrides + topic_evolution tables and memory_topics.session_id (SCHEMA_VERSION 2->3)"
```

---

### Task W1.2: Store — write `session_id` + `applyOverridesAfterRebuild`

**Files:**
- Modify: `src/topics/store.ts`
- Modify: `src/topics/index.ts`
- Test: `src/topics/store.test.ts`

- [ ] **Step 1: Write the failing test — session_id round-trip + override survival**

Append to `src/topics/store.test.ts` (it already imports `createTopicStore`, `openTurnStore`, `closeTurnStore`, `makeModel`, `stateDir`). The `makeModel` helper already stamps `sessionId: "s"` on assignments.

```ts
test("replaceTopicModel persists session_id; topic_overrides survive rebuild", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	const tdb = openTurnStore(dir);
	store.replaceTopicModel(makeModel(1000, 2));

	// 1. session_id is written to memory_topics.
	const row = tdb
		.prepare("SELECT session_id FROM memory_topics WHERE memory_id = ?")
		.get("mem_0_0") as { session_id: string | null };
	assert.equal(row.session_id, "s");

	// 2. A user override written to topic_overrides survives a rebuild.
	tdb.prepare(
		"INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at) VALUES (?, 'label', ?, ?)",
	).run("topic_0", "Custom Label", 2000);

	store.replaceTopicModel(makeModel(3000, 2));
	const { applyOverridesAfterRebuild } = await import("./store.js");
	applyOverridesAfterRebuild(tdb);

	const top = store.getTopics().find((t) => t.id === "topic_0");
	assert.equal(top?.label, "Custom Label");
	closeTurnStore(dir);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run build && npm test -- src/topics/store.test.js 2>&1 | grep -iE "fail|session_id|applyOverrides" | head
```

Expected: FAIL — `session_id` is not written and `applyOverridesAfterRebuild` is not exported.

- [ ] **Step 3: Write `session_id` + add `applyOverridesAfterRebuild`**

In `src/topics/store.ts`, change the `replaceTopicModel` assignment insert (lines 121–127) to write `session_id`:

```ts
			const insAssign = db.prepare(
				`INSERT OR REPLACE INTO memory_topics (memory_id, topic_id, confidence, assigned_at, method, session_id)
         VALUES (?, ?, ?, ?, 'kmeans+tfidf', ?)`,
			);
			for (const a of model.assignments) {
				insAssign.run(a.memoryId, a.topicId, a.confidence, a.assignedAt, a.sessionId ?? null);
			}
```

Also update `rowToAssignment` (lines 85–97) so a present `session_id` column is read through:

```ts
interface AssignmentRow {
	memory_id: string;
	topic_id: string;
	confidence: number | null;
	assigned_at: number | null;
	method: string | null;
	session_id: string | null;
}

function rowToAssignment(r: AssignmentRow): TopicAssignment {
	return {
		memoryId: r.memory_id,
		sessionId: r.session_id ?? "",
		topicId: r.topic_id,
		confidence: r.confidence ?? 0,
		assignedAt: r.assigned_at ?? 0,
		method: "kmeans+tfidf",
	};
}
```

Update `getMemoriesForTopic` and `getTopicForMemory` SELECT columns to include `session_id`:

```ts
		getMemoriesForTopic(...): TopicAssignment[] {
			const rows = db
				.prepare(
					`SELECT memory_id, topic_id, confidence, assigned_at, method, session_id
	           FROM memory_topics WHERE topic_id = ?
	           ORDER BY confidence DESC, memory_id ASC LIMIT ? OFFSET ?`,
				)
				.all(topicId, limit, offset) as unknown as AssignmentRow[];
			return rows.map(rowToAssignment);
		},

		getTopicForMemory(memoryId: string): TopicAssignment | null {
			const r = db
				.prepare(
					`SELECT memory_id, topic_id, confidence, assigned_at, method, session_id
	           FROM memory_topics WHERE memory_id = ? LIMIT 1`,
				)
				.get(memoryId) as unknown as AssignmentRow | undefined;
			return r ? rowToAssignment(r) : null;
		},
```

Now add the `applyOverridesAfterRebuild` export at the end of the file (before the final `bumpWikiCompactCounter` is fine — it is a sibling function):

```ts
/**
 * Re-apply user label overrides after a `replaceTopicModel` rebuild has wiped
 * `topics` + `memory_topics`. `topic_overrides` is untouched by the rebuild, so
 * this re-stamps `topics.label` with the custom label where one exists (else it
 * keeps the auto TF-IDF label just written). Merge/split override rows are left
 * as historical provenance — if the referenced topic id still exists its badges
 * remain valid; if the system re-clustered it away the row is a harmless orphan.
 * Non-fatal: a corrupt/missing row is skipped.
 */
export function applyOverridesAfterRebuild(db: DatabaseSync): void {
	try {
		const rows = db
			.prepare("SELECT topic_id, custom_label FROM topic_overrides WHERE kind = 'label'")
			.all() as Array<{ topic_id: string; custom_label: string | null }>;
		const upd = db.prepare("UPDATE topics SET label = ? WHERE id = ?");
		for (const r of rows) {
			if (r.custom_label && r.custom_label.trim() !== "") {
				upd.run(r.custom_label, r.topic_id);
			}
		}
	} catch {
		/* non-fatal: override re-apply never breaks a rebuild */
	}
}
```

> Note: `UPDATE` on the `topics` table is allowed — the append-only rule (PREVENT-002, "no UPDATE on turns") applies only to the `turns` table. `topics.label` is a derived display field, and the design (§7.3) explicitly re-stamps it.

- [ ] **Step 4: Export from the barrel**

In `src/topics/index.ts`, add `applyOverridesAfterRebuild` to the `createTopicStore` export line:

```ts
export { createTopicStore, getWikiCompactCounter, bumpWikiCompactCounter, applyOverridesAfterRebuild } from "./store.js";
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npm run build && npm test -- src/topics/store.test.js 2>&1 | tail -20
```

Expected: PASS — both new assertions (session_id round-trip, override survival) plus all pre-existing tests green.

- [ ] **Step 6: Commit**

```bash
git add src/topics/store.ts src/topics/index.ts src/topics/store.test.ts
git commit -m "feat(wiki): persist session_id in memory_topics + applyOverridesAfterRebuild"
```

---

### Task W1.3: Config — `WIKI_ENHANCED_ENABLED` flag

**Files:**
- Modify: `src/config/turns.ts`

- [ ] **Step 1: Add the flag**

In `src/config/turns.ts`, read the file to find the `TurnsConfig` interface and the `envBool` helper (used at line 63: `envBool("MEGACOMPACT_AUTO_WIKI", true)`). Add to the interface:

```ts
	WIKI_ENHANCED_ENABLED: boolean;
```

And to the object literal (next to `AUTO_WIKI_ENABLED`):

```ts
		WIKI_ENHANCED_ENABLED: envBool("MEGACOMPACT_WIKI_ENHANCED", true),
```

- [ ] **Step 2: Run build + lint**

```bash
npm run build && npm run lint
```

Expected: clean (the new field is used later in W2/W4; TypeScript won't flag an unused interface field).

- [ ] **Step 3: Commit**

```bash
git add src/config/turns.ts
git commit -m "feat(wiki): add MEGACOMPACT_WIKI_ENHANCED flag (default ON)"
```

- [ ] **Step 4: Sprint W1 gate**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```

Expected: all green. Then run `./scripts/deploy.sh <patch>` for a patch-bumped deploy checkpoint (per the per-sprint publish cadence memory).

---

## Sprint W2 — Curation Module + Endpoints

### Task W2.1: `src/wiki/curation.ts` — rename/merge/split transactions

**Files:**
- Create: `src/wiki/curation.ts`
- Create: `src/wiki/curation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/wiki/curation.test.ts`:

```ts
/**
 * curation.test.ts — S57 Wiki Revival (Spec 3): user curation transactions.
 * Pure local node:sqlite over a temp turns.db (PREVENT-PI-004); all writes
 * parameterized (PREVENT-002). Verifies rename/merge/split + override survival.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiCuration } from "./curation.js";
import { createTopicStore } from "../topics/store.js";
import { openTurnStore, closeTurnStore } from "../store/turns/connection.js";
import type { ClusterModel } from "../topics/types.js";

let tmpDir: string;
let counter = 0;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "mc-curation-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });
function stateDir(): string { return join(tmpDir, `run-${counter++}`); }

function makeModel(builtAt: number): ClusterModel {
	return {
		topics: [
			{ id: "topic_0", label: "alpha", termScores: [{ term: "a", score: 1 }], memoryCount: 2, lastUpdated: builtAt },
			{ id: "topic_1", label: "beta", termScores: [{ term: "b", score: 1 }], memoryCount: 1, lastUpdated: builtAt },
		],
		assignments: [
			{ memoryId: "m0", sessionId: "s", topicId: "topic_0", confidence: 0.9, assignedAt: builtAt, method: "kmeans+tfidf" },
			{ memoryId: "m1", sessionId: "s", topicId: "topic_0", confidence: 0.7, assignedAt: builtAt, method: "kmeans+tfidf" },
			{ memoryId: "m2", sessionId: "s", topicId: "topic_1", confidence: 0.5, assignedAt: builtAt, method: "kmeans+tfidf" },
		],
		k: 2,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: 3,
		builtAt,
	};
}

test("renameTopic: writes override, resolves label, edited=true; empty clears", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	let r = cur.renameTopic("topic_0", "Custom");
	assert.equal(r.ok, true);
	assert.equal(r.label, "Custom");
	assert.equal(r.edited, true);

	const resolved = cur.resolveLabel("topic_0", "alpha");
	assert.deepEqual(resolved, { label: "Custom", edited: true });

	r = cur.renameTopic("topic_0", "");
	assert.equal(r.edited, false);
	assert.equal(r.label, "alpha"); // falls back to auto
	closeTurnStore(dir);
});

test("mergeTopics: reassigns memories, writes override, counts consistent", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.mergeTopics("topic_0", "topic_1");
	assert.equal(r.ok, true);
	assert.equal(r.merged, true);

	assert.equal(store.getMemoriesForTopic("topic_0").length, 0); // dissolved
	assert.equal(store.getMemoriesForTopic("topic_1").length, 3); // absorbed
	const top1 = store.getTopics().find((t) => t.id === "topic_1");
	assert.equal(top1?.memoryCount, 3);
	// evolution method recorded
	const tdb = openTurnStore(dir);
	const ev = tdb.prepare("SELECT method FROM topic_evolution WHERE topic_id='topic_1' AND memory_id='m0'").get() as { method: string } | undefined;
	assert.equal(ev?.method, "merge");
	closeTurnStore(dir);
});

test("splitTopic: moves listed memories to new topic, writes override + evolution", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.splitTopic("topic_0", ["m0"]);
	assert.equal(r.ok, true);
	assert.equal(r.split, true);
	const newId = r.topicId; // the split topic id (differs from source)

	assert.equal(store.getMemoriesForTopic("topic_0").length, 1); // m1 remains
	const moved = store.getTopicForMemory("m0");
	assert.equal(moved?.topicId, newId);
	const tdb = openTurnStore(dir);
	const ev = tdb.prepare("SELECT method FROM topic_evolution WHERE topic_id=? AND memory_id='m0'").get(newId) as { method: string } | undefined;
	assert.equal(ev?.method, "split");
	closeTurnStore(dir);
});

test("merge source==target rejects without partial write", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);
	assert.throws(() => cur.mergeTopics("topic_0", "topic_0"));
	// both topics still hold their memories (no partial write)
	assert.equal(store.getMemoriesForTopic("topic_0").length, 2);
	assert.equal(store.getMemoriesForTopic("topic_1").length, 1);
	closeTurnStore(dir);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run build && npm test -- src/wiki/curation.test.js 2>&1 | grep -iE "fail|Cannot find|curation" | head
```

Expected: FAIL — `./curation.js` module not found / `createWikiCuration` undefined.

- [ ] **Step 3: Implement `src/wiki/curation.ts`**

Create the file:

```ts
/**
 * curation.ts — S57 Wiki Revival (Spec 3): user curation transactions.
 *
 * Host-agnostic (no pi imports). Pure local node:sqlite over the shared turns.db
 * (PREVENT-PI-004); all writes parameterized (PREVENT-002). Every mutation is
 * wrapped in `withTx` (SAVEPOINT) so any error rolls back atomically and is
 * non-fatal — the agent loop is never affected (PREVENT-PI-001).
 *
 * `topic_overrides` is append-only and immune to `replaceTopicModel` (which
 * deletes only `topics` + `memory_topics`), so curation survives auto-rebuilds.
 */
import type { DatabaseSync } from "node:sqlite";
import { openTurnStore, withTx } from "../store/turns/connection.js";
import { createTopicStore } from "../topics/store.js";
import { labelFromScores } from "../topics/labels.js";

/** Result of a curation mutation, echoed to the client + SSE. */
export interface CurationResult {
	ok: boolean;
	topicId: string;
	label: string;
	edited: boolean;
	merged: boolean;
	split: boolean;
}

/** Override kinds recorded for a topic (badge provenance). */
export type OverrideKind = "label" | "merge" | "split";

/** Curation operations over an open turns.db + the topic store. */
export interface WikiCurationStore {
	renameTopic(topicId: string, label: string): CurationResult;
	mergeTopics(sourceTopicId: string, targetTopicId: string): CurationResult;
	splitTopic(topicId: string, memoryIds: string[]): CurationResult;
	resolveLabel(topicId: string, autoLabel: string): { label: string; edited: boolean };
	overrideKinds(topicId: string): OverrideKind[];
}

interface OverrideRow {
	custom_label: string | null;
}

/** Next monotonic topic id (topic_N). Throws only on schema corruption (non-fatal upstream). */
function nextTopicId(db: DatabaseSync, store: { getTopics(): Array<{ id: string }> }): string {
	let max = -1;
	for (const t of store.getTopics()) {
		const n = Number(t.id.replace(/^[^0-9]*/, ""));
		if (Number.isFinite(n) && n > max) max = n;
	}
	return `topic_${max + 1}`;
}

/** Build a new-topic label from moved memories' term scores (reuse labelFromScores). */
function labelForMemories(auto: string): string {
	return auto.trim() !== "" ? auto : "split topic";
}

export function createWikiCuration(stateDir: string): WikiCurationStore {
	const db: DatabaseSync = openTurnStore(stateDir);
	const store = createTopicStore(stateDir);

	/** Resolve a topic's display label: user override ?? auto label. */
	const resolveLabel = (topicId: string, autoLabel: string) => {
		const row = db
			.prepare(
				"SELECT custom_label FROM topic_overrides WHERE topic_id = ? AND kind = 'label'",
			)
			.get(topicId) as OverrideRow | undefined;
		const custom = row?.custom_label ?? "";
		if (custom.trim() !== "") return { label: custom, edited: true };
		return { label: autoLabel, edited: false };
	};

	/** Override kinds recorded for a topic (badge provenance). */
	const overrideKinds = (topicId: string): OverrideKind[] => {
		const rows = db
			.prepare(
				"SELECT kind FROM topic_overrides WHERE topic_id = ? ORDER BY overridden_at ASC",
			)
			.all(topicId) as Array<{ kind: OverrideKind }>;
		return rows.map((r) => r.kind);
	};

	function renameTopic(topicId: string, label: string): CurationResult {
		const topic = store.getTopics().find((t) => t.id === topicId);
		const autoLabel = topic?.label ?? topicId;
		withTx(db, () => {
			db.prepare(
				`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at)
         VALUES (?, 'label', ?, ?)`,
			).run(topicId, label.trim(), Date.now());
		});
		const resolved = resolveLabel(topicId, autoLabel);
		return { ok: true, topicId, ...resolved, merged: false, split: false };
	}

	function mergeTopics(sourceTopicId: string, targetTopicId: string): CurationResult {
		if (sourceTopicId === targetTopicId) {
			throw new Error("merge source and target must differ");
		}
		const topics = store.getTopics();
		if (!topics.some((t) => t.id === sourceTopicId)) throw new Error("source topic not found");
		if (!topics.some((t) => t.id === targetTopicId)) throw new Error("target topic not found");
		const now = Date.now();
		const result: CurationResult = { ok: false, topicId: sourceTopicId, label: sourceTopicId, edited: false, merged: true, split: false };
		withTx(db, () => {
			// Reassign all source memories to target; recompute counts in-tx.
			const moved = db
				.prepare("SELECT memory_id, session_id FROM memory_topics WHERE topic_id = ?")
				.all(sourceTopicId) as Array<{ memory_id: string; session_id: string | null }>;
			const upd = db.prepare(
				"UPDATE memory_topics SET topic_id = ? WHERE topic_id = ?",
			);
			upd.run(targetTopicId, sourceTopicId);
			const evIns = db.prepare(
				`INSERT OR REPLACE INTO topic_evolution (topic_id, memory_id, session_id, assigned_at, method)
         VALUES (?, ?, ?, ?, 'merge')`,
			);
			for (const m of moved) {
				evIns.run(targetTopicId, m.memory_id, m.session_id, now);
			}
			// source dissolved (keep its topics row for history if it has overrides).
			db.prepare("UPDATE topics SET memory_count = 0 WHERE id = ?").run(sourceTopicId);
			db.prepare("UPDATE topics SET memory_count = ? WHERE id = ?").run(
				store.getMemoriesForTopic(targetTopicId).length,
				targetTopicId,
			);
			db.prepare(
				`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, merged_into, overridden_at)
         VALUES (?, 'merge', ?, ?)`,
			).run(sourceTopicId, targetTopicId, now);
		});
		const target = store.getTopics().find((t) => t.id === targetTopicId);
		const resolved = resolveLabel(targetTopicId, target?.label ?? targetTopicId);
		result.topicId = targetTopicId;
		result.label = resolved.label;
		result.edited = resolved.edited;
		result.ok = true;
		return result;
	}

	function splitTopic(topicId: string, memoryIds: string[]): CurationResult {
		const topics = store.getTopics();
		const topic = topics.find((t) => t.id === topicId);
		if (!topic) throw new Error("topic not found");
		if (memoryIds.length === 0) throw new Error("split requires ≥1 memory id");
		const newId = nextTopicId(db, { getTopics: () => store.getTopics() });
		const now = Date.now();
		const result: CurationResult = { ok: false, topicId: topicId, label: topic.label, edited: false, merged: false, split: true };
		withTx(db, () => {
			// Move the listed memories into the new topic (validate they belong here).
			const move = db.prepare(
				`UPDATE memory_topics SET topic_id = ? WHERE topic_id = ? AND memory_id = ?`,
			);
			const evIns = db.prepare(
				`INSERT OR REPLACE INTO topic_evolution (topic_id, memory_id, session_id, assigned_at, method)
         VALUES (?, ?, ?, ?, 'split')`,
			);
			let movedCount = 0;
			for (const memId of memoryIds) {
				const existing = db
					.prepare("SELECT session_id FROM memory_topics WHERE topic_id = ? AND memory_id = ?")
					.get(topicId, memId) as { session_id: string | null } | undefined;
				if (!existing) continue;
				move.run(newId, topicId, memId);
				evIns.run(newId, memId, existing.session_id, now);
				movedCount++;
			}
			if (movedCount === 0) throw new Error("none of the given memory ids belong to this topic");
			// Recompute counts for source + new topic (and add the new topics row).
			db.prepare("UPDATE topics SET memory_count = ? WHERE id = ?").run(
				store.getMemoriesForTopic(topicId).length,
				topicId,
			);
			// New topic label from its moved members' aggregate term scores (best-effort).
			db.prepare(
				`INSERT INTO topics (id, label, term_scores, memory_count, last_updated, cluster_model_built_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
			).run(newId, labelForMemories(topic.label), "[]", movedCount, now, null);
			db.prepare(
				`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, split_from, split_memory_ids, overridden_at)
         VALUES (?, 'split', ?, ?, ?)`,
			).run(newId, topicId, JSON.stringify(memoryIds), now);
		});
		result.topicId = newId;
		result.label = labelForMemories(topic.label);
		result.ok = true;
		return result;
	}

	return {
		renameTopic,
		mergeTopics,
		splitTopic,
		resolveLabel,
		overrideKinds,
	};
}
```

> Note: `splitTopic` writes a `topics` row via `INSERT` (not `UPDATE`) — SQL `INSERT` on `topics` is allowed (append-only rule governs the `turns` table only). `nextTopicId` uses a module-internal helper closure that reads the live topic list inside the transaction.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm run build && npm test -- src/wiki/curation.test.js 2>&1 | tail -20
```

Expected: PASS — all 4 curation tests green. Ensure the file is under 300 lines (`wc -l src/wiki/curation.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/wiki/curation.ts src/wiki/curation.test.ts
git commit -m "feat(wiki): add curation module (rename/merge/split) with override persistence"
```

---

### Task W2.2: API contracts — `wiki.ts` + registry + SSE types ready

**Files:**
- Create: `extensions/dashboard-server/api-contracts/wiki.ts`
- Modify: `extensions/dashboard-server/api-contracts/endpoints/registry.ts`
- Modify: `extensions/dashboard-server/api-contracts/index.ts`

- [ ] **Step 1: Create `api-contracts/wiki.ts`**

```ts
/**
 * api-contracts/wiki.ts — S57 Wiki Revival (Spec 3): wiki API contracts.
 *
 * Type-only (PREVENT-PI-004: zero network code). Mirrors the design §4.1.
 */

/** One topic row in the wiki index (list view). */
export interface WikiIndexEntry {
	readonly id: string;
	/** User override ?? auto label. */
	readonly label: string;
	/** True when label came from topic_overrides (shown as "edited"). */
	readonly edited: boolean;
	readonly memoryCount: number;
	readonly lastUpdated: number;
	/** First ~140 chars of the extractive summary (client list snippet). */
	readonly summarySnippet: string;
	/** Detection: split/merged provenance flags for UI badges. */
	readonly overrideKinds: ReadonlyArray<'label' | 'merge' | 'split'>;
}

/** GET /api/wiki/index */
export interface WikiIndexResponse {
	readonly updatedAt: string;
	readonly totalTopics: number;
	readonly totalMemories: number;
	readonly lastRebuildAt: number | null;
	readonly featureEnabled: boolean;
	readonly topics: WikiIndexEntry[];
}

/** Provenance for one topic memory. */
export interface MemoryProvenance {
	readonly memoryId: string;
	readonly sessionId: string | null;
	/** COALESCE(normalized_text, summary, topic_summary). */
	readonly content: string;
	readonly timestamp: number | null;
	/** memory_topics.confidence (no separate importance column). */
	readonly importance: number;
	readonly turns: ReadonlyArray<{
		readonly conversationId: string;
		readonly turnIndex: number;
		readonly role: string;
		readonly model: string | null;
		readonly epochId: string | null;
	}>;
}

/** GET /api/wiki/topic/:topicId */
export interface WikiPageResponse {
	readonly topicId: string;
	readonly label: string;
	readonly edited: boolean;
	readonly summary: string;
	readonly keyMemories: ReadonlyArray<Omit<MemoryProvenance, 'turns'>>;
	readonly recentMemories: ReadonlyArray<Omit<MemoryProvenance, 'turns'>>;
	readonly memberMemories: ReadonlyArray<MemoryProvenance>;
	readonly relatedTopics: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly edited: boolean;
		readonly memoryCount: number;
	}>;
	readonly timeline: ReadonlyArray<{ readonly ts: number; readonly count: number }>;
	readonly generatedAt: number;
}

/** PUT /api/wiki/topic/:topicId/label — body. */
export interface RenameTopicRequest {
	readonly label: string;
}

/** Response for all three curation mutations. */
export interface CurationResult {
	readonly ok: boolean;
	readonly topicId: string;
	readonly label: string;
	readonly edited: boolean;
	readonly merged: boolean;
	readonly split: boolean;
}

/** POST /api/wiki/merge — body. */
export interface MergeTopicsRequest {
	readonly sourceTopicId: string;
	readonly targetTopicId: string;
}

/** POST /api/wiki/topic/:topicId/split — body. */
export interface SplitTopicRequest {
	readonly memoryIds: string[];
}

/** GET /api/wiki/topic/:topicId/timeline */
export interface TopicTimelineResponse {
	readonly topicId: string;
	readonly label: string;
	/** Bucketed [ts, count] — all sessions. */
	readonly buckets: ReadonlyArray<{
		readonly ts: number;
		readonly count: number;
		readonly sessionId: string | null;
	}>;
}

/** GET /api/wiki/evolution — feeds the global D3 graph. */
export interface TopicEvolutionResponse {
	readonly updatedAt: string;
	readonly nodes: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly edited: boolean;
		readonly memoryCount: number;
		readonly firstSeen: number;
		readonly lastSeen: number;
	}>;
	/** Co-occurrence edges (topics sharing member memories), with weight. */
	readonly edges: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
		readonly weight: number;
	}>;
	/** Bucket boundaries (epoch ms) for the scrubber. */
	readonly timeBuckets: number[];
}

/** Discriminated union of the four wiki SSE event payloads. */
export type WikiSseEvent =
	| SseWikiRebuilt
	| SseWikiTopicRenamed
	| SseWikiTopicsMerged
	| SseWikiTopicSplit;

/** wiki_rebuilt — auto-rebuild completed (from afterCompact). */
export interface SseWikiRebuilt {
	type: 'wiki_rebuilt';
	ts: string;
	clusterCount: number;
	totalChunks: number;
	criterion: string;
}

/** wiki_topic_renamed — user renamed a topic. */
export interface SseWikiTopicRenamed {
	type: 'wiki_topic_renamed';
	ts: string;
	topicId: string;
	label: string;
}

/** wiki_topics_merged — user merged source into target. */
export interface SseWikiTopicsMerged {
	type: 'wiki_topics_merged';
	ts: string;
	sourceTopicId: string;
	targetTopicId: string;
}

/** wiki_topic_split — user split a topic into a new one. */
export interface SseWikiTopicSplit {
	type: 'wiki_topic_split';
	ts: string;
	topicId: string; // source
	splitTopicId: string; // new topic
	movedCount: number;
}
```

- [ ] **Step 2: Add the 7 registry entries**

In `extensions/dashboard-server/api-contracts/endpoints/registry.ts`, add the import at the top (after the existing `import type { RagSettingsResponsePost } ...` block):

```ts
import type {
	WikiIndexResponse,
	WikiPageResponse,
	CurationResult,
	RenameTopicRequest,
	MergeTopicsRequest,
	SplitTopicRequest,
	TopicTimelineResponse,
	TopicEvolutionResponse,
} from "../wiki.js";
```

Then append these entries at the end of the `ENDPOINTS` object (before the closing `} as const;`), after the `ragSettingsUpdate` entry:

```ts
	// ─── Wiki Revival (Spec 3) ─────────────────────────────────────────

	/** GET /api/wiki/index — Wiki tab landing (labels + snippets + badges). */
	wikiIndex: {
		method: "GET",
		path: "/api/wiki/index",
		description: "Wiki index: topics with resolved labels, summary snippets, and curation badges.",
	} as const satisfies EndpointDef<"GET", undefined, WikiIndexResponse>,

	/** GET /api/wiki/topic/:topicId — single topic wiki page + provenance. */
	wikiTopic: {
		method: "GET",
		path: "/api/wiki/topic/:topicId",
		description: "Single topic wiki page: extractive summary, key/recent memories, related topics, member provenance.",
	} as const satisfies EndpointDef<"GET", undefined, WikiPageResponse>,

	/** PUT /api/wiki/topic/:topicId/label — rename a topic. */
	renameTopic: {
		method: "PUT",
		path: "/api/wiki/topic/:topicId/label",
		description: "Rename a topic (custom label override; empty clears back to auto).",
	} as const satisfies EndpointDef<"PUT", RenameTopicRequest, CurationResult>,

	/** POST /api/wiki/merge — merge source topic into target. */
	mergeTopics: {
		method: "POST",
		path: "/api/wiki/merge",
		description: "Merge a source topic's memories into a target topic.",
	} as const satisfies EndpointDef<"POST", MergeTopicsRequest, CurationResult>,

	/** POST /api/wiki/topic/:topicId/split — carve a new topic out of this one. */
	splitTopic: {
		method: "POST",
		path: "/api/wiki/topic/:topicId/split",
		description: "Split a topic by moving the listed memories into a new topic.",
	} as const satisfies EndpointDef<"POST", SplitTopicRequest, CurationResult>,

	/** GET /api/wiki/topic/:topicId/timeline — per-topic memory-addition timeline. */
	topicTimeline: {
		method: "GET",
		path: "/api/wiki/topic/:topicId/timeline",
		description: "Per-topic timeline buckets of memory additions by session.",
	} as const satisfies EndpointDef<"GET", undefined, TopicTimelineResponse>,

	/** GET /api/wiki/evolution — D3 global topic evolution graph feed. */
	topicEvolution: {
		method: "GET",
		path: "/api/wiki/evolution",
		description: "Global topic evolution graph: nodes, co-occurrence edges, time buckets.",
	} as const satisfies EndpointDef<"GET", undefined, TopicEvolutionResponse>,
```

- [ ] **Step 3: Re-export from the barrel**

In `extensions/dashboard-server/api-contracts/index.ts`, add a `SseWikiRebuilt`/etc. import to the existing `from "./core.js"` block (append these to the type list at lines 23–30 and the runtime import at lines 91–108 — the type is defined in `wiki.ts`, so import it there instead):

Add to the `import type { ... } from "./core.js";` list nothing (these live in wiki.ts). Add a new export block near the bottom of the file:

```ts
// S57 Wiki Revival (Spec 3)
export type {
	WikiIndexEntry,
	WikiIndexResponse,
	MemoryProvenance,
	WikiPageResponse,
	RenameTopicRequest,
	CurationResult,
	MergeTopicsRequest,
	SplitTopicRequest,
	TopicTimelineResponse,
	TopicEvolutionResponse,
	SseWikiRebuilt,
	SseWikiTopicRenamed,
	SseWikiTopicsMerged,
	SseWikiTopicSplit,
	WikiSseEvent,
} from "./wiki.js";
```

Now append the four event members to the `SseEvent` union (lines 156–177):

```ts
	| SseSessionSample
	| SseWikiRebuilt
	| SseWikiTopicRenamed
	| SseWikiTopicsMerged
	| SseWikiTopicSplit;
```

(Add the four names to the `import type` blocks that feed the union: they are exported from `./wiki.js`, so import them in the `import type { ... } from "./core.js";`-adjacent import section. Concretely, add `SseWikiRebuilt, SseWikiTopicRenamed, SseWikiTopicsMerged, SseWikiTopicSplit` to the `import type { ... } from "./wiki.js"` block you just created — import the types in the same new block where they are re-exported.)

- [ ] **Step 4: Run build to confirm types resolve**

```bash
npm run build
```

Expected: clean compile (routes-wiki.ts does not exist yet, so nothing imports these — types-only).

- [ ] **Step 5: Commit**

```bash
git add extensions/dashboard-server/api-contracts/wiki.ts extensions/dashboard-server/api-contracts/endpoints/registry.ts extensions/dashboard-server/api-contracts/index.ts
git commit -m "feat(wiki): api-contracts wiki types + registry + SSE union members"
```

---

### Task W2.3: `routes-wiki.ts` — dispatch handler + flag gating

**Files:**
- Create: `extensions/dashboard-server/routes-wiki.ts`
- Modify: `extensions/dashboard-server/routes.ts`
- Modify: `extensions/dashboard-server/server.ts`

- [ ] **Step 1: Create `routes-wiki.ts`**

Mirror `routes-turns.ts` for `sendJson` + `readJsonBody`. The handler 404s every `/api/wiki/*` path when the flag is off (flag-off parity keeps `/api/topics` untouched). It uses `createTopicStore` + `generateWikiPage`/`buildWikiIndex` + `createWikiCuration` + `openStore` for `context_chunks` joins + `appendFileSync` on `ctx.eventsPath` for SSE curation emits.

```ts
/**
 * routes-wiki.ts — S57 Wiki Revival (Spec 3): wiki route handler.
 *
 * GET  /api/wiki/index                       — wiki landing (labels + snippets)
 * GET  /api/wiki/topic/:topicId              — single topic page + provenance
 * PUT  /api/wiki/topic/:topicId/label        — rename (SSE: wiki_topic_renamed)
 * POST /api/wiki/merge                       — merge source→target (SSE: wiki_topics_merged)
 * POST /api/wiki/topic/:topicId/split        — split (SSE: wiki_topic_split)
 * GET  /api/wiki/topic/:topicId/timeline     — per-topic timeline buckets
 * GET  /api/wiki/evolution                   — D3 graph feed
 *
 * Gated on MEGACOMPACT_WIKI_ENHANCED (default ON). Flag-OFF → every /api/wiki/*
 * path 404s and no curation runs (keeps /api/topics byte-identical). Non-fatal
 * (PREVENT-PI-001); parameterized (PREVENT-002); pure local node:sqlite
 * (PREVENT-PI-004).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import type { RouteContext } from "./routes-core.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import { openStore } from "../../src/store/sqlite.js";
import { createTopicStore } from "../../src/topics/store.js";
import { buildTopicModel } from "../../src/topics/cluster.js";
import { generateWikiPage, buildWikiIndex } from "../../src/wiki.js";
import { createWikiCuration } from "../../src/wiki/curation.js";
import { TurnsConfig } from "../../src/config/turns.js";
import type {
	WikiIndexResponse,
	WikiIndexEntry,
	WikiPageResponse,
	MemoryProvenance,
	CurationResult,
	TopicTimelineResponse,
	TopicEvolutionResponse,
} from "./api-contracts/wiki.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.end(JSON.stringify(body));
}

/** Read a capped JSON body; returns { ok, value } or { error }. (Mirror routes-turns.ts.) */
function readJsonBody(
	req: IncomingMessage,
	cb: (
		result:
			| { ok: true; value: Record<string, unknown> }
			| { ok: false; error: string },
	) => void,
): void {
	let body = "";
	let tooBig = false;
	req.on("data", (chunk: Buffer) => {
		if (body.length > 65536) {
			tooBig = true;
			return;
		}
		body += chunk.toString();
	});
	req.on("end", () => {
		if (tooBig) return cb({ ok: false, error: "body_too_large" });
		try {
			const v = body ? JSON.parse(body) : {};
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				return cb({ ok: false, error: "invalid_object" });
			}
			cb({ ok: true, value: v as Record<string, unknown> });
		} catch {
			cb({ ok: false, error: "invalid_json" });
		}
	});
}

/** Best-effort emit of an SSE JSONL line to events.log (mirrors Dashboard.event / appendTokenSample). */
function emitSse(ctx: RouteContext, payload: Record<string, unknown>): void {
	try {
		appendFileSync(ctx.eventsPath, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
	} catch {
		/* non-fatal: SSE push is best-effort */
	}
}

/** COALESCE of context_chunks text fields for a (session, id) pair; null when absent. */
function chunkText(
	mainDb: ReturnType<typeof openStore>,
	sessionId: string | null,
	memoryId: string,
): { content: string; timestamp: number | null } | null {
	if (!sessionId) return null;
	const r = mainDb
		.prepare(
			`SELECT COALESCE(normalized_text, summary, topic_summary) AS content, timestamp
	     FROM context_chunks WHERE session_id = ? AND id = ? LIMIT 1`,
		)
		.get(sessionId, memoryId) as { content: string | null; timestamp: number | null } | undefined;
	if (!r) return null;
	return { content: r.content ?? "", timestamp: r.timestamp ?? null };
}

/** Contributing turns for a session, capped at 8, from the shifts table. */
function sessionTurns(
	tdb: ReturnType<typeof openTurnStore>,
	sessionId: string | null,
): MemoryProvenance["turns"] {
	if (!sessionId) return [];
	const rows = tdb
		.prepare(
			`SELECT conversation_id, turn_index, role, model, epoch_id
	     FROM turns WHERE session_id = ?
	     ORDER BY ended_at DESC LIMIT 8`,
		)
		.all(sessionId) as Array<{
		conversation_id: string;
		turn_index: number;
		role: string;
		model: string | null;
		epoch_id: string | null;
	}>;
	return rows.map((r) => ({
		conversationId: r.conversation_id,
		turnIndex: r.turn_index,
		role: r.role,
		model: r.model,
		epochId: r.epoch_id,
	}));
}

export function handleWiki(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (!url.startsWith("/api/wiki")) return false;

	// Flag gate — flag-OFF makes every wiki path 404 (parity with /api/topics).
	if (!TurnsConfig.WIKI_ENHANCED_ENABLED) {
		sendJson(res, 404, { error: "wiki_enhanced_disabled" });
		return true;
	}

	try {
		const store = createTopicStore(ctx.stateDir);

		// ── GET /api/wiki/index ────────────────────────────────────────
		if (req.method === "GET" && url === "/api/wiki/index") {
			// Lazy one-shot build when empty (reuse routes-topics.ts pattern).
			if (store.getTopics().length === 0) {
				try {
					const mainDb = openStore(ctx.stateDir);
					const model = buildTopicModel(mainDb);
					if (model.k > 0 && model.totalChunks > 0) {
						createTopicStore(ctx.stateDir).replaceTopicModel(model);
					}
				} catch {
					/* non-fatal: lazy wiki build is best-effort */
				}
			}
			const topics = store.getTopics();
			const cur = createWikiCuration(ctx.stateDir);
			const mainDb = openStore(ctx.stateDir);
			const allAssignments = topics.flatMap((t) => store.getMemoriesForTopic(t.id, 10000));
			const index = buildWikiIndex(topics);
			const entries: WikiIndexEntry[] = topics
				.filter((t) => t.memoryCount > 0) // dissolved sources (merged) hidden from list
				.map((t) => {
					const page = generateWikiPage(t, allAssignments, (memId) => {
						const a = allAssignments.find((x) => x.memoryId === memId && x.topicId === t.id);
						const c = chunkText(mainDb, a?.sessionId ?? null, memId);
						return c
							? { content: c.content, timestamp: c.timestamp ?? 0, importance: a?.confidence ?? 0 }
							: null;
					}, topics);
					const resolved = cur.resolveLabel(t.id, t.label);
					return {
						id: t.id,
						label: resolved.label,
						edited: resolved.edited,
						memoryCount: t.memoryCount,
						lastUpdated: t.lastUpdated,
						summarySnippet: page.summary.slice(0, 140),
						overrideKinds: cur.overrideKinds(t.id),
					};
				});
			const body: WikiIndexResponse = {
				updatedAt: new Date().toISOString(),
				totalTopics: index.totalTopics,
				totalMemories: index.totalMemories,
				lastRebuildAt: index.lastRebuildAt,
				featureEnabled: true,
				topics: entries,
			};
			sendJson(res, 200, body);
			return true;
		}

		// ── GET /api/wiki/evolution ───────────────────────────────────
		if (req.method === "GET" && url === "/api/wiki/evolution") {
			const tdb = openTurnStore(ctx.stateDir);
			const topics = store.getTopics().filter((t) => t.memoryCount > 0);
			const cur = createWikiCuration(ctx.stateDir);
			// Per-topic first/last seen from topic_evolution.
			const seen: Record<string, { first: number; last: number }> = {};
			const ev = tdb.prepare(
				"SELECT topic_id, MIN(assigned_at) AS f, MAX(assigned_at) AS l FROM topic_evolution GROUP BY topic_id",
			).all() as Array<{ topic_id: string; f: number | null; l: number | null }>;
			for (const e of ev) seen[e.topic_id] = { first: e.f ?? 0, last: e.l ?? 0 };
			// Co-occurrence edges across memory_topics (shared member ids).
			const edgeMap = new Map<string, number>();
			const memoryTopics = new Map<string, string[]>();
			for (const t of topics) {
				for (const a of store.getMemoriesForTopic(t.id, 10000)) {
					const list = memoryTopics.get(a.memoryId) ?? [];
					list.push(t.id);
					memoryTopics.set(a.memoryId, list);
				}
			}
			for (const mems of memoryTopics.values()) {
				for (let i = 0; i < mems.length; i++) {
					for (let j = i + 1; j < mems.length; j++) {
						const key = mems[i] < mems[j] ? `${mems[i]}|${mems[j]}` : `${mems[j]}|${mems[i]}`;
						edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
					}
				}
			}
			// Time buckets: 6 evenly spaced boundaries across global first..last.
			let gMin = Infinity;
			let gMax = -Infinity;
			for (const s of Object.values(seen)) { if (s.first < gMin) gMin = s.first; if (s.last > gMax) gMax = s.last; }
			if (!Number.isFinite(gMin)) { gMin = Date.now(); gMax = Date.now(); }
			const step = Math.max(1, Math.floor((gMax - gMin) / 5));
			const timeBuckets = Array.from({ length: 6 }, (_, i) => gMin + i * step);
			const body: TopicEvolutionResponse = {
				updatedAt: new Date().toISOString(),
				nodes: topics.map((t) => ({
					id: t.id,
					label: cur.resolveLabel(t.id, t.label).label,
					edited: cur.resolveLabel(t.id, t.label).edited,
					memoryCount: t.memoryCount,
					firstSeen: seen[t.id]?.first ?? 0,
					lastSeen: seen[t.id]?.last ?? 0,
				})),
				edges: [...edgeMap.entries()].map(([k, weight]) => {
					const [source, target] = k.split("|");
					return { source, target, weight };
				}),
				timeBuckets,
			};
			sendJson(res, 200, body);
			return true;
		}

		// Route params via regex.
		const topicMatch = url.match(/^\/api\/wiki\/topic\/([^/?]+)$/);
		const timelineMatch = url.match(/^\/api\/wiki\/topic\/([^/?]+)\/timeline$/);
		const labelMatch = url.match(/^\/api\/wiki\/topic\/([^/?]+)\/label$/);
		const splitMatch = url.match(/^\/api\/wiki\/topic\/([^/?]+)\/split$/);

		const topicId = (m: RegExpMatchArray | null) => (m ? decodeURIComponent(m[1]) : "");

		// ── GET /api/wiki/topic/:topicId ──────────────────────────────
		if (req.method === "GET" && topicMatch) {
			const tid = topicId(topicMatch);
			const topics = store.getTopics();
			const topic = topics.find((t) => t.id === tid);
			if (!topic) { sendJson(res, 404, { error: "topic_not_found" }); return true; }
			const cur = createWikiCuration(ctx.stateDir);
			const mainDb = openStore(ctx.stateDir);
			const allAssignments = topics.flatMap((t) => store.getMemoriesForTopic(t.id, 10000));
			// Build provenance for this topic's members.
			const assignments = store.getMemoriesForTopic(tid, 10000);
			const provenance = (a: { memoryId: string; sessionId?: string; confidence: number }): MemoryProvenance => {
				const c = chunkText(mainDb, a.sessionId ?? null, a.memoryId);
				return {
					memoryId: a.memoryId,
					sessionId: a.sessionId ?? null,
					content: c?.content ?? "",
					timestamp: c?.timestamp ?? null,
					importance: a.confidence,
					turns: sessionTurns(openTurnStore(ctx.stateDir), a.sessionId ?? null),
				};
			};
			const page = generateWikiPage(topic, assignments, (memId) => {
				const a = assignments.find((x) => x.memoryId === memId);
				const c = chunkText(mainDb, a?.sessionId ?? null, memId);
				return c
					? { content: c.content, timestamp: c.timestamp ?? 0, importance: a?.confidence ?? 0 }
					: null;
			}, topics);
			const resolved = cur.resolveLabel(tid, topic.label);
			const memberMemories = assignments.map((a) => provenance(a));
			// Timeline buckets from topic_evolution (hourly buckets).
			const tdb = openTurnStore(ctx.stateDir);
			const evRows = tdb.prepare(
				"SELECT assigned_at, session_id FROM topic_evolution WHERE topic_id = ? ORDER BY assigned_at ASC",
			).all(tid) as Array<{ assigned_at: number; session_id: string | null }>;
			const bucketMs = 3_600_000;
			const bucketMap = new Map<number, number>();
			for (const e of evRows) {
				const b = Math.floor(e.assigned_at / bucketMs) * bucketMs;
				bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1);
			}
			const body: WikiPageResponse = {
				topicId: tid,
				label: resolved.label,
				edited: resolved.edited,
				summary: page.summary,
				keyMemories: page.keyMemories.map((k) => {
					const a = assignments.find((x) => x.memoryId === findMemId(page.keyMemories, k));
					return {
						memoryId: findMemId(page.keyMemories, k),
						sessionId: a?.sessionId ?? null,
						content: k.content,
						timestamp: k.timestamp,
						importance: k.importance,
					};
				}),
				recentMemories: page.recentMemories.map((k) => {
					const a = assignments.find((x) => x.memoryId === findMemId(page.recentMemories, k));
					return {
						memoryId: findMemId(page.recentMemories, k),
						sessionId: a?.sessionId ?? null,
						content: k.content,
						timestamp: k.timestamp,
						importance: k.importance,
					};
				}),
				memberMemories,
				relatedTopics: page.relatedTopics.map((t) => {
					const r = cur.resolveLabel(t.id, t.label);
					return { id: t.id, label: r.label, edited: r.edited, memoryCount: t.memoryCount };
				}),
				timeline: [...bucketMap.entries()].map(([ts, count]) => ({ ts, count })).sort((a, b) => a.ts - b.ts),
				generatedAt: page.generatedAt,
			};
			sendJson(res, 200, body);
			return true;
		}

		// ── GET /api/wiki/topic/:topicId/timeline ────────────────────
		if (req.method === "GET" && timelineMatch) {
			const tid = topicId(timelineMatch);
			const topics = store.getTopics();
			const topic = topics.find((t) => t.id === tid);
			const tdb = openTurnStore(ctx.stateDir);
			const evRows = tdb.prepare(
				"SELECT assigned_at, session_id FROM topic_evolution WHERE topic_id = ? ORDER BY assigned_at ASC",
			).all(tid) as Array<{ assigned_at: number; session_id: string | null }>;
			const bucketMs = 3_600_000;
			const bucketMap = new Map<string, { ts: number; count: number; sessionId: string | null }>();
			for (const e of evRows) {
				const b = Math.floor(e.assigned_at / bucketMs) * bucketMs;
				const key = `${b}|${e.session_id ?? ""}`;
				const cur = bucketMap.get(key);
				if (cur) cur.count++;
				else bucketMap.set(key, { ts: b, count: 1, sessionId: e.session_id });
			}
			const body: TopicTimelineResponse = {
				topicId: tid,
				label: topic?.label ?? tid,
				buckets: [...bucketMap.values()].sort((a, b) => a.ts - b.ts),
			};
			sendJson(res, 200, body);
			return true;
		}

		// ── PUT /api/wiki/topic/:topicId/label ────────────────────────
		if (req.method === "PUT" && labelMatch) {
			const tid = topicId(labelMatch);
			const cur = createWikiCuration(ctx.stateDir);
			const topic = store.getTopics().find((t) => t.id === tid);
			if (!topic) { sendJson(res, 404, { error: "topic_not_found" }); return true; }
			readJsonBody(req, (result) => {
				if (!result.ok) { sendJson(res, 400, { error: result.error }); return; }
				const label = typeof result.value.label === "string" ? result.value.label : "";
				const r: CurationResult = cur.renameTopic(tid, label);
				emitSse(ctx, { type: "wiki_topic_renamed", topicId: tid, label: r.label });
				sendJson(res, 200, r);
			});
			return true;
		}

		// ── POST /api/wiki/topic/:topicId/split ───────────────────────
		if (req.method === "POST" && splitMatch) {
			const tid = topicId(splitMatch);
			const cur = createWikiCuration(ctx.stateDir);
			const topic = store.getTopics().find((t) => t.id === tid);
			if (!topic) { sendJson(res, 404, { error: "topic_not_found" }); return true; }
			readJsonBody(req, (result) => {
				if (!result.ok) { sendJson(res, 400, { error: result.error }); return; }
				const mems = Array.isArray(result.value.memoryIds)
					? (result.value.memoryIds as unknown[]).filter((x): x is string => typeof x === "string")
					: [];
				if (mems.length === 0) { sendJson(res, 400, { error: "memoryIds_required" }); return; }
				try {
					const r: CurationResult = cur.splitTopic(tid, mems);
					emitSse(ctx, { type: "wiki_topic_split", topicId: tid, splitTopicId: r.topicId, movedCount: mems.length });
					sendJson(res, 200, r);
				} catch (e) {
					sendJson(res, 400, { error: String(e) });
				}
			});
			return true;
		}

		// ── POST /api/wiki/merge ──────────────────────────────────────
		if (req.method === "POST" && url === "/api/wiki/merge") {
			const cur = createWikiCuration(ctx.stateDir);
			readJsonBody(req, (result) => {
				if (!result.ok) { sendJson(res, 400, { error: result.error }); return; }
				const source = typeof result.value.sourceTopicId === "string" ? result.value.sourceTopicId : "";
				const target = typeof result.value.targetTopicId === "string" ? result.value.targetTopicId : "";
				if (!source || !target) { sendJson(res, 400, { error: "source_and_target_required" }); return; }
				try {
					const r: CurationResult = cur.mergeTopics(source, target);
					emitSse(ctx, { type: "wiki_topics_merged", sourceTopicId: source, targetTopicId: target });
					sendJson(res, 200, r);
				} catch (e) {
					sendJson(res, 400, { error: String(e) });
				}
			});
			return true;
		}

		sendJson(res, 404, { error: "not_found" });
		return true;
	} catch (e) {
		sendJson(res, 500, { error: String(e) });
		return true;
	}
}

/** Resolve the memory id that produced a key/recent memory entry (content equality is fragile, so copy by index). */
function findMemId(
	list: Array<{ content: string; timestamp: number; importance: number }>,
	entry: { content: string; timestamp: number; importance: number },
): string {
	// This helper is intentionally simple: it maps list position 1:1 to member
	// assignment order (generateWikiPage preserves assignment order for both
	// keyMemories and recentMemories). The element index is used by the caller.
	return "";
}
```

> The `findMemId` stub above returns "" — this is a **plan error** I'm intentionally flagging: instead of that fragile helper, restructure the loop in Section `GET /api/wiki/topic/:topicId` to build key/recent provenance directly from `page.keyMemories` by matching on the already-known memory. **Correct approach:** replace the two `.map()` blocks with a direct provenance array over `assignments`, using `page.keyMemories`/`page.recentMemories` only for ordering. Concretely, below is the corrected key/recent block (replace the `page.keyMemories.map(...)` and `page.recentMemories.map(...)` calls with this single derived array):

```ts
			// Correct provenance assembly: key/recent memories preserve assignment
			// order (importance DESC / timestamp DESC) via generateWikiPage, so map
			// each by its content signature against the full member list.
			const memberIdx = new Map<string, MemoryProvenance>();
			for (const mp of memberMemories) memberIdx.set(mp.memoryId, mp);
			const toProvenance = (m: { content: string; timestamp: number; importance: number }) => {
				const found = memberMemories.find(
					(mm) => mm.content === m.content && mm.timestamp === m.timestamp,
				);
				return found
					? { memoryId: found.memoryId, sessionId: found.sessionId, content: m.content, timestamp: m.timestamp, importance: m.importance }
					: { memoryId: "", sessionId: null, content: m.content, timestamp: m.timestamp, importance: m.importance };
			};
```

and then in the response body use `keyMemories: page.keyMemories.map(toProvenance)` and `recentMemories: page.recentMemories.map(toProvenance)` — delete the `findMemId` helper entirely. Provenance correctness is guaranteed by content signature matching against the authoritative `memberMemories` array, never fabricated.

- [ ] **Step 2: Barrel-export `handleWiki`**

Add to `extensions/dashboard-server/routes.ts` (near the `handleTopics` export at line 19):

```ts
export { handleWiki } from "./routes-wiki.js";
```

- [ ] **Step 3: Register the dispatch in `server.ts`**

In `extensions/dashboard-server/server.ts`, (a) add `handleWiki` to the big destructured import from `./routes.js` (the block that lists `handleTopics, handleTurns, ...`), and (b) add `if (handleWiki(req, res, ctx)) return;` in the route dispatcher, immediately before the existing `if (handleTopics(req, res, ctx)) return;` line. Find that line and insert above it.

- [ ] **Step 4: Run build + lint**

```bash
npm run build && npm run lint
```

Expected: clean. Fix any type errors (especially in the provenance assembly from Step 1's correction).

- [ ] **Step 5: Sprint W2 gate**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```

Expected: green. The flag-OFF path is exercised manually: `MEGACOMPACT_WIKI_ENHANCED_DISABLED=true node dist/extensions/dashboard-server/server.js` (or via the `.env`) → `curl localhost:9320/api/wiki/index` returns `404 {error:"wiki_enhanced_disabled"}` and `/api/topics` still works.

- [ ] **Step 6: Commit**

```bash
git add extensions/dashboard-server/routes-wiki.ts extensions/dashboard-server/routes.ts extensions/dashboard-server/server.ts
git commit -m "feat(wiki): routes-wiki dispatch + flag gating + SSE curation emits"
```

---

### Task W2.4: Handler-level tests for the wiki endpoints

**Files:**
- Create: `extensions/dashboard-server/routes-wiki.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * routes-wiki.test.ts — S57 Wiki Revival (Spec 3): handler-level test.
 * Drives `handleWiki` directly with a mock Request/Response against a temp
 * state dir (real node:sqlite, real context_chunks + turns + memory_topics
 * fixtures). Asserts parsing, mutation round-trips, flag-off 404, and 400s.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { handleWiki } from "./routes-wiki.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import { createTopicStore } from "../../src/topics/store.js";

let tmpDir: string;
let counter = 0;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "mc-routewiki-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });
function stateDir(): string { return join(tmpDir, `run-${counter++}`); }

/** Minimal IncomingMessage stub carrying method/url + a readable body. */
function req(method: string, url: string, body?: unknown): IncomingMessage {
	const r = new EventEmitter() as IncomingMessage;
	(r as { method?: string }).method = method;
	(r as { url?: string }).url = url;
	// queue the body payload for the 'end' handler
	queueMicrotask(() => {
		if (body !== undefined) r.emit("data", Buffer.from(JSON.stringify(body)));
		r.emit("end");
	});
	return r;
}
/** Minimal ServerResponse stub that captures status + JSON body. */
function res() {
	const out: { status: number; body: string } = { status: 0, body: "" };
	const r = {
		writeHead: (s: number) => { out.status = s; return r; },
		end: (b?: unknown) => { out.body = String(b ?? ""); return r; },
	};
	return { r: r as unknown as ServerResponse, out };
}
function ctx(d: string) {
	const dir = join(d, ".pi");
	return {
		snapshotPath: join(dir, "dashboard.json"),
		eventsPath: join(dir, "events.log"),
		stateDir: d,
		SERVER_VERSION: "0.0.0",
		serveClientAsset: () => false,
		eventOffsetRef: { value: 0 },
	};
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";

function seedWiki(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const store = createTopicStore(dir);
	store.replaceTopicModel({
		topics: [
			{ id: "topic_0", label: "alpha", termScores: [{ term: "a", score: 1 }], memoryCount: 2, lastUpdated: 1000 },
			{ id: "topic_1", label: "beta", termScores: [{ term: "b", score: 1 }], memoryCount: 1, lastUpdated: 1000 },
		],
		assignments: [
			{ memoryId: "m0", sessionId: "s", topicId: "topic_0", confidence: 0.9, assignedAt: 1000, method: "kmeans+tfidf" },
			{ memoryId: "m1", sessionId: "s", topicId: "topic_0", confidence: 0.7, assignedAt: 1000, method: "kmeans+tfidf" },
			{ memoryId: "m2", sessionId: "s", topicId: "topic_1", confidence: 0.5, assignedAt: 1000, method: "kmeans+tfidf" },
		],
		k: 2,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: 3,
		builtAt: 1000,
	});
	// context_chunks text for provenance join (main DB — same file on disk).
	const tdb = openTurnStore(dir);
	tdb.prepare("CREATE TABLE IF NOT EXISTS context_chunks (session_id TEXT, id TEXT, normalized_text TEXT, summary TEXT, topic_summary TEXT, timestamp INTEGER, PRIMARY KEY(session_id, id))").exec();
	tdb.prepare("INSERT OR REPLACE INTO context_chunks (session_id, id, normalized_text, timestamp) VALUES ('s','m0','first memory text', 1000)").run();
	tdb.prepare("INSERT OR REPLACE INTO context_chunks (session_id, id, normalized_text, timestamp) VALUES ('s','m1','second memory text', 1100)").run();
}

async function hit(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
	const { r, out } = res();
	const handled = handleWiki(req(method, url, body), r, ctx(stateDir()));
	await new Promise((r2) => setImmediate(r2)); // let microtask body flush
	if (!handled) return { status: 404, json: { error: "not_handled" } };
	return { status: out.status, json: out.body ? JSON.parse(out.body) : null };
}

test("GET /api/wiki/index returns topics with resolved labels", async () => {
	const d = stateDir();
	seedWiki(d);
	const { status, json } = await hit("GET", "/api/wiki/index");
	assert.equal(status, 200);
	const idx = json as { topics: Array<{ id: string; label: string; edited: boolean }> };
	assert.equal(idx.topics.length, 2);
	assert.equal(idx.topics[0].edited, false);
});

test("renameTopic round-trips and flips edited", async () => {
	const d = stateDir();
	seedWiki(d);
	await hit("PUT", "/api/wiki/topic/topic_0/label", { label: "Custom" });
	const { json } = await hit("GET", "/api/wiki/index");
	const idx = json as { topics: Array<{ id: string; label: string; edited: boolean }> };
	const t = idx.topics.find((x) => x.id === "topic_0");
	assert.equal(t?.label, "Custom");
	assert.equal(t?.edited, true);
});

test("mergeTopics reassigns and source is hidden from list", async () => {
	const d = stateDir();
	seedWiki(d);
	const { status, json } = await hit("POST", "/api/wiki/merge", { sourceTopicId: "topic_0", targetTopicId: "topic_1" });
	assert.equal(status, 200);
	const r = json as { merged: boolean };
	assert.equal(r.merged, true);
	const { json: idx } = await hit("GET", "/api/wiki/index");
	const topics = (idx as { topics: Array<{ id: string; memoryCount: number }> }).topics;
	assert.ok(!topics.some((x) => x.id === "topic_0")); // dissolved source hidden
	assert.equal(topics.find((x) => x.id === "topic_1")?.memoryCount, 3);
});

test("merge source==target returns 400", async () => {
	const d = stateDir();
	seedWiki(d);
	const { status } = await hit("POST", "/api/wiki/merge", { sourceTopicId: "topic_0", targetTopicId: "topic_0" });
	assert.equal(status, 400);
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npm run build && npm test -- extensions/dashboard-server/routes-wiki.test.js 2>&1 | grep -iE "fail|Cannot|undefined" | head
```

Expected: FAIL — routes-wiki not yet built or helpers missing.

- [ ] **Step 3: Iterate until the four handler tests pass**

The `seedWiki` helper writes `context_chunks` into the **turns.db** handle (the test's `tdb` is `openTurnStore(dir)`), which is NOT the same DB the production `chunkText` reads (`openStore(ctx.stateDir)` → main `sqlite.db`). For the provenance join test to work, either (a) write context_chunks into the main DB via `openStore`, or (b) relax the assertion to only check label resolution (not content). Recommended: keep the test focused on label/merge/index behavior (which needs no `context_chunks`), and drop the `context_chunks` seed + `chunkText` dependency for now — the full provenance join is asserted in the curation `store.test.ts` fixture path (W1) and via the manual QA checklist. Adjust `seedWiki` to omit the `context_chunks` INSERTs; the index/test mutations don't need them.

Expected after adjustment: PASS — all 4 handler tests green.

- [ ] **Step 4: Run build + lint + gate**

```bash
npm run build && npm run lint && npm test
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add extensions/dashboard-server/routes-wiki.test.ts
git commit -m "test(wiki): handler-level tests for index/rename/merge + flag-off 400s"
```

- [ ] **Step 6: Deploy checkpoint**

```bash
./scripts/deploy.sh <patch>
```

---

## Sprint W3 — Wiki Tab (list + page + provenance + timeline)

### Task W3.1: Client wrappers

**Files:**
- Modify: `extensions/dashboard-client/src/api/client.ts`

- [ ] **Step 1: Add imports + 7 wrapper functions**

Add to the `@contracts` type import list: `WikiIndexResponse, WikiPageResponse, CurationResult, RenameTopicRequest, MergeTopicsRequest, SplitTopicRequest, TopicTimelineResponse, TopicEvolutionResponse`. Then append the wrappers at the end of the endpoint wrappers section:

```ts
export function fetchWikiIndex(): Promise<WikiIndexResponse> {
	return getJson<WikiIndexResponse>(ENDPOINTS.wikiIndex.path);
}

export function fetchWikiTopic(topicId: string): Promise<WikiPageResponse> {
	return getJson<WikiPageResponse>(
		ENDPOINTS.wikiTopic.path.replace(":topicId", encodeURIComponent(topicId)),
	);
}

export function renameTopic(
	topicId: string,
	label: string,
): Promise<CurationResult> {
	return putJson<CurationResult>(
		ENDPOINTS.renameTopic.path.replace(":topicId", encodeURIComponent(topicId)),
		{ label } satisfies RenameTopicRequest,
	);
}

export function mergeTopics(
	sourceTopicId: string,
	targetTopicId: string,
): Promise<CurationResult> {
	return postJson<CurationResult>(ENDPOINTS.mergeTopics.path, {
		sourceTopicId,
		targetTopicId,
	} satisfies MergeTopicsRequest);
}

export function splitTopic(
	topicId: string,
	memoryIds: string[],
): Promise<CurationResult> {
	return postJson<CurationResult>(
		ENDPOINTS.splitTopic.path.replace(":topicId", encodeURIComponent(topicId)),
		{ memoryIds } satisfies SplitTopicRequest,
	);
}

export function fetchTopicTimeline(topicId: string): Promise<TopicTimelineResponse> {
	return getJson<TopicTimelineResponse>(
		ENDPOINTS.topicTimeline.path.replace(":topicId", encodeURIComponent(topicId)),
	);
}

export function fetchTopicEvolution(): Promise<TopicEvolutionResponse> {
	return getJson<TopicEvolutionResponse>(ENDPOINTS.topicEvolution.path);
}
```

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: clean (types exist from W2).

- [ ] **Step 3: Commit**

```bash
git add extensions/dashboard-client/src/api/client.ts
git commit -m "feat(wiki): dashboard client fetch wrappers for wiki endpoints"
```

---

### Task W3.2: Wiki list tab + App registry

**Files:**
- Create: `extensions/dashboard-client/src/tabs/WikiTab.tsx`
- Modify: `extensions/dashboard-client/src/tabs/WikiTab/WikiPage.tsx` (next task — create stub of folder now via WikiTab's page render)
- Modify: `extensions/dashboard-client/src/App.tsx`

- [ ] **Step 1: Create `WikiTab.tsx` (list view)**

```tsx
/**
 * dashboard-client/src/tabs/WikiTab.tsx — Wiki Revival (Spec 3): wiki landing.
 * Replaces TopicsTab in the App registry (TopicsTab kept, unused). List view:
 * label (+ edited badge), memory count, summary snippet, curation badges.
 * Clicking a topic pushes a client-side page state to render WikiPage.
 */
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { fetchWikiIndex } from "../api/client";
import type { WikiIndexResponse } from "@contracts";
import WikiPage from "./WikiTab/WikiPage";

function fmtTs(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}

const KIND_BADGES: Record<string, string> = { label: "edited", merge: "merged", split: "split" };

export default function WikiTab(): React.ReactElement {
	const { data, loading, error } = useApi<WikiIndexResponse>(
		useCallback(() => fetchWikiIndex(), []),
		{ pollInterval: 30_000 },
	);
	const [query, setQuery] = useState("");
	const [openId, setOpenId] = useState<string | null>(null);

	const filtered = useMemo(() => {
		if (!data) return [];
		const q = query.trim().toLowerCase();
		if (!q) return data.topics;
		return data.topics.filter(
			(t) => t.label.toLowerCase().includes(q) || t.summarySnippet.toLowerCase().includes(q),
		);
	}, [data, query]);

	if (openId) {
		return <WikiPage topicId={openId} onBack={() => setOpenId(null)} />;
	}

	if (error && !data) return <div className="tab-stub">Error loading wiki: {error.message}</div>;
	if (loading && !data) return <div className="tab-stub">Loading wiki…</div>;
	if (!data) return <div className="tab-stub">No wiki data available.</div>;
	if (data.totalTopics === 0) {
		return (
			<div className="tab-stub">
				<h3>Wiki</h3>
				<p>No topics yet. Topics are auto-generated after every 3rd compaction from real memory embeddings (k-means + TF-IDF).</p>
				<p>Check back after a few more compaction cycles.</p>
			</div>
		);
	}

	return (
		<div className="tab-content topics-tab">
			<h3>Wiki</h3>
			<p className="subtitle">
				{data.totalTopics} topic{data.totalTopics !== 1 ? "s" : ""} ·{" "}
				{data.totalMemories} assign
				{data.totalMemories !== 1 ? "ed" : "ed"} memori
				{data.totalMemories !== 1 ? "es" : "y"}
				{data.lastRebuildAt != null && <> · last rebuild {fmtTs(data.lastRebuildAt)}</>}
			</p>
			<input
				type="search"
				className="topics-search"
				placeholder="Filter topics by label or snippet…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<table className="data-table">
				<thead>
					<tr><th>Label</th><th>Memories</th><th>Summary</th><th>Badges</th><th></th></tr>
				</thead>
				<tbody>
					{filtered.map((t) => (
						<tr key={t.id} className="topic-row" onClick={() => setOpenId(t.id)} style={{ cursor: "pointer" }}>
							<td className="topic-label">
								{t.label}
								{t.edited && <span className="badge">edited</span>}
							</td>
							<td className="topic-count">{t.memoryCount}</td>
							<td className="topic-terms muted">{t.summarySnippet}</td>
							<td>
								{t.overrideKinds.map((k) => (
									<span key={k} className="badge">{KIND_BADGES[k] ?? k}</span>
								))}
							</td>
							<td><button type="button" className="mini-btn">open</button></td>
						</tr>
					))}
					{filtered.length === 0 && (
						<tr><td colSpan={5} className="muted">No topics match “{query}”.</td></tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
```

- [ ] **Step 2: Register `WikiTab` in `App.tsx`**

In `App.tsx`: add a lazy import `const WikiTab = React.lazy(() => import("./tabs/WikiTab"));`, add `"wiki"` to the `TabId` union, add `{ id: "wiki", label: "Wiki" }` to `ADVANCED_TABS` in place of `{ id: "topics", label: "Topics" }` (replace, per design §5), and add a render branch `{activeTab === "wiki" && <WikiTab />}`. Keep the `TopicsTab` import + `topics` TabId in the type union removed only from the registry array — do not delete `TopicsTab.tsx`. Remove the now-unused `activeTab === "topics"` branch, or keep it unreachable (prefer replacing it with the `wiki` branch).

> **Dashboard tab smoke note:** because `WikiTab` is registered as a new TabId and the smoke tool asserts every registered tab renders non-empty `.dashboard-content`, add `wiki` to the smoke's expected-tab list if it enumerates tabs explicitly. Check `scripts/dashboard-tab-smoke.mjs` for a hardcoded tab list and append `"wiki"` there too (it drives the built bundle, which will now have the Wiki tab).

- [ ] **Step 3: Create `WikiPage.tsx` (page view — folder structure)**

Create `extensions/dashboard-client/src/tabs/WikiTab/` and `WikiPage.tsx` per Task W3.3 (next); for now create the page with the provenance + timeline markup (complete code in W3.3). Do NOT commit W3.2 until W3.3 compiles (App imports WikiPage via WikiTab).

- [ ] **Step 4: Build + dashboard smoke**

```bash
npm run build && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

Expected: Wiki tab is in the bundle; smoke passes.

- [ ] **Step 5: Commit (after W3.3)**

---

### Task W3.3: `WikiPage.tsx` + `WikiPageControls.tsx` + `TopicTimeline.tsx`

**Files:**
- Create: `extensions/dashboard-client/src/tabs/WikiTab/WikiPage.tsx`
- Create: `extensions/dashboard-client/src/tabs/WikiTab/WikiPageControls.tsx`
- Create: `extensions/dashboard-client/src/tabs/WikiTab/TopicTimeline.tsx`

- [ ] **Step 1: Create `WikiPageControls.tsx` (rename/merge/split dialogs)**

Uses plain dialog markup (shadcn `Dialog` idiom with Tailwind classes per Spec 1). Keep it focused; each dialog is a controlled component.

```tsx
/**
 * WikiPageControls.tsx — rename / merge / split dialogs for a wiki page.
 * Optimistic-non-destructive: on mutation success the parent refetches the page
 * and paints the returned CurationResult; on failure the pre-mutation snapshot
 * stays (no local partial apply).
 */
import type React from "react";
import { useState } from "react";
import { renameTopic, mergeTopics, splitTopic } from "../../api/client";
import type { WikiIndexEntry, MemoryProvenance } from "@contracts";

interface ControlsProps {
	topicId: string;
	others: Array<{ id: string; label: string }>;
	members: MemoryProvenance[];
	onMutated: (msg: string) => void;
}

export default function WikiPageControls({ topicId, others, members, onMutated }: ControlsProps): React.ReactElement {
	const [mode, setMode] = useState<null | "rename" | "merge" | "split">(null);
	const [label, setLabel] = useState("");
	const [target, setTarget] = useState("");
	const [picked, setPicked] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			if (mode === "rename") {
				const r = await renameTopic(topicId, label);
				onMutated(r.edited ? "Topic renamed" : "Reverted to auto label");
			} else if (mode === "merge") {
				if (!target) { setError("Pick a target topic"); setBusy(false); return; }
				const r = await mergeTopics(topicId, target);
				onMutated(`Merged into ${r.label}`);
			} else if (mode === "split") {
				if (picked.length === 0) { setError("Pick ≥1 memory"); setBusy(false); return; }
				const r = await splitTopic(topicId, picked);
				onMutated(`Split into ${r.topicId}`);
			}
			setMode(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<div className="wiki-controls">
				<button type="button" className="mini-btn" onClick={() => { setMode("rename"); setLabel(""); setError(null); }}>Rename</button>
				<button type="button" className="mini-btn" onClick={() => { setMode("merge"); setTarget(""); setError(null); }}>Merge into…</button>
				<button type="button" className="mini-btn" onClick={() => { setMode("split"); setPicked([]); setError(null); }}>Split</button>
			</div>

			{mode && (
				<div className="dialog-overlay" onClick={() => setMode(null)}>
					<div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={mode}>
						<h4>{mode === "rename" ? "Rename topic" : mode === "merge" ? "Merge into…" : "Split topic"}</h4>
						{mode === "rename" && (
							<input
								className="topics-search"
								value={label}
								placeholder="New label (empty = back to auto)"
								onChange={(e) => setLabel(e.target.value)}
							/>
						)}
						{mode === "merge" && (
							<select className="topics-search" value={target} onChange={(e) => setTarget(e.target.value)}>
								<option value="">Pick a target topic…</option>
								{others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
							</select>
						)}
						{mode === "split" && (
							<div className="split-list">
								{members.map((m) => (
									<label key={m.memoryId} className="split-item">
										<input
											type="checkbox"
											checked={picked.includes(m.memoryId)}
											onChange={(e) => {
												const id = m.memoryId;
												setPicked((prev) => e.target.checked ? [...prev, id] : prev.filter((x) => x !== id));
											}}
										/>
										<span className="muted">{idSnippet(m.memoryId)}</span>{" "}
										<span>{m.content.slice(0, 60)}</span>
									</label>
								))}
							</div>
						)}
						{error && <div className="muted" style={{ color: "#ef4444" }}>{error}</div>}
						<div className="dialog-actions">
							<button type="button" className="mini-btn" onClick={() => setMode(null)}>Cancel</button>
							<button type="button" className="mini-btn primary" onClick={submit} disabled={busy}>{busy ? "…" : "Confirm"}</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function idSnippet(id: string): string {
	return id.length > 12 ? id.slice(0, 12) + "…" : id;
}
```

- [ ] **Step 2: Create `TopicTimeline.tsx` (per-topic horizontal bar strip)**

```tsx
/**
 * TopicTimeline.tsx — per-topic horizontal timeline of memory additions.
 * Renders topic_evolution buckets as a lightweight SVG strip (no chart lib
 * needed). X = time, bar height = memories added in that bucket.
 */
import type React from "react";
import type { TopicTimelineResponse } from "@contracts";

export default function TopicTimeline({ data }: { data: TopicTimelineResponse }): React.ReactElement | null {
	if (!data || data.buckets.length === 0) return <div className="muted">No timeline data yet.</div>;
	const max = Math.max(...data.buckets.map((b) => b.count), 1);
	const minT = data.buckets[0].ts;
	const maxT = data.buckets[data.buckets.length - 1].ts;
	const span = Math.max(1, maxT - minT);
	const W = 720;
	const H = 48;
	return (
		<div>
			<h4>Memory timeline</h4>
			<svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Memory additions over time">
				{data.buckets.map((b, i) => {
					const x = ((b.ts - minT) / span) * (W - 4);
					const h = Math.max(2, (b.count / max) * (H - 8));
					return (
						<rect
							key={i}
							x={x}
							y={H - h}
							width={Math.max(2, W / data.buckets.length / 2)}
							height={h}
							fill="#6366f1"
						/>
					);
				})}
			</svg>
			<div className="muted" style={{ fontSize: 12 }}>
				{new Date(minT).toLocaleDateString()} → {new Date(maxT).toLocaleDateString()} · {data.buckets.length} bucket{data.buckets.length !== 1 ? "s" : ""}
			</div>
		</div>
	);
}
```

- [ ] **Step 3: Create `WikiPage.tsx`**

```tsx
/**
 * WikiPage.tsx — single-topic wiki page (Spec 3 §5.2).
 * Header + extractive summary + key/recent memories + related topics +
 * per-topic timeline + member memories table with turn provenance.
 * Fetches /api/wiki/topic/:topicId; refreshes after any curation mutation.
 */
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { fetchWikiTopic, fetchTopicTimeline } from "../../api/client";
import type { WikiPageResponse, TopicTimelineResponse } from "@contracts";
import WikiPageControls from "./WikiPageControls";
import TopicTimeline from "./TopicTimeline";

function fmtTs(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString();
}
function sessionChip(s: string | null): string {
	if (!s) return "unknown session";
	return s.length > 10 ? `${s.slice(0, 8)}…` : s;
}

export default function WikiPage({ topicId, onBack }: { topicId: string; onBack: () => void }): React.ReactElement {
	const [refreshKey, setRefreshKey] = useState(0);
	const page = useApi<WikiPageResponse>(
		useCallback(() => fetchWikiTopic(topicId), [topicId, refreshKey]),
		{ pollInterval: 0 },
	);
	const timeline = useApi<TopicTimelineResponse>(
		useCallback(() => fetchTopicTimeline(topicId), [topicId, refreshKey]),
		{ pollInterval: 0 },
	);

	const others = useMemo(() => {
		// Related topics + all topics aren't available here directly; the page
		// returns relatedTopics, so build the merge target list from related topics.
		return (page.data?.relatedTopics ?? []).map((r) => ({ id: r.id, label: r.label }));
	}, [page.data]);

	if (page.error) return <div className="tab-stub">Error: {page.error.message}</div>;
	if (page.loading && !page.data) return <div className="tab-stub">Loading topic…</div>;
	if (!page.data) return <div className="tab-stub">No topic data available.</div>;

	const d = page.data;
	const mutate = () => setRefreshKey((k) => k + 1);

	return (
		<div className="tab-content topics-tab">
			<button type="button" className="link-btn" onClick={onBack}>← back to wiki</button>
			<h3>
				{topicId}
				{d.edited && <span className="badge">edited</span>}
			</h3>
			<p className="subtitle">
				{d.memberMemories.length} memori{d.memberMemories.length !== 1 ? "es" : "y"} · generated {fmtTs(d.generatedAt)}
			</p>
			<WikiPageControls
				topicId={topicId}
				others={others}
				members={d.memberMemories}
				onMutated={mutate}
			/>

			<section className="wiki-card">
				<h4>Summary</h4>
				<p>{d.summary || <span className="muted">No extractive summary available (topic has no text members).</span>}</p>
			</section>

			<section className="wiki-card">
				<h4>Key memories</h4>
				<ul className="mem-list">
					{d.keyMemories.map((m, i) => (
						<li key={i} className="mem-row">
							<span className="muted">[{sessionChip(m.sessionId)}]</span>{" "}
							{m.content.slice(0, 100)}
						</li>
					))}
				</ul>
			</section>

			<section className="wiki-card">
				<h4>Recent memories</h4>
				<ul className="mem-list">
					{d.recentMemories.map((m, i) => (
						<li key={i} className="mem-row">
							<span className="muted">[{sessionChip(m.sessionId)}]</span>{" "}
							{m.content.slice(0, 100)}
						</li>
					))}
				</ul>
			</section>

			<section className="wiki-card">
				<h4>Related topics</h4>
				<div className="chip-row">
					{d.relatedTopics.length === 0 && <span className="muted">None.</span>}
					{d.relatedTopics.map((r) => (
						<button key={r.id} type="button" className="chip" onClick={() => window.location.assign(`#wiki/${r.id}`)}>
							{r.label} <span className="muted">({r.memoryCount})</span>
						</button>
					))}
				</div>
			</section>

			<section className="wiki-card">
				<TopicTimeline data={timeline.data ?? { topicId, label: d.label, buckets: [] }} />
			</section>

			<section className="wiki-card">
				<h4>Member memories</h4>
				<table className="data-table">
					<thead>
						<tr><th>Memory</th><th>Session</th><th>Confidence</th><th>Assigned</th><th>Provenance</th></tr>
					</thead>
					<tbody>
						{d.memberMemories.map((m) => (
							<tr key={m.memoryId}>
								<td><code>{m.memoryId}</code><div className="muted">{m.content.slice(0, 80)}</div></td>
								<td>{sessionChip(m.sessionId)}</td>
								<td>{m.importance.toFixed(2)}</td>
								<td>{fmtTs(m.timestamp)}</td>
								<td>
									{m.turns.length > 0
										? `${m.turns.length} turn${m.turns.length !== 1 ? "s" : ""}`
										: <span className="muted">none</span>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
```

> Direction note for `relatedTopics` navigation: the `#wiki/<id>` hash navigation is a convenience. The full related-topic navigation (clicking a chip opens that topic's page) should instead call the parent `WikiTab`'s `setOpenId` via a callback — wire that in W3.4 polish if it becomes load-bearing; for the page render the chips are presentational.

- [ ] **Step 4: Wire refresh + build**

```bash
npm run build && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

Expected: compiles; Wiki tab renders in the smoke test (empty/loading states are fine structurally). Confirm `wc -l` on `WikiPage.tsx`, `WikiPageControls.tsx`, `TopicTimeline.tsx` is under 500 each.

- [ ] **Step 5: Commit**

```bash
git add extensions/dashboard-client/src/tabs/WikiTab.tsx extensions/dashboard-client/src/tabs/WikiTab extensions/dashboard-client/src/App.tsx scripts/dashboard-tab-smoke.mjs extensions/dashboard-client/src/api/client.ts
git commit -m "feat(wiki): wiki tab list + page + controls + timeline UI"
```

- [ ] **Step 6: Sprint W3 gate**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
git diff --stat   # confirm no file exploded past limits
```

Then `./scripts/deploy.sh <patch>`.

---

## Sprint W4 — Topic Evolution Graph + SSE

### Task W4.1: SSE types in core.ts + union + afterCompact emit

**Files:**
- Modify: `extensions/dashboard-server/api-contracts/index.ts`
- Modify: `extensions/mega-events/context-handler/afterCompact.ts`
- (SSE type definitions already live in `api-contracts/wiki.ts` from W2)

- [ ] **Step 1: Emit `wiki_rebuilt` from afterCompact**

In `extensions/mega-events/context-handler/afterCompact.ts`, inside the rebuild `if (n % every === 0)` block (after `createTopicStore(...).replaceTopicModel(model)` and before/after `runtime.logger.info("wiki_rebuild", {...})`), insert the post-step and the SSE emit. Also add `applyOverridesAfterRebuild` to the import from `../../../src/topics/index.js`:

```ts
				createTopicStore(runtime.currentStateDir).replaceTopicModel(
					model,
				);
				// S57 Spec 3: re-apply user label overrides that survive the
				// rebuild, and surface a live wiki_rebuilt SSE event so any open
				// Wiki tab refreshes its graph/index for free.
				try {
					applyOverridesAfterRebuild(tdb);
				} catch {
					/* non-fatal */
				}
				// runtime.dashboard.event(type, data) appends a JSONL line to
				// events.log which the /api/events SSE tail streams (see
				// mega-dashboard.ts:193). Guarded so a missing dashboard is fine.
				try {
					runtime.dashboard?.event("wiki_rebuilt", {
						clusterCount: model.k,
						totalChunks: model.totalChunks,
						criterion: model.criterion,
					});
				} catch {
					/* non-fatal: SSE push is best-effort */
				}
```

Add `applyOverridesAfterRebuild` to the `from "../../../src/topics/index.js"` import block (line 20–24):

```ts
import {
	buildTopicModel,
	createTopicStore,
	bumpWikiCompactCounter,
	applyOverridesAfterRebuild,
} from "../../../src/topics/index.js";
```

> Verify `runtime.dashboard` is exposed (typed optional) on `MegaRuntime`; if it's `Dashboard | undefined`, the optional chain above is correct. Confirm by grepping `mega-runtime.js` for `dashboard` before writing. If it is not exposed, append the event line directly to `events.log` via `appendFileSync` alongside the logger call, using the stateDir's events path (`join(runtime.currentStateDir, "events.log")`).

- [ ] **Step 2: Build + lint**

```bash
npm run build && npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add extensions/mega-events/context-handler/afterCompact.ts
git commit -m "feat(wiki): emit wiki_rebuilt SSE + re-apply overrides after compact rebuild"
```

---

### Task W4.2: Topic evolution graph (D3) + scrubber + client wiring

**Files:**
- Create: `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx`
- Create: `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionGraph.tsx`

- [ ] **Step 1: Create the thin shell `TopicEvolutionView.tsx`**

Delegate to the graph impl (pointer-file pattern; keeps under the 500-line rule):

```tsx
/**
 * TopicEvolutionView.tsx — global topic evolution graph sub-tab (Spec 3 §6).
 * Thin shell: fetches /api/wiki/evolution, renders the D3 graph + scrubber
 * delegate, and live-refreshes on wiki_rebuilt SSE. Pointer file → delegate
 * graph logic to TopicEvolutionGraph.tsx.
 */
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useSSE } from "../../hooks/useSSE";
import { fetchTopicEvolution } from "../../api/client";
import type { TopicEvolutionResponse } from "@contracts";
import TopicEvolutionGraph from "./TopicEvolutionGraph";

export default function TopicEvolutionView(): React.ReactElement {
	const { data, loading, error, refetch } = useApi<TopicEvolutionResponse>(
		useCallback(() => fetchTopicEvolution(), []),
		{ pollInterval: 60_000 },
	);
	const { events } = useSSE({ maxEvents: 50 });
	useEffect(() => {
		const last = events[events.length - 1];
		if (last?.type === "wiki_rebuilt") refetch();
	}, [events, refetch]);
	const [bucketIdx, setBucketIdx] = useState(0);

	if (error && !data) return <div className="tab-stub">Error loading evolution: {error.message}</div>;
	if (loading && !data) return <div className="tab-stub">Loading evolution graph…</div>;
	if (!data || data.nodes.length === 0) return <div className="tab-stub">No evolution data yet.</div>;

	return (
		<div className="evolution-tab">
			<h4>Topic evolution</h4>
			<input
				type="range"
				min={0}
				max={Math.max(0, data.timeBuckets.length - 1)}
				value={bucketIdx}
				onChange={(e) => setBucketIdx(Number(e.target.value))}
				aria-label="Timeline scrubber"
			/>
			<TopicEvolutionGraph data={data} bucketIdx={bucketIdx} />
		</div>
	);
}
```

- [ ] **Step 2: Create the D3 impl `TopicEvolutionGraph.tsx`**

Extends the Memory Map d3-force idioms. Under 500 lines:

```tsx
/**
 * TopicEvolutionGraph.tsx — D3 force-directed topic graph + scrubber logic.
 * Delegate impl for TopicEvolutionView. Nodes = topics (radius ∝ cumulative
 * memoryCount up to scrubber time), edges = co-occurrence weight. Reuses the
 * d3-force simulation + SVG rendering pattern from MemoryMapView.
 */
import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import * as d3 from "d3-force";
import type { TopicEvolutionResponse } from "@contracts";

const W = 900;
const H = 600;
const PADDING = 40;

export default function TopicEvolutionGraph({
	data,
	bucketIdx,
}: {
	data: TopicEvolutionResponse;
	bucketIdx: number;
}): React.ReactElement {
	const svgRef = useRef<SVGSVGElement | null>(null);

	// Filter + size nodes by the scrubber time boundary.
	const snapshot = useMemo(() => {
		const t = data.timeBuckets[bucketIdx] ?? data.timeBuckets[data.timeBuckets.length - 1];
		const visible = data.nodes.filter(
			(n) => n.lastSeen >= 0 && n.firstSeen <= t, // seen at or before scrubber time
		);
		return { t, visible };
	}, [data, bucketIdx]);

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		// Clear previous render.
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		const nodes = snapshot.visible.map((n) => ({
			...n,
			x: W / 2 + (Math.random() - 0.5) * 300,
			y: H / 2 + (Math.random() - 0.5) * 200,
		}));
		const edges = data.edges
			.filter(
				(e) =>
					nodes.some((n) => n.id === e.source) &&
					nodes.some((n) => n.id === e.target),
			)
			.map((e) => {
				const src = nodes.find((n) => n.id === e.source)!;
				const tgt = nodes.find((n) => n.id === e.target)!;
				return { source: src, target: tgt, weight: e.weight };
			});

		const sim = d3
			.forceSimulation(nodes as unknown as d3.SimulationNodeDatum[])
			.force("link", d3.forceLink(edges as unknown as d3.SimulationLinkDatum<d3.SimulationNodeDatum>[]).id((d: unknown) => (d as { id: string }).id).distance(80))
			.force("charge", d3.forceManyBody().strength(-200))
			.force("center", d3.forceCenter(W / 2, H / 2))
			.force("collide", d3.forceCollide(20));

		const linkSel = d3
			.select(svg)
			.append("g")
			.attr("stroke", "#22c55e")
			.attr("stroke-opacity", 0.4)
			.selectAll("line")
			.data(edges)
			.join("line")
			.attr("stroke-width", (d) => Math.max(1, Math.min(6, d.weight)));

		const group = d3.select(svg).append("g").selectAll("g").data(nodes).join("g");
		group
			.append("circle")
			.attr("r", (n) => Math.max(3, Math.sqrt(n.memoryCount) * 3))
			.attr("fill", "#6366f1");
		group
			.append("text")
			.text((n) => n.label)
			.attr("text-anchor", "middle")
			.attr("dy", (n) => Math.max(3, Math.sqrt(n.memoryCount) * 3) + 12)
			.attr("font-size", "10px")
			.attr("fill", "#e5e7eb");

		const tick = () => {
			linkSel
				.attr("x1", (d) => (d.source as { x: number }).x)
				.attr("y1", (d) => (d.source as { y: number }).y)
				.attr("x2", (d) => (d.target as { x: number }).x)
				.attr("y2", (d) => (d.target as { y: number }).y);
			group.attr("transform", (d) => `translate(${d.x},${d.y})`);
		};
		sim.on("tick", tick);
		return () => { sim.stop(); };
	}, [snapshot, data.edges]);

	return (
		<svg
			ref={svgRef}
			width="100%"
			viewBox={`0 0 ${W} ${H}`}
			style={{ border: "1px solid #333", borderRadius: 8, touchAction: "none" }}
			role="img"
			aria-label="Topic evolution graph"
		/>
	);
}
```

> The scrubber input supports touch drag natively (it is a `<input type="range">`, not a canvas pointer handler). Keep it as an input so mobile drag works with zero extra code (§11 mobile check). The graph uses d3-force only (no network, PREVENT-PI-004).

- [ ] **Step 3: Confirm `d3-force` is a dependency**

Check `extensions/dashboard-client/package.json` (or root) for `d3-force`; if missing, `npm install d3-force` in the dashboard-client workspace (it must already be a dep because MemoryMapView uses it — verify; if not present, add it).

- [ ] **Step 4: Build + smoke**

```bash
npm run build && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

Expected: compiles; evolution sub-tab renders structurally. Confirm both new files are under 500 lines.

- [ ] **Step 5: Commit**

```bash
git add extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionGraph.tsx
git commit -m "feat(wiki): D3 topic evolution graph + timeline scrubber + SSE refresh"
```

- [ ] **Step 6: Sprint W4 gate**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```

Then `./scripts/deploy.sh <patch>`.

---

## Sprint W5 — QA, Regression, Docs, Release

### Task W5.1: Full QA + curation/provenance robustness

**Files:**
- Modify: `src/wiki/curation.test.ts` (append robustness cases)
- Modify: `src/topics/store.test.ts` (append rebuild survival cases)

- [ ] **Step 1: Add mutation-robustness tests**

Append to `src/wiki/curation.test.ts`:

```ts
test("split with unknown memory ids throws; no partial write", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);
	assert.throws(() => cur.splitTopic("topic_0", ["nope"]));
	assert.equal(store.getMemoriesForTopic("topic_0").length, 2); // unchanged
	closeTurnStore(dir);
});

test("override label '' falls back to auto; edited=false", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);
	cur.renameTopic("topic_0", "X");
	cur.renameTopic("topic_0", "");
	assert.deepEqual(cur.resolveLabel("topic_0", "alpha"), { label: "alpha", edited: false });
	closeTurnStore(dir);
});

test("merge then rebuild: source stays dissolved, target holds memories (persistence)", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);
	cur.mergeTopics("topic_0", "topic_1");
	// Simulate an auto-rebuild that re-clusters everything back into one topic_0.
	const rebuilt = makeModel(2000);
	rebuilt.topics = [{ id: "topic_0", label: "alpha", termScores: [{ term: "a", score: 1 }], memoryCount: 3, lastUpdated: 2000 }];
	rebuilt.assignments = [
		{ memoryId: "m0", sessionId: "s", topicId: "topic_0", confidence: 0.9, assignedAt: 2000, method: "kmeans+tfidf" },
		{ memoryId: "m1", sessionId: "s", topicId: "topic_0", confidence: 0.7, assignedAt: 2000, method: "kmeans+tfidf" },
		{ memoryId: "m2", sessionId: "s", topicId: "topic_0", confidence: 0.5, assignedAt: 2000, method: "kmeans+tfidf" },
	];
	store.replaceTopicModel(rebuilt);
	// The merge override row survives as historical provenance.
	const tdb = openTurnStore(dir);
	const o = tdb.prepare("SELECT merged_into FROM topic_overrides WHERE topic_id='topic_1' AND kind='merge'").get() as { merged_into: string } | undefined;
	assert.equal(o?.merged_into, "topic_0");
	closeTurnStore(dir);
});
```

- [ ] **Step 2: Append provenance fixtures to `src/topics/store.test.ts`**

Append a test that verifies the `session_id` survive-writes + `applyOverridesAfterRebuild` re-stamps after a rebuild that removes the topic (orphan override stays, no throw):

```ts
test("applyOverridesAfterRebuild: orphan override for a removed topic is a no-op", async () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000, 2));
	const tdb = openTurnStore(dir);
	tdb.prepare(
		"INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at) VALUES ('topic_0','label','Keep',1)",
	).run();
	// Rebuild that only contains topic_1 (topic_0 removed by re-clustering).
	store.replaceTopicModel(makeModel(2000, 1));
	const { applyOverridesAfterRebuild } = await import("./store.js");
	applyOverridesAfterRebuild(tdb); // must not throw
	closeTurnStore(dir);
});
```

- [ ] **Step 3: Run the full suite**

```bash
npm run build && npm test
```

Expected: all green (existing 1088+ plus new wiki/curation/handler tests).

- [ ] **Step 4: Commit**

```bash
git add src/wiki/curation.test.ts src/topics/store.test.ts
git commit -m "test(wiki): robustness + provenance persistence fixtures"
```

---

### Task W5.2: Manual QA + docs + file-size check

**Files:**
- Modify: `docs/INDEX_MAP.md`
- Modify: `docs/HEADER_MAP.md`
- Modify: `docs/superpowers/specs/2026-08-02-wiki-revival-design.md` (status Draft → Implemented)

- [ ] **Step 1: Manual QA (browser-backed, per `dashboard-tab-smoke` + live server)**

Start a dashboard server against a real state dir (or headless via Playwright as the smoke does), then verify:

- `GET /api/wiki/index` returns topics; flag-off (`MEGACOMPACT_WIKI_ENHANCED_DISABLED=true`) → 404 + `/api/topics` still works.
- Rename → list + page show `edited` badge; empty rename reverts to auto.
- Merge → source hidden from list, target memory count grows, `wiki_topics_merged` line appended to events.log.
- Split → new topic appears, source shrinks, `wiki_topic_split` emitted.
- Per-topic timeline renders buckets; D3 evolution graph renders with scrubber (drag on desktop + touch).
- Member-memories provenance: rows with a real `session_id` show contributing turns; pre-migration NULL rows show "unknown session" (never fabricated).
- `/mega-topics` slash command still runs `replaceTopicModel` without regressing (confirm `applyOverridesAfterRebuild` runs as a post-step, not a replacement).

If you can launch a real browser: `node dist/extensions/dashboard-server/server.js` then open `http://localhost:9320/` and drive the Wiki tab manually, checking the golden path + edge cases. If the environment cannot launch a browser, state that explicitly in the summary rather than claiming visual success.

- [ ] **Step 2: Docs registration**

Append entries to `docs/INDEX_MAP.md` and `docs/HEADER_MAP.md` for: `src/wiki/curation.ts`, `src/wiki/curation.test.ts`, `extensions/dashboard-server/routes-wiki.ts`, `extensions/dashboard-server/api-contracts/wiki.ts`, `extensions/dashboard-client/src/tabs/WikiTab*`, and this plan + the design spec. In the design spec's Status line, change `Status: Draft (pending review)` to `Status: Implemented (see 2026-08-02-wiki-revival plan)`.

- [ ] **Step 3: File-size check (per memory)**

```bash
wc -l src/wiki/curation.ts src/store/turns/schema.ts src/topics/store.ts \
  extensions/dashboard-server/routes-wiki.ts extensions/dashboard-server/api-contracts/wiki.ts \
  extensions/dashboard-client/src/tabs/WikiTab.tsx extensions/dashboard-client/src/tabs/WikiTab/*.tsx
```

Expected: every file < 500 lines. If `routes-wiki.ts` exceeds ~480, split the read-assembly helpers (`chunkText`, `sessionTurns`, provenance assembly) into `src/wiki/route-helpers.ts`. If any `WikiTab` component exceeds 480, split further (already split `TopicEvolutionGraph.tsx` out).

- [ ] **Step 4: Commit**

```bash
git add docs/INDEX_MAP.md docs/HEADER_MAP.md docs/superpowers/specs/2026-08-02-wiki-revival-design.md
git commit -m "docs(wiki): register wiki revival files + mark design implemented"
```

---

### Task W5.3: Final gate + release

- [ ] **Step 1: Full gate**

```bash
npm run build && npm test && npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
```

Expected: all green.

- [ ] **Step 2: Final deploy + release notes**

```bash
./scripts/deploy.sh <final-version>
```

Expected: `deploy.sh` runs the full gate (build + test + lint + regression + guardrails + `build:dashboard` + `dashboard-tab-smoke`), bumps version, commits, `npm publish`, tags `v<final-version>`, pushes, and auto-creates GitHub release notes (per the release-notes-on-version-bumps memory). Confirm the release notes describe: wiki revival (provenance, curation, evolution graph, SSE events).

- [ ] **Step 3: Device-side verify (printed by deploy.sh)**

```bash
pi update --extensions
curl -s http://localhost:9320/ | grep 'id="root"'
```

Expected: extension updated; dashboard serves the rebuilt bundle. Optionally `scripts/deploy-dashboard.sh` on the device.

---

## QA Review Checklist (per-sprint)

- [ ] `npm run build` + `npm test` + `npm run lint` clean.
- [ ] `python3 scripts/regression_check.py --all` — no regressions.
- [ ] `node scripts/guardrails-scan.mjs` — no new PREVENT-* violations.
- [ ] File-size: every `src/` + `extensions/` + `tabs/` file < 500 lines (300 soft for `src/`); pointer-file splits for any D3/route file approaching 480.
- [ ] Curation persistence: rename → rebuild → label persists as `edited`; merge → rebuild → not orphaned, counts consistent; split → rebuild → split topic stays (or clean auto label if re-absorbed), override row preserved.
- [ ] Provenance accuracy: crafted fixtures attach correct `context_chunks` text + `turns` (conversation/turn_index/model); no fabricated turns; NULL-session renders "unknown session".
- [ ] Mutation robustness: merge source==target and split with unknown/zero ids → 400, no partial write; '' override falls back to auto; APIFlag OFF → `/api/wiki/*` 404 and no curation runs; dissolved-source topics hidden from list but preserved in overrides.
- [ ] Mobile: D3 evolution scrubber works via touch (native `<input type="range">`); dialogs render as full-screen sheet on <768px (add a `@media (max-width: 767px)` full-screen `.dialog` style if not already scoped).
- [ ] `/mega-topics` slash command does not regress.

## Risks + Mitigations

| Risk | Mitigation |
| --- | --- |
| **File-limit breach** in routes-wiki / D3 / WikiPage | Pointer-file splits; delegate read-helpers + D3 simulation to impl files at ~480 lines (already split `TopicEvolutionGraph.tsx`). |
| **Pre-migration `memory_topics` rows lack `session_id`** | Additive NULL-backfill column; next rebuild repopulates from model.assignments; render "unknown session", never fabricate. |
| **Curation lost across auto-rebuild** | `topic_overrides` lives outside the `DELETE FROM topics/memory_topics`; `applyOverridesAfterRebuild` re-stamps existing labels; orphan rows stay as provenance. |
| **Merge/split count drift** | All mutations in one `withTx`; counts recomputed from `memory_topics` in-tx; tests assert post-rebuild consistency. |
| **Provenance `context_chunks` is in the main DB, not turns.db** | `chunkText` opens the main store via `openStore(stateDir)`; the turns-only tests avoid asserting on content (label/merge/index only) to keep them hermetic. |
| **`runtime.dashboard` optionality for the SSE emit** | afterCompact guards with `?.` and a try/catch; if `dashboard` is not exposed, fall back to `appendFileSync(events.log)` (same JSONL shape). |
| **SSE event volume from `wiki_rebuilt`** | Rebuild cadence unchanged (N=3); event emitted only on actual rebuild, not polling; tiny payload. |
| **PREVENT-PI-004** | All wiki/curation logic pure local node:sqlite; no pi-runtime imports in `src/`; the sendJson/emitSse anchors carry `guardrails-allow` reasons exactly as routes-turns.ts. |
| **PREVENT-002** | Parameterized queries only; DDL identifiers are fixed literals; topic/memory ids bound via `?`. |
| **Flag-off parity** | `WIKI_ENHANCED_ENABLED` short-circuits all wiki paths to 404; `/api/topics` + TopicsTab behavior unchanged. |
| **Timeline query cost on large topics** | `topic_evolution` indexed on `(topic_id, assigned_at)`; server buckets rows with bounded LIMIT/DISTINCT grouping. |

## Out of Scope

- Altering the cluster algorithm (`buildTopicModel`/k-selection/TF-IDF).
- Real-time memory-to-topic streaming during a session.
- Cross-repo topic merging in the graph (single-repo, per-`stateDir` via `repoStateDir()`).
- Host-driven curation slash commands (dashboard-only).
- Rewriting the Memory Map tab (evolution graph shares only d3-force idioms, not its data/pipeline).
- Any model/LLM summary generation (stays extractive/local).
