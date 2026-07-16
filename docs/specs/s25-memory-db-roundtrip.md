# Sprint 25 — Durable-Memory DB Round-Trip (S25)

## Header
- **Sprint ID:** S25
- **Title:** Durable-memory write→persist→recall→inline round-trip: E2E proof + bloat/hallucination guards
- **Status:** PLANNED
- **Owner:** (unassigned)
- **Depends on:** S20 (auto-review), S21 (recall), S24 (cross-repo mirror + storage hardening)
- **Files touched (planned):**
  - `extensions/mega-memory-roundtrip.test.ts` (NEW — headless E2E driver)
  - `src/memory.test.ts` (NEW — hallucination guard + consolidate unit coverage)
  - `src/memoryRoundtrip.test.ts` (NEW — full src-level write→recall→inline)
  - `TESTER_GUIDE.md` (EXTEND — §10 additions)
  - `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md` (map updates)
  - (No `src/` behavior change unless a bug is confirmed; see §Risk.)

## Safety (AGENT_GUARDRAILS — Four Laws)
- **Read First:** all modules under review already read (`memory.ts`, `memoryOps.ts`,
  `memoryRecall.ts`, `recall.ts`, `store/sqlite.ts`, `mega-events.ts`, `mega-pipeline.ts`).
- **Stay in Scope:** this sprint is **test + doc only** by default. Any `src/` edit
  requires a confirmed bug (see Problem P4/P6) and its own risk gate.
- **Verify Before Commit:** `npm run build && npm test` (all tests green) +
  `npm run lint` + `python3 scripts/regression_check.py --all` +
  `node scripts/guardrails-scan.mjs`.
- **Halt When Uncertain:** if a new test surfaces a `src/` bug, STOP, file it, do not
  silently patch behavior inside a test-only sprint.
- **PREVENT-PI-004:** every path here is local (node:sqlite + local embedder + WASM
  PGlite). No new network calls. The cross-repo index stays best-effort/non-fatal.

## Problem
The durable-memory subsystem (memories table + auto-review + recall + inline) is
individually unit-tested but **the end-to-end chain is unproven**, and three
correctness properties have no assertion:

- **P1 — No full round-trip.** No test drives `reviewConversation → applyMemoryOps
  → recallMemories → formatMemoryRecallBlock` as one flow. Each hop is tested in
  isolation; a break at a seam (e.g. category not persisted, content truncated,
  score below floor) would pass every current test.
- **P2 — No resume-inline E2E.** `pendingMemoryRecallBlock`
  (`mega-events.ts:46/77/102/116/119`) is set on `session_start`/`session_tree`
  and consumed in `before_agent_start` (`:113-122`), but no headless test seeds a
  memory, fires `session_start`, then asserts the "Recalled memory" block lands in
  the returned `systemPrompt`. The checkpoint path IS tested
  (`mega-compact.test.ts:346-361`); the memory path is not.
- **P3 — No bloat assertion.** Storage bounds (`MEMORY_MAX_ROWS=500` /
  `MEMORY_MAX_CHARS=4000`, `sqlite.ts:723-780`) are tested via direct `addMemory`
  with a forced env cap of 10, but there is no proof that the **review→persist**
  path (many turns of auto-review) leaves the store bounded at the production
  default.
- **P4 — Hallucination guard unproven.** `reviewConversation`
  (`memory.ts:70-74`) drops any add/replace whose content is not a verbatim
  substring of a real message. No test proves a fabricated/ungrounded op is
  dropped, and the REMOVE-op exemption (`:71`) + weak `sharesTopic` match
  (`:77-82`, ≥1 shared token >3 chars) can over-remove. Also: stored content is
  the **160-char-truncated** request (`collectRecentUserRequests` in
  `compact.ts`), so a long decision is silently clipped — undocumented.
- **P5 — `consolidateMemories` untested.** `memory.ts:123-164` (cosine merge of
  near-dup rows) has zero coverage; the survivor-id / merge-phrase / loser-removal
  logic is unverified.
- **P6 — Cross-repo floor inconsistency.** The effective cross-repo cosine floor
  disagrees across layers: `recallMemoriesCrossRepo` defaults to **0.3**
  (`memoryRecall.ts:104`), `recallMemoriesAndInline` passes **0.3**
  (`recall.ts:206`), but the extension config default is **0.90**
  (`mega-config.ts:140`) and TESTER_GUIDE §9 documents 0.90. No test pins the
  wired-through value; docs and code diverge.

## Scope
### In scope
1. Headless E2E driver (`extensions/mega-memory-roundtrip.test.ts`) that loads the
   **compiled** extension via a mock pi and proves: auto-review on `turn_end`
   writes a memory; `session_start` stages it; `before_agent_start` inlines it.
2. src-level full round-trip test (`src/memoryRoundtrip.test.ts`): review → apply →
   recall → format, asserting content, category, and block text survive every hop.
3. Bloat assertion: N-turn auto-review loop stays ≤ `MEMORY_MAX_ROWS`, each row ≤
   `MEMORY_MAX_CHARS`.
4. Hallucination-guard unit test (`src/memory.test.ts`): fabricated op dropped;
   grounded op kept; REMOVE over-match documented + asserted as current behavior.
5. `consolidateMemories` unit test.
6. Cross-repo floor: one test pinning the value that flows from config → helper;
   reconcile code vs TESTER_GUIDE §9 (doc fix or a one-line default alignment —
   decided in Execution step E7, behind the Risk gate).
7. TESTER_GUIDE §10 additions (manual real-pi checklist for round-trip + bloat).

### Out of scope
- Changing the auto-review heuristic (DECISION/DROP patterns).
- Replacing the linear-scan recall with an index for same-repo memory.
- Any embedder change (TrigramEmbedder stays default).
- MiniLM (still not shipped).

## Execution

### Overview of the headless E2E driver (how it loads the compiled extension)
The existing harness in `extensions/mega-compact.test.ts` is the template. Key
mechanics to reuse verbatim:
- **jiti / compiled load:** tests run against `dist/**/*.test.js` (`npm test` does
  `tsc` then `node --test`). The driver imports the **compiled** extension entry
  through `createRequire(import.meta.url)` and the same relative path the existing
  harness uses; it does NOT re-implement handlers. (`jiti` is only needed if a
  test must load `.ts` directly — the standard path is the tsc→dist build, matching
  `mega-compact.test.ts:19-23`.)
- **State isolation:** set `process.env.MEGACOMPACT_STATE_DIR` to a fresh
  `mkdtempSync` dir per test and `process.env.MEGACOMPACT_INDEX_DIR` to an isolated
  index dir (mirror `mega-compact.test.ts:24-27`) so concurrent `node --test`
  workers never collide and never touch `~/.mega-compact-index`.
- **Handler capture:** the mock `pi` records `pi.on(name, fn)` into a
  `handlers: Record<string, Function>` map and `pi.command(...)` into `commands`;
  `h.fire(name, event, ctx)` awaits `handlers[name](event, ctx)`. Copy the
  `harness()` factory (`mega-compact.test.ts:31-80+`), including the `msg()` /
  `toEntry()` shapes so `ctx.sessionManager.getEntries()` returns
  `{type:"message", message}` entries (required or `recentUserQuery`/the review
  view silently reads `""`).
- **Force auto-review to fire deterministically:** set
  `MEGACOMPACT_MEMORY_REVIEW_INTERVAL=1` and drive `turn_start`→`turn_end` with
  `runtime.currentTurn` advanced so `currentTurn % cadence === 0`
  (`mega-events.ts:224-234`). Set `MEGACOMPACT_MEMORY_AUTO_REVIEW=true` (default).
  Keep pressure low so cadence == interval (`config.ts:92`).

### E1 — E2E: auto-review writes a memory on turn_end
Steps in `extensions/mega-memory-roundtrip.test.ts`:
1. `harness()` with `MEMORY_REVIEW_INTERVAL=1`.
2. Build a session whose last user message contains a grounded decision phrase
   matching `DECISION_PATTERNS` (`memory.ts:19-23`), e.g. user text
   `"we decided to use node:sqlite for the durable store"`. This string is < 160
   chars so it survives `collectRecentUserRequests` truncation verbatim (guard-safe).
3. `await h.fire("turn_start", {type:"turn_start", turnIndex:1}, ctx)` then
   `await h.fire("turn_end", {type:"turn_end", turnIndex:1}, ctx)`.
4. Assert via `listMemories(null, 50, h.stateDir)` (import from
   `../src/store/sqlite.js`) that a row with `/node:sqlite/` content and
   `category === "decision"` exists.

### E2 — E2E: resume stages + before_agent_start inlines the memory
Continue in the same test file (fresh harness or continue E1's dir):
1. Seed a memory directly via `applyMemoryOps([{op:"add", memory:{content:"we use
   node:sqlite for the durable store", category:"decision", sourceTurn:0}}],
   h.stateDir)` OR reuse E1's written row.
2. Also seed one checkpoint (fire a `context` event at 100% like
   `mega-compact.test.ts:352`) so `session_start`'s `checkpointCount > 0` gate
   (`mega-events.ts:57`) is satisfied — memory recall in `session_start` runs
   inside the `if (config.autoInline)` block and needs a usable `query` from
   `recentUserQuery(ctx)` (`:59/72`), so ensure the session's last user message is
   topically related to the seeded memory.
3. `ctx = h.ctx()`; `await h.fire("session_start", {type:"session_start",
   reason:"resume"}, ctx)`.
4. `const res = await h.fire("before_agent_start", {type:"before_agent_start",
   systemPrompt:"base system", prompt:"base system", systemPromptOptions:{}}, ctx)`.
5. Assert `res.systemPrompt.includes("Recalled memory")` (the memory block header
   from `formatMemoryRecallBlock`, `recall.ts:176-182`) AND
   `res.systemPrompt.includes("node:sqlite")`. This is the **first test that
   exercises `pendingMemoryRecallBlock` through the handler chain**.
6. Negative: fire a second `before_agent_start` on the same ctx; assert it returns
   nothing / no memory block (block cleared at `mega-events.ts:119`).

### E3 — src-level full round-trip
`src/memoryRoundtrip.test.ts`:
1. Build an `EngineMessage[]` with a grounded decision.
2. `ops = reviewConversation(view, [])`; assert one `add` op.
3. `await applyMemoryOps(ops, dir)`.
4. `hits = await recallMemories(query, dir, {embedder: biGramEmbedder, topK:5,
   minSimilarity:0})` (reuse the test embedder from `memoryRecall.test.ts:11-27`).
5. `block = formatMemoryRecallBlock(hits.map(h => ({content:h.memory.content,
   category:h.memory.category, score:h.score})))`.
6. Assert the original decision text + `[decision]` label appear in `block`.

### E4 — bloat assertion (no unbounded growth via the review path)
In `src/memoryRoundtrip.test.ts`:
1. `MEGACOMPACT_MEMORY_MAX_ROWS=20` (env), fresh dir.
2. Loop 50 iterations: each builds a distinct grounded decision message, runs
   `reviewConversation` + `applyMemoryOps`.
3. Assert `listMemories(null, 1000, dir).length <= 20`.
4. Assert every returned row `content.length <= memoryMaxChars() + "…[truncated]".length`.
5. Cleanup: `delete process.env.MEGACOMPACT_MEMORY_MAX_ROWS`.

### E5 — hallucination guard
`src/memory.test.ts`:
1. **Fabricated dropped:** call `reviewConversation` with a `messages` array whose
   user texts do NOT contain a decision, but pass an `existing` array crafted so a
   REPLACE could be tempted; assert no add/replace op whose content is absent from
   any message survives (proves the `:70-74` filter).
2. **Grounded kept:** a message containing a decision phrase → op survives.
3. **Truncation documented:** a user message > 160 chars containing a decision;
   assert the stored op content is the truncated form AND still a substring of the
   full message (guard passes). Add an inline comment pinning this as intended.
4. **REMOVE over-match (current behavior):** existing memory
   `"we use redis for cache"`, user message `"stop using redis"` → REMOVE emitted
   via `sharesTopic` single-token overlap. Assert current behavior; add a `// KNOWN:
   weak topic match` comment so a future tightening has a regression anchor.

### E6 — consolidateMemories
`src/memory.test.ts`:
1. Seed two near-identical `decision` rows + one unrelated `note` row in a dir.
2. `const n = await consolidateMemories(dir, null, 0.5)` (low threshold so the
   test embedder merges the pair; note default is `DedupConfig.CONSOLIDATE_COSINE`).
3. Assert `n === 1`, the survivor is the larger id, the loser row is gone
   (`listMemories`), and the `note` row is untouched (different category,
   `memory.ts:141`).

### E7 — cross-repo floor reconciliation (Risk-gated)
1. Add a test asserting the value that flows config→helper for the memory
   cross-repo path. `recallMemoriesAndInline` passes `crossRepoCosine ?? 0.3`
   (`recall.ts:206`) but `mega-events.ts:75/101` passes `config.crossRepoCosine`
   (0.90). Pin the wired value in a test that constructs the opts the extension
   builds.
2. **Decision:** if code is correct, fix TESTER_GUIDE §9 / doc wording to state
   the memory-recall floor is `MEGACOMPACT_CROSSREPO_COSINE` (0.90) when driven by
   the extension, 0.3 only as the bare-helper default. If a single default should
   win, align `memoryRecall.ts:104` — **but only under the Risk Gate** (exported
   behavior change): run `ctx_impact`/callgraph, get sign-off. Default action:
   **doc fix, no code change.**

### E8 — verify
- `npm run build && npm test` — all green (expect count to rise from 346 by the
  number of new tests; update the "**N tests**" figures in TESTER_GUIDE §Test
  Environment + §Running the Test Suite).
- `npm run lint`, `npm run guardrails`, `node scripts/guardrails-scan.mjs`.

## Acceptance
- [ ] E2E driver proves `turn_end → memory write` (E1).
- [ ] E2E driver proves `session_start → before_agent_start` inlines the memory
      block into `systemPrompt` (E2) — `pendingMemoryRecallBlock` exercised.
- [ ] src-level full round-trip green (E3).
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`, rows ≤
      `MEMORY_MAX_CHARS` (E4).
- [ ] Hallucination guard: fabricated op dropped, grounded kept, truncation
      documented, REMOVE over-match anchored (E5).
- [ ] `consolidateMemories` covered (E6).
- [ ] Cross-repo floor: wired value pinned; docs and code agree (E7).
- [ ] All suites green; test-count figures in TESTER_GUIDE updated.
- [ ] No new network call; guardrails-scan clean (PREVENT-PI-004).

## Rollback
- Test-only sprint: revert the new `*.test.ts` files and the TESTER_GUIDE/map
  edits. No runtime behavior changes ship by default. If E7 elected a one-line
  default alignment in `memoryRecall.ts`, revert that single line to restore the
  0.3 helper default; recall degrades gracefully either way (non-fatal).

## Manual real-pi checklist (validate on a real install, not a tarball)
Per PREVENT-DIST-001: bump `version` → `npm publish` → `pi update --extensions`.
1. Start pi. Say a grounded decision: *"we decided to use node:sqlite for the
   durable store"*. Continue for `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` (default 10)
   turns (or export `MEGACOMPACT_MEMORY_REVIEW_INTERVAL=1` to speed it up).
2. `/mega-memory list` (or `/m list`) — confirm a `decision` row with that text.
3. End the session; `pi --continue`. Ask a related question. Confirm the memory is
   available without manual recall, and `events.log` / `/mega-status` reflects an
   inlined memory block. (`session_start` emits reason `startup` on `--continue` —
   the memory recall runs whenever there is a usable query.)
4. Inspect the DB directly:
   ```bash
   sqlite3 <repo>/.pi/mega-compact/sqlite.db \
     "SELECT id, category, substr(content,1,60), source_turn FROM memories ORDER BY id DESC LIMIT 5;"
   ```
5. **Bloat check:** export `MEGACOMPACT_MEMORY_MAX_ROWS=20`, run many decision
   turns, confirm `SELECT COUNT(*) FROM memories;` stays ≤ 20 and no write errors.
6. **Truncation check:** `MEGACOMPACT_MEMORY_MAX_CHARS=50 /m save note "<200-char
   string>"`; `/m search "<first 40 chars>"` → row ends with `…[truncated]`.
7. **Consolidate:** `/m save decision "we use node:sqlite"` twice with slight
   wording drift; `/m consolidate`; confirm the count drops by the merges.

## Exact TESTER_GUIDE.md additions
Under **§10 Durable memory (auto-review → RAG)**, append these steps + criteria
(after the existing S24 block, before "Pass criteria"):

> **S25 — round-trip + bloat proof:**
>
> 7. **Write→recall→inline round-trip.** Say a grounded decision, let a review
>    fire (interval turns, or `MEGACOMPACT_MEMORY_REVIEW_INTERVAL=1`), end the
>    session, `pi --continue`, ask a related question. The decision must be present
>    as an auto-inlined **"Recalled memory"** block (no manual `/mega-recall`).
> 8. **Content is grounded + clipped.** Memories are stored only when their text
>    appears verbatim in a real message (hallucination guard). Long requests are
>    clipped to ~160 chars before storage (a `decision` longer than that is
>    truncated). Verify by saving a long decision and reading it back with
>    `/m list`.
> 9. **Store stays bounded under sustained review.** With
>    `MEGACOMPACT_MEMORY_MAX_ROWS=20`, run 50+ decision turns; confirm
>    `SELECT COUNT(*) FROM memories;` never exceeds 20 and every write succeeds
>    (LRU eviction of least-recently-referenced rows; referenced rows survive).

Extend the **Pass criteria** list in §10 with:
> - Write→recall→inline completes end-to-end on `pi --continue`.
> - Stored memory content is grounded (verbatim substring) and clipped at ~160 chars.
> - Under a forced low `MEMORY_MAX_ROWS`, the store stays bounded with zero write failures.

Fix §9 cross-repo wording (E7 outcome): change "stricter cosine floor
(`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90)" to explicitly note the **memory**
cross-repo floor is the same config value when driven by the extension (0.90),
while the bare `recallMemoriesCrossRepo` helper defaults to 0.3.

Update the two test-count figures ("**346** tests", "runs **346 tests**") in
§Test Environment Setup and §Running the Test Suite to the new total after S25.

Add to §Running the Test Suite → Handler-level tests:
> - **`extensions/mega-memory-roundtrip.test.ts`** — drives the compiled extension:
>   `turn_end` auto-review writes a memory; `session_start` stages it; the next
>   `before_agent_start` inlines the "Recalled memory" block into the system prompt.

Add to §Running the Test Suite → Unit tests (under the existing
`src/memory.ts / memoryOps.ts / memoryRecall.ts` bullet):
> - **`src/memoryRoundtrip.test.ts` / `src/memory.test.ts`** — full write→persist→
>   recall→inline round-trip, review-path bloat bound, hallucination-guard drop,
>   and `consolidateMemories` near-dup merge.
