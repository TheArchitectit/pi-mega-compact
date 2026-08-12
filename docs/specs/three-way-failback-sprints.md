# Three-Way Failback — Sprint Program (3WF-1 … 3WF-5)

**Date:** 2026-08-12
**Status:** PROGRAM — sprints defined, approved, not yet implemented
**Base:** master v0.20.83 (branch `feat/three-way-failback`); `pma-remerge-review` parked, unmerged
**Design contract:** `docs/superpowers/specs/2026-08-12-three-way-failback-design.md` **v2 QA amendments (§12) are binding** — they override the original §4–§9 where they conflict. Sprints implement the v2-binding text, not the original sections.
**QA lineage:** three adversarial review passes over the recall / compaction / replay seams (2026-08-12); findings A1–A3 below are verified against code with `file:line` evidence.

## 0. What this program fixes

| Incident fact (production, 2026-08-12) | Root mechanism | Sprint that kills it |
|---|---|---|
| Agent got irrelevant context for 2 replays; recall emitted **zero** telemetry | `session_start` never fired; the only recall staging point (`session-handlers.ts:50-91`) never ran; nothing downstream noticed. `checkpointCount > 0` gate (:53) makes a thin store equally silent. | **3WF-1** (TriggerGuard runs recall at the `context` event if nothing staged) |
| Compaction fired **496×** on `chkpt_001`, freeing **0.0%** | Every `context` event past firePoint re-fires (`gateCheck.ts:74-100`), debounce only 2s, re-fire at `recompactPctDelta`; `saved` counts **stored-checkpoint** tokens (`mega-pipeline/compact.ts:117-119`) so 555/576 deduped fires all looked like wins while the live window never shrank. | **3WF-2** (ReductionValidator measures live-window delta + meta-persisted ThrashGuard refusal) |
| Recall had no relevance floor; duplicates re-injected | `vectorSearch` returns top-k unconditionally — no same-repo floor exists anywhere. | **3WF-3** (read-only 3-source vote + RecallValidator with new floor) |
| Staged block could be silently dropped before reaching the agent | Tail mode injects via `context-handler/tailResult.ts`; nothing asserted the block was present in the message list pi sends to the provider. No prompt readback API exists. | **3WF-4** (InjectionConfirm on `ContextEvent.messages` + floor fallback) |
| `MEGACOMPACT_RECALL_TAIL_INJECT` has no dashboard toggle (violates the all-flags-toggleable rule) | Only in `gather-debug-keys.ts`, not in SETTINGS. | **3WF-5** |

## 1. Hard conventions (apply to every sprint)

- **Flag-gated:** everything behind `MEGACOMPACT_THREE_WAY_FAILBACK` (envBool, default ON). **Flag OFF = byte-identical** to v0.20.83 behavior. Every gate assertion includes a flag-OFF identity check.
- **Contract-first:** all new types ship in `src/failback/types.ts` before any implementation (interfaces: `RecallCandidate`, `VoteResult`, `CompactCandidate`, `ReductionVerdict`, `GuardState`, `FloorBlock`, `SummarySource`).
- **No mocks, no stubs:** tests use real `node:sqlite` stores in `fs.mkdtemp` stateDirs end to end (project rule O1). Invented constants must be calibrated/configurable.
- **Non-fatal everywhere:** every new code path is best-effort; a failure degrades to the next ladder rung or the pre-sprint path — never breaks the agent loop.
- **File limits:** `src/` 300 soft / extensions 400 soft; `extensions/mega-pipeline/compact.ts` (388L) and `mega-pipeline/recall.ts` (310L) split into delegate-shell + impl dirs as part of these sprints.
- **Ledger:** stores never call back into the host; all state reads via readers, writes via writers.
- **Structured logging:** JSON lines with `ts` + `event`; no `console.log` in `src/`.
- **PREVENT-PI-004:** all default paths fully local. Ollama/HyDE opt-ins remain annotated loopback exceptions and are never required by any rung.
- **Gate (every sprint boundary, in order):** `npm run build` → `npm test` (node --test on dist) → `npm run lint` → `python3 scripts/regression_check.py --all` → for the publishing commit, `python3 scripts/regression_check.py --soft-as-hard --pre-commit` (vs prior release tag) → `node scripts/guardrails-scan.mjs`.
- **Publish (every sprint):** `./scripts/deploy.sh <patch>` from a clean tree — patch bumps 0.20.84, 0.20.85, … in order. Program completion (3WF-5) bumps **0.21.0**.
- **Commits:** one focused commit per sprint; `Co-Authored-By` (pre-commit hook).

---

## 3WF-1 — Incident fix: TriggerGuard + recall fallback chain ⚠ SHIPS FIRST

**Goal.** A staged recall block exists for every session even when `session_start` never fires; empty stores fall to a provenance floor string instead of silence. This single sprint fixes the production incident minimum-viably (irrelevant replays with zero recall telemetry).

**Why first.** The incident's only proven defect that is both user-visible and cheap to fix defensively is "recall silently never ran." The QA pass confirmed the trigger (`session_start`) can be absent and that `before_agent_start` early-returns in default tail mode — so the guard must live where the messages are composed: the `context` event handler.

**Types (contract-first, `src/failback/types.ts`, new).**
- `TriggerGuardState { recallRan: boolean; stagedBlock: string | null; usedFloor: boolean }`
- `FloorBlock { text: string; basis: 'lastCheckpoint' | 'sessionProvenance' | 'none' }`
- `GuardRunResult { block: string; source: 'staged' | 'readonly-recall' | 'floor' }`

**Files & budgets.**
- `src/failback/types.ts` — new (~60L)
- `extensions/mega-events/context-handler/triggerGuard.ts` — new (~120L): given runtime + store, decide `staged / readonly-recall / floor`; calls a **read-only** search (no injected-set mutation — A1) via `recallRawHits` seam; floor text from last checkpoint summary or "new session" provenance; pure of pi types.
- `extensions/mega-events/context-handler.ts` — +~20L: call `triggerGuard` before `buildTailResult` when `runtime.pendingRecallBlock == null` and flag ON; pass `stagedBlock` into the tail factory.
- `extensions/mega-config.ts` + `mega-config-types.ts` — +~12L: `threeWayFailback: envBool("MEGACOMPACT_THREE_WAY_FAILBACK", true)`.
- NO changes to `session-handlers.ts` (trigger path stays as-is; guard is downstream of it).

**Flag behavior.**
- ON: `context` event with no staged block → read-only recall now → stage → tail-inject this same event; both empty → floor block.
- OFF: handler body identical to v0.20.83 byte-for-byte (verified by a flag-OFF identity test on the transformed message list).

**Tests (real store, mkdtemp).**
1. Store with checkpoints + no staged block → guard stages + tail contains recall block.
2. Empty store → floor block contains `New session` provenance text (not empty string).
3. Flag OFF → transformed messages byte-identical to pre-sprint fixture.
4. `session_start` present path unchanged (staged block takes precedence; guard is a no-op).

**Gate.** Full gate (above) + `--soft-as-hard --pre-commit` vs `v0.20.83` → `node scripts/guardrails-scan.mjs`.
**Publish.** `./scripts/deploy.sh 0.20.84`.

---

## 3WF-2 — Compaction ladder + ReductionValidator + persisted ThrashGuard

**Goal.** Stop the re-fire loop: correctness is judged by **live-window** reduction, and after an ineffective compaction the guard refuses to re-fire until N new live-window tokens arrive.

**QA anchor.** `saved` (`mega-pipeline/compact.ts:117-119`) is stored-checkpoint accounting — the 496× loop's false win. The validator's metric is the `context` event's `currentTokens` delta across consecutive events.

**Types (extend `src/failback/types.ts`).**
- `CompactCandidate { summary: string; tokenEstimate: number; signalPreserved: boolean }`
- `ReductionVerdict { effective: boolean; liveBefore: number; liveAfter: number }`
- `ThrashGuardState { blockedUntilTokens: number; armedAt: number }`

**Files & budgets.**
- `src/failback/compact.ts` — new (~60L): candidate veto + vote (`{ extractive: summarizeMessages }` vs `{ cluster: extractiveClusterSummary }`; Ollama variant only when `MEGACOMPACT_RAPTOR_MODEL` set — it is an insertion, never required); signal check = summary contains `collectRecentUserRequests(messages, 3)` content; vote = max(`reduction × (signal ? 1 : 0.5)`), reject all below floor → keep supersede-only result.
- `extensions/mega-pipeline/compact/` — delegate-shell split (current 388L is over the soft cap): `compact.ts` shell (~60L) + `compact/run.ts` (moved body) + `compact/`vote wiring (~30L). NO behavior change from the move itself.
- `src/store/sqlite/meta.ts` — +~15L: exported guarded write `setMetaNumber(key, value)` (only private `incMeta` exists today; follow `addTokensSaved` pattern :31) + keys `thrasguard.blocked_until`, `thrasguard.baseline_tokens`.
- `extensions/mega-events/context-handler/` wiring (+~15L in `context-handler.ts` or new `gateExtra.ts`): arm ThrashGuard on `ReductionVerdict.effective === false`; consult it in `gateCheck.ts` before `compact`.
- **supersede stays exactly as engine.ts:143 → unchanged precondition.**

**Flag behavior.**
- ON: candidates voted; ineffective compaction → guard armed (meta) → subsequent `context` events refuse until `currentTokens ≥ baseline + N`; N defaults to 10% of `effectiveThreshold` (new config `thrasguard.rearmTokensPct` env-overridable).
- OFF: single-path compactSession identical to v0.20.83; gateCheck byte-identical.

**Tests (real store).**
1. All-unique messages → supersede frees 0 but summary vote still succeeds (no crash, no floor-trigger).
2. Degenerate cluster candidate (empty summary) rejected → extractive wins.
3. Three consecutive ineffective compactions → fourth `context` event above threshold produces NO new checkpoint row (guard armed; meta key set); after injecting > N tokens → guard re-arms.
4. Flag OFF → `compactSession` output identical.

**Gate.** Full gate.
**Publish.** `./scripts/deploy.sh 0.20.85`.

---

## 3WF-3 — Read-only recall + 3-source vote + RecallValidator

**Goal.** Recall becomes 3 independent read-only sources voted by overlap, with a real same-repo relevance floor — no injected-set mutation, no telemetry side-effects from the validator path.

**QA anchor (A1).** Source C must be **recency** (timestamp-ordered checkpoint list), NOT `TurnReader.turn_recall` (echo of already-injected). FTS hits hydrate via the `hydrateHits` pattern. Vote keys on raw hits, not `newHits`.

**Types.**
- `RecallCandidate { checkpointId: string; score: number; source: 'vector' | 'fts5' | 'recency' }`
- `VoteResult { winners: RecallCandidate[]; votes: Record<string, number>; divergentSources: string[] }`

**Files & budgets.**
- `src/recall/readonly.ts` — new (~80L): wraps `engine.recall()` raw path (raw `hits`, skipInjected=false for voting only) without `vectorMarkInjected`/turn writes.
- `src/recall/vote.ts` — new (~70L): hydrate FTS5 hits to checkpointIds (dedup on L0 digest), recency source = the N freshest checkpoints (reuses `listCheckpoints`), overlap vote (≥2 of 3 short-circuit); else top cross-source mean score; divergence breadcrumb event.
- `src/recall/validator.ts` — new (~70L): independent of all three search calls; checks top winner cosine ≥ floor AND not already in live-window (reuses `extractLiveWindow` logic); on fail returns next-ranked winner; all fail → provenance floor (3WF-1 floor builder).
- `src/store/sqlite/fts5-search.ts` — +~25L hydrate helper.
- New config: same-repo floor (default **0.12**, env `MEGACOMPACT_RECALL_MIN_COSINE`; cross-repo 0.90 untouched).
- `extensions/mega-pipeline/recall.ts` (310L) — delegate-shell split into `mega-pipeline/recall/` (shell + impl; no behavior change from the move).

**Flag behavior.**
- ON: recall on resume/command uses the voted+validated path.
- OFF: current single-path `recallAndInline` byte-identical.

**Tests.**
1. Each source alone returns its hits; vote union deduped by checkpointId.
2. Injected-set interplay does NOT distort overlap (vote uses raw hits).
3. Validator does not advance the injected-set or emit S43 turn writes.
4. Floor rejection: top winner below 0.12 → next candidate; all below → floor block.
5. Flag OFF byte-identical.

**Gate.** Full gate.
**Publish.** `./scripts/deploy.sh 0.20.86`.

---

## 3WF-4 — InjectionConfirm + floor polish

**Goal.** The staged block's text is asserted present in the message list pi will actually send (tail mode); mismatch → re-compose; both absent → floor. The last missing validation layer in the incident chain.

**QA anchor (A3).** No prompt readback exists; `ContextEvent.messages` is the only verifiable proxy. Legacy prepend mode degrades to string-contains on our return value.

**Types.**
- `InjectionVerdict { landed: boolean; recovered: 'none' | 'recomposed' | 'floor' }`

**Files & budgets.**
- `extensions/mega-events/context-handler/injectionConfirm.ts` — new (~90L): locate the tail block (marker substring) in `event.messages`; on absence re-compose from runtime pending blocks via `buildTailResult`; last resort floor string; pure decision function + thin caller.
- `src/failback/floor.ts` — new (~50L): shared pure floor builder used by 3WF-1/3WF-3/3WF-4 (extracted from 3WF-1's guard into the common module — refactor, no behavior change).
- `extensions/mega-events/context-handler.ts` — +~15L wiring after `tailResult()` call.

**Flag behavior.**
- ON: every `context` event verifies landing; composition failures self-repair this event (user sees nothing).
- OFF: byte-identical.

**Tests.**
1. Staged-block-suppressed fixture → `InjectionVerdict.landed === false` → recomposed block present.
2. Runtime pending blocks absent too → floor block present.
3. Legacy prepend mode (`recallTailInject=false`): guard verifies returned string contains block (no crash when messages lack it).
4. Flag OFF byte-identical.

**Gate.** Full gate.
**Publish.** `./scripts/deploy.sh 0.20.87`.

---

## 3WF-5 — Toggles, telemetry, docs (program completion)

**Goal.** Both flags dashboard-toggleable; breadcrumb events landed; docs marked implemented.

**Files & budgets.**
- `extensions/dashboard-server/routes-rag-settings-helpers.ts` — SETTINGS additions: `MEGACOMPACT_THREE_WAY_FAILBACK` toggle **and** the missing `MEGACOMPACT_RECALL_TAIL_INJECT` toggle (~20L). Keep both OUT of `EXCLUDED_SETTINGS` (all-flags-toggleable rule).
- Breadcrumb events (already wired through 3WF-1..4): `three_way_guard_fired`, `three_way_floor_used`, `thrasguard_armed`, `injection_confirmed/recovered` — verify they land in events.log + dashboard Events tab (+~15L wiring checks only; no new event targets).
- `docs/superpowers/specs/2026-08-12-three-way-failback-design.md` — status → IMPLEMENTED with per-amendment links to sprint commits.
- `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` — register this program (project doc-map convention).

**Flag behavior.** ON: toggles + telemetry visible. OFF: byte-identical runtime.

**Tests.**
1. Settings UI round-trip: toggle writes env/scoped config, loader picks it up.
2. `EXCLUDED_SETTINGS` does not contain either key (assert).
3. Each breadcrumb event emits with `ts` + `event` fields.

**Gate.** Full gate.
**Publish.** `./scripts/deploy.sh 0.21.0` — minor bump: the 3-way failback is a behavior-affecting safety system now fully landed.

---

## Program verification (post-3WF-5)

1. **Incident replay:** harness session with checkpoints where `session_start` is suppressed → agent's provided context contains a recall/floor block (3WF-1+4). Before = irrelevant nothing; after = verified block.
2. **Thrash replay:** scripted 500 `context` events over threshold with deduped identical compactions → checkpoint row count stops growing after the first ineffective verdict (3WF-2). Before = 496 rows; after = 1 + re-arm cycles only.
3. **Flag-OFF identity:** full test suite with `MEGACOMPACT_THREE_WAY_FAILBACK=false` produces byte-identical behavior to v0.20.83 fixtures.
4. **Field check:** run a real pi session (`pi --continue` on the incident repo); dashboard version shows ≥0.21.0; Events tab shows `three_way_*` breadcrumbs; events.log has no silent recall runs.

## Explicit non-goals (stay parked)

- Merging `pma-remerge-review` (PRs #15/#16 re-apply) — decision deferred; 3WF must not depend on it.
- Root-fixing pi's `session_start` emission (host-side; TriggerGuard covers operationally).
- The S38 retry memory-loop driver (pre-existing, separate investigation — the review showed no consumption of turn_write_failed by retry logic, so it is not part of this program).
- Recall-as-pi-tools (pull model) — future program built on `feat/local-rag-mcp-spec` groundwork.
- PMA analytics.db leak fix (F1) and registerPub guard (F5) — separate small fix if PMA re-merge is approved later.
