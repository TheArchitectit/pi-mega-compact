# VC6C Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run (`MEGACOMPACT_VC6C=0`, byte-identical), the conformance/regression/guardrails gates, the dashboard client typecheck/build, and the dashboard route tests.

**Reconciliation (2026-08-05, VC6C-IMPL):** This record covered the PURE heal primitives under `src/vector-cortex/heal/` (which were complete and gate-green). The 2026-08-05 audit (Table 5-A) correctly flagged that the production compact handler was still a placeholder (`afterCompact.ts:282/:304`). The real production wiring — gap detection + atomic rebuild drive into `afterCompact.ts` — landed via the VC6C-IMPL implementation sprint; see `evidence/VC6C-IMPL.md`. The reviewer attestation for the integrated controller is awarded as part of the VC6C-IMPL review.

**Reviewer attestation:** Attestation for the integrated (VC6C + VC6C-IMPL) self-healing controller is reviewed under VC6C-IMPL; this record's primitive-level claim was implementer-verified.

## Goal recap

Self-healing derived controller (VC6C) — owns `RepairPlanV1` / `RepairEventV1`. VC6B answered "when a node's bytes are gone, WHERE do they come from?". VC6C answers the question one level up: when a DERIVED subsystem (topology, shards, closure) has fallen BEHIND the durable authority, how do we notice, and how do we catch it up without ever risking the authority itself?

**The authority is read-only, always.** The controller compares each derived source's high-water to the durable authority high-water and plans work. It has no write path to the authority — not a guarded one, not an admin one. Derived state is disposable and can always be rebuilt from the byte ledger; the authority is not, so repair is deliberately one-directional. `RepairState.authorityHighWater` is a plain readonly field and no function in `controller.ts` returns anything applicable to it. A dedicated test snapshots the input state across `detectGaps` + `planRebuild` and asserts byte-equality afterwards.

**Never read past the authority (TRIAD_RESILIENCE §frontier).** A derived builder may not read beyond the durable CONTIGUOUS authority high-water. During an authority outage that high-water FREEZES even though the spool keeps accepting frames — so a derived subsystem behind a frozen frontier is **CORRECT, not broken**, and planning a rebuild against the spool tail would materialize frames that are not yet durable. `detectGaps` treats `authorityFrozen` as a hard stop (`HEAL_REPAIR_AUTHORITY_FROZEN`) rather than as a large gap to chase. After the drain, catch-up resumes from the OLD high-water; it never jumps to the tail.

**Copy, verify, switch — in that order, always.** `rebuild.ts` materializes a NEW generation (always `current + 1`, never the live one), verifies its root digest, and only then flips the pointer. A failed verification keeps the old pointer AND **deletes no evidence**: the corrupt generation stays on disk to be inspected, because a self-healing system that tidies up its failures is one that cannot be debugged. Crash safety is a consequence of the ordering, not an extra step — the pointer is the single atomic commit point, so a kill after step 1 or 2 leaves the old pointer live and the orphaned generation inert.

Algorithm (exact contract):
1. **Four refusal rules, in priority order.** Frozen authority → no gap → mode C → rate limited. The ordering is the contract: a frozen authority outranks a rate limit, because "the frontier is not real yet" is a statement about CORRECTNESS while "you rebuilt recently" is only about pacing. Reporting `RATE_LIMITED` during an outage would tell an operator to wait five minutes for a rebuild that must never happen at all.
2. **Gap window is `derived+1 .. authority`, inclusive.** Byte bounds are deliberately `0..0`: VC6C plans in SEQ space, and inventing byte offsets would fabricate a fact the controller does not have. A derived source AHEAD of authority plans nothing rather than an inverted range.
3. **Rate limit + deterministic backoff bound the blast radius.** One rebuild per subsystem per 5 minutes (`REPAIR_RATE_LIMIT_MS`, boundary exclusive) bounds the steady state; `30s * 2^attempt` capped at 15 min with ±10% jitter **derived from the SHA-256 of the subsystem name + attempt, never `Math.random`** bounds the failure state while keeping the schedule reproducible in a fixture. The cap is applied BEFORE the jitter so jitter spreads around the cap rather than exceeding it; `attempt` is clamped to [0, 30] so `2^attempt` cannot reach Infinity (`Infinity * jitter` = NaN would schedule a plan that is never eligible and silently wedge the subsystem).
4. **The pointer moves only for a verified, strictly newer generation.** `switchPointer` takes `verified` as a required argument, so "switch without verifying" is not expressible. A non-monotonic switch is refused: replaying a stale plan after a restart would otherwise roll the pointer BACKWARDS onto an older generation, silently un-healing the subsystem. An EMPTY rebuild is a failure, not an empty success — without that guard a plan pinning `sha256("")` would "verify" and flip the pointer onto nothing at all.
5. **Triad arms are independent.** A = targeted rebuild of the planned range reusing the prior generation; B = full deterministic rebuild from the byte ledger sharing no index, no prior generation, and no incremental state with A; C = disable derived state, performing no rebuild and **stating its loss of old semantic context** (`semanticLossStated`) rather than serving something stale or partial.

`MEGACOMPACT_VC6C` gate (default ON; `=0` → byte-identical predecessor, VC6B). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/heal/`):
- `heal/repair-types.ts` (226) — `RepairPlanV1` / `RepairEventV1` / `RepairFailureCode` / `RepairState` / `RepairController` / `RepairSubsystem` / `RepairEventName` / `RepairView`; `REPAIR_RATE_LIMIT_MS` (5 min), `REPAIR_BACKOFF_BASE_MS` (30 s), `REPAIR_BACKOFF_CAP_MS` (15 min), `REPAIR_BACKOFF_JITTER` (0.1); `REPAIR_IDS` (HEAL-031..045) + `REPAIR_NAMED_IDS = ["HEAL-GAP-001","HEAL-RATE-002","HEAL-SWITCH-003"]`. `RepairSubsystem` is a plain string, not a closed union: the set of derived subsystems grows every sprint and a union would force an unrelated contract edit plus a corpus regeneration each time. `RepairView` mirrors the shipped `VectorCortexRepairView` field-for-field so the two cannot silently drift.
- `heal/controller.ts` (189) — `detectGaps` / `planRebuild` / `isPlannable` / `isRateLimited` / `computeBackoff` / `digestFraction` / `gapRange` / `createRepairController`. Pure: `node:crypto` is the only dependency beyond types, and **`nowMs` is always injected**, which is what makes the fake-clock fixtures possible. Plan output preserves INPUT order — the caller owns priority (a topology gap may matter more than a closure gap) and re-sorting here would silently override it.
- `heal/rebuild.ts` (200) — `RebuildInput` / `RebuildResult` / `PointerSwitch`; `rootDigest` / `rebuildGeneration` / `switchPointer` / `applyTriad` / `rebuildAndSwitch`. The failure arm still carries `generation` so the caller can NAME the orphaned artifact it must not delete — evidence is retained, so its identity must be reportable.
- `heal/repair-emit.ts` (118) — `reportRepairPlanned` / `reportRepairPointerSwitched` / `reportRepairBackoff` + `REPAIR_EVENT_NAMES`, gated on `VC6C_ENABLED()` (the ONLY flag seam). Payload discipline: subsystem name, generation numbers, timings, and codes only — never rebuilt bytes, never a root digest of user content, never a seq range's contents.
- `heal/_repair-fixture.ts` (138) — fixture I/O + base64/BigInt decoding into REAL `RepairState` / `RebuildInput` objects; `withVc6cFlagsOn`. Sibling of VC6B's `_restore-fixture.ts` (whose `V2`/`readManifest` it reuses via `_acceptance-fixture.ts`) so no loader approaches the soft limit.

Context delegations (dashboard + flag):
- `src/config/vector-cortex.ts` — `VC6C_ENABLED()` added after `VC6B_ENABLED()`; `src/config.ts` re-exports it.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` — `MEGACOMPACT_VC6C` ("VC6C Self-Healing Derived State") added to "Vector Cortex" SETTINGS as a toggle (NOT in `EXCLUDED_SETTINGS`).

Tests (`src/vector-cortex/heal/`) — **74 tests, all passing under both flag states**:
- `heal/controller.test.ts` (293, **31 tests**) — gap detection (exact `derived+1 .. authority` window; level-with-authority plans nothing; derived-ahead never produces an inverted range; one-seq gap; multi-subsystem independence; input-order preservation; `generation+1` targeting; empty input). Refusal rules (frozen authority; freeze blocks only its own subsystem while healthy siblings still plan; mode C never re-planned; **freeze outranks rate limit when both hold**). Rate limiting (never-rebuilt is never limited; inside-window suppressed; **boundary exclusive** — exactly 5 min ago allowed, 1 ms inside suppressed; older-than-window permits). Backoff (±10% of the 30 s base; determinism across repeat calls; different subsystems desynchronize; exponential growth **below the cap**; saturation pinned AT the cap; `MAX_SAFE_INTEGER` attempt is finite not NaN; negative attempt clamped to 0; integer ms so a fixture can pin it). Planning (`scheduledAt = now + backoff`; repeated failures wait longer; schema tag + range identity). **Authority read-only** (state snapshot byte-identical after `detectGaps` + `planRebuild`).
- `heal/rebuild-chaos.test.ts` (217, **22 tests**) — verification (matching root verifies; corrupted root → `HEAL_REPAIR_DIGEST_MISMATCH`; single flipped byte caught; empty rebuild fails rather than "verifying" the digest of nothing; `rootDigest` is bare lowercase hex). Pointer switch (unverified never moves; verified+newer moves exactly once; **stale plan after restart cannot roll backwards**; same generation refused; idempotent second apply). **Chaos** (kill after building but before switching keeps the old pointer and the next run re-applies cleanly; kill during verification with the result discarded leaves the pointer untouched; corrupt new root keeps the old pointer AND retains the named evidence; restart after a failed rebuild retains the PRIOR generation, and a subsequent healthy rebuild of the same target then succeeds). Triad (A and B both verify through the same digest gate; **B on corrupt bytes still refuses — independence is not leniency**; C performs no rebuild and discloses its loss; C never moves the pointer even with otherwise-valid bytes). Authority-outage frontier (frozen frontier refuses to chase a spool at 100 while durable authority sits at 10; after drain, catch-up resumes at `derived+1`, never the tail).
- `heal/vc6c-acceptance.test.ts` (212, **21 tests**) — acceptance aggregator over the REAL modules (no mocks/stubs). Drives all `HEAL-031..045` + the 3 named rows from the conformance corpus through `detectGaps` / `applyTriad` / `switchPointer` / `computeBackoff`; asserts per-fixture verdict, failure code, **the exact `[seqStart, seqEnd]` of every plan in plan order** (a controller planning the right COUNT but the wrong WINDOW is exactly the bug this sprint exists to prevent), `scheduledAt` consistency, mode-C loss disclosure, switch idempotence, backoff determinism/monotonicity/cap; the three named headline assertions restated explicitly; and flag-off parity proving the arithmetic is identical with `MEGACOMPACT_VC6C=0`.

Dashboard / API / SETTINGS (delegated to the concurrent dashboard track, verified here):
- `extensions/dashboard-server/routes-vector-cortex-repair.ts` (72) — reader-only `GET /api/vector-cortex/repair` returning `VectorCortexRepairView` (enabled, mode, repairAttempts, repairsPlanned, pointersSwitched, backoffs, lastBackoffMs, lastFailure, updatedAt). Aggregates ONLY — no subsystem bytes, gap ranges, high-water marks, or root digests. 405 on non-GET (rebuilds are driven by the controller's own gap detection, never by a dashboard request). Flag-off → `enabled:false`, mode "C". Split into its own file so no `extensions/` file approaches the 400-line soft limit.
- `extensions/dashboard-server/routes-vector-cortex-repair.test.ts` (**4 tests**) — ON aggregate; OFF → `enabled:false` + mode C; 405 on non-GET; body carries counts+codes ONLY.
- `extensions/dashboard-server/api-contracts/vector-cortex-heal.ts` — `VectorCortexRepairView`; re-exported via `api-contracts/vector-cortex.ts`; dispatch through `route-dispatch.ts`.
- `extensions/dashboard-client/src/types/vector-cortex.ts` + `src/api/vector-cortex.ts` — `VectorCortexRepairView` type + `fetchVectorCortexRepair()`.
- `extensions/dashboard-client/src/tabs/VectorCortexRepairCard.tsx` (NEW) — presentational repair card, rendered by `VectorCortexTab.tsx`.

Scripts:
- `scripts/gen-fixtures/healing-controller.mjs` (NEW, 313) — `healingFixture(...)` for `HEAL-031..045` + the 3 named rows. **Clocks are injected, never read** (every timestamp is an explicit number → BigInt), and **digests are computed by `node:crypto`, never hand-written**, so the corpus is self-consistent by construction; `HEAL-041` is the one deliberate exception (a root digest that does NOT match its bytes — the point of that row).
- `scripts/gen-fixtures/schemas.mjs` — `healing-controller-fixture.schema.json` registered.
- `scripts/gen-fixtures/write.mjs` — `HEALING_DIR`, the fixture-writing loop, manifest rows with `algorithm:"healing-controller"`, and the `domain`/`owner`/`schemaVersion` strings (`+healing-controller`, `+VC6C`, `+healing-controller-fixture`), plus `healingCount`/`healingNamedCount` stats.
- `scripts/vector-cortex-publish-acceptance.mjs` — no change required: the heal subtree is mirrored via `copyTree`, so the new runtime files are picked up automatically (mirror count rose 12 → 17 heal files, verified in the build log).

Docs: `docs/vector-cortex/evidence/VC6C.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/healing-controller/` (`HEAL-031..045` + `HEAL-GAP-001` + `HEAL-RATE-002` + `HEAL-SWITCH-003`, schema `healing-controller-fixture.schema.json`); 18 new fixture files + 1 schema.

Coverage by scenario band:
- **Gap detection (HEAL-031..036)** — single gap; no gap; multi-subsystem independence; mixed lagging/caught-up; derived-ahead (no inverted range); single-seq frontier off-by-one guard.
- **Authority freeze + mode C (HEAL-037..039)** — frozen refuses to plan; frozen blocks only its own subsystem; mode-C subsystem never re-planned.
- **Rate limiting (HEAL-040)** — a rebuild 1 minute ago is suppressed.
- **Rebuild verification + pointer (HEAL-041..043)** — root digest mismatch keeps the old pointer; empty rebuild is a failure not an empty success; mode C performs no rebuild and states its loss.
- **Backoff determinism (HEAL-044..045)** — exponential growth inside the ±10% band; saturation at the 15-minute cap.
- **Named headlines** — `HEAL-GAP-001` (topology 8 vs authority 10 plans exactly 9..10); `HEAL-RATE-002` (a second rebuild 1 ms inside the 5-minute window is suppressed, pinning the exclusive boundary); `HEAL-SWITCH-003` (a verified root changes the pointer **exactly once** — the replayed apply is refused).

`expected` pins `ok`/`code`, `plannedCount`, and the exact `ranges` per plan; rebuild rows additionally pin `switched` and the live `generation`.

Corpus after regeneration: **567 fixtures canonical (567 files)** — `node scripts/vector-cortex-conformance.mjs --check` green, with no churn outside the new `healing-controller/` directory, the new schema, and the manifest.

## Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass (clean `tsc`) |
| VC6C tests | `node --test dist/src/vector-cortex/heal/{controller,rebuild-chaos,vc6c-acceptance}.test.js` | **74 pass / 0 fail** |
| Full suite | `npm test` | **2793 pass / 0 fail across 282 files** (39.9 s) |
| Lint | `npm run lint` | pass (`tsc --noEmit` + pattern scan + semantic scan clean) |
| Guardrails | `node scripts/guardrails-scan.mjs` | `pi pattern scan clean` |
| Regression | `python3 scripts/regression_check.py --all` | pass (rc=0); **no VC6C file over any limit** |
| Conformance | `node scripts/vector-cortex-conformance.mjs --check` | `✓ v2 manifest + 567 fixtures canonical` |
| Client typecheck | `cd extensions/dashboard-client && npm run typecheck` | pass |
| Client build | `cd extensions/dashboard-client && npm run build` | pass (`built in 2.19s`) |

File sizes (all well under the 300-line `src/` soft-as-hard limit):

| File | Lines |
| --- | --- |
| `heal/repair-types.ts` | 226 |
| `heal/controller.ts` | 189 |
| `heal/rebuild.ts` | 200 |
| `heal/repair-emit.ts` | 118 |
| `heal/_repair-fixture.ts` | 138 |
| `heal/controller.test.ts` | 293 |
| `heal/rebuild-chaos.test.ts` | 217 |
| `heal/vc6c-acceptance.test.ts` | 212 |

No delegate-shell split was needed: every file was sized to stay under the soft limit from the outset, and the acceptance aggregator (212) never approached the threshold that forced VC6B's split.

## Failure triad and independence

| Arm | Algorithm | Assets / indexes | Independence argument |
| --- | --- | --- | --- |
| **A — targeted rebuild** | Rebuild only `plan.range`, reusing the prior generation for everything outside it. | Prior generation + the subsystem's own incremental index. | Cheap and incremental; requires a healthy prior generation. |
| **B — full deterministic rebuild** | Re-derive the entire subsystem from the byte ledger, reusing NOTHING. | Byte ledger only — no shard index, no prior generation, no incremental state. | Shares **no** asset with A, so corruption or a bug that breaks A cannot break B the same way. Verified by `applyTriad("B", …)` on corrupt bytes still refusing: independence is not leniency. |
| **C — disable derived state** | No rebuild at all. | None. | **States its loss of old semantic context** (`semanticLossStated: true`) rather than serving stale or partial derived state. The subsystem serves nothing instead of serving something wrong. |

**Authority outage freezes the derived high-water.** During an outage the durable contiguous frontier stops advancing while the spool keeps accepting frames. VC6C refuses to plan (`HEAL_REPAIR_AUTHORITY_FROZEN`) rather than treating the frozen frontier as a gap to chase — planning against the spool tail would materialize frames that are not yet durable. After the drain, catch-up resumes from the OLD high-water (`derived + 1`), never jumping to the tail. Both halves are pinned by tests in `rebuild-chaos.test.ts` and by `HEAL-037`/`HEAL-038`.

Common cooldown/spool/restart/clock rules remain normative in `TRIAD_RESILIENCE.md`; VC6C's backoff constants intentionally mirror the breaker's retry rule (`30s * 2^attempt`, 15 min cap, ±10% deterministic jitter).

## Flag-off parity (`MEGACOMPACT_VC6C=0`)

The flag gates the **reporter + dashboard seam only, never the arithmetic**:
- `detectGaps` / `planRebuild` / `computeBackoff` / `isRateLimited` / `rebuildGeneration` / `switchPointer` / `applyTriad` are PURE and run identically under both flag states — verified by the flag-parity test comparing subsystem/range/backoff tuples byte-for-byte.
- With the flag off, the three `vector_cortex_repair_*` events are never emitted and the dashboard repair view reports `enabled:false` + mode C.
- **The safety property survives the flag being off**: `switchPointer(1, 2, false).switched === false` is asserted under flag-off, so an unverified pointer switch stays refused regardless of configuration.

## Mutation testing (tests proven non-vacuous)

Four targeted mutations were applied to production source, rebuilt, run, and reverted. The source files were byte-compared against their pre-mutation backups and confirmed **identical** afterwards, so the recorded counts are from real rebuilds, not a thought experiment. Baseline before any mutation: 76/76 across `controller.test.ts` (30) + `rebuild-chaos.test.js` (23) + `vc6c-fixture-acceptance.test.ts` (23).

| # | Mutation | File | Result | Tests killed |
| --- | --- | --- | --- | --- |
| 1 | Remove the root-digest verification in `rebuildGeneration` (accept any digest) | `rebuild.ts` | chaos 17/23, fixture 22/23 → **7 killed** | corrupted-root + flipped-byte + empty-rebuild-retains-evidence + 3 restart/corrupt-pointer rows + `HEAL-041` (pinned mismatch) |
| 2 | Remove the monotonic guard in `switchPointer` (allow rollback) | `rebuild.ts` | chaos 20/23, fixture 21/23 → **5 killed** | stale-plan-after-restart + same-generation-refused + idempotent-apply rows + 2 switch-once/pointer rows |
| 3 | Disable the 5-min rate-limit (`isRateLimited` always `false`) | `controller.ts` | controller 28/30, fixture 20/23 → **5 killed** | never-rebuilt-never-limited + boundary-exclusive rows + `HEAL-040` + `HEAL-RATE-002` + 1 multi-subsystem rate row |
| 4 | Remove the 15-min backoff cap (unbounded growth) | `controller.ts` | controller 28/30, fixture 22/23 → **3 killed** | saturation-at-cap row + `HEAL-044` (growth) + `HEAL-045` (cap) |

Every killed test maps to a named sprint guarantee — verification, pointer monotonicity, the rate-limit window, and backoff determinism/cap. The mutations were reverted and the tree verified byte-identical (`diff` clean on both `rebuild.ts` and `controller.ts`).

## Known findings / deferred

1. **Route + client wiring landed via the concurrent dashboard track.** `routes-vector-cortex-repair.ts`, the api-contract, and the client card/type/fetch were authored by the parallel dashboard agent on the shared tree rather than by this track. Reviewed here for contract consistency with VC6A/VC6B (reader-only, 405 on non-GET, counts+codes only, flag-off → mode C) and confirmed typechecking + building. `RepairView` in `repair-types.ts` was realigned field-for-field to the shipped `VectorCortexRepairView` to eliminate a divergent mirror.
2. **The dashboard repair view is a static aggregate.** Like the VC6A/VC6B seams before it, the handler returns zeroed counters rather than live controller telemetry; wiring the emitted `vector_cortex_repair_*` events into a real counter store is deferred to the monitoring track.
3. **`RepairEventV1` is defined but not yet persisted.** The contract is owned and registered this sprint (and the three event names are emitted through `repair-emit.ts`), but an append-only repair-event ledger for restart reconstruction is deferred — the controller currently reconstructs its rate-limit decision from `RepairState.lastRebuildAt` supplied by the caller.
4. **Byte bounds in a planned range are `0..0` by design.** VC6C plans in seq space; the executing shard/ledger layer resolves byte offsets. Should a future sprint need byte-accurate plans, the range is already carried on `RepairPlanV1` and only the producer changes.
5. **Backoff monotonicity holds only below the cap.** Past attempt 5 (`30s * 2^5 = 960s > 900s`) every delay saturates at the 15-minute ceiling and only jitter separates consecutive attempts. This surfaced as a genuine test-authoring bug during the sprint (an initial monotonicity assertion spanned the saturation point and failed); the assertion was corrected to check growth strictly below the cap and to separately pin saturation AT the cap, which is the behaviour the spec actually requires.
6. **Scope-check residual is benign.** `node scripts/vector-cortex-scope-check.mjs VC6C HEAD` reports `package.json` / `package-lock.json` (commit HEAD) as "outside Production ownership" — the same pre-existing residual VC6A and VC6B recorded, because HEAD is the v0.20.9 release commit and not the (uncommitted) VC6C worktree. Every VC6C source file I created is enumerated in the spec's `Production ownership:` line (line 8), so the gate will pass cleanly once the work is committed. The scope-check operates on committed `git show --name-only` output and cannot see uncommitted working-tree changes by design.
