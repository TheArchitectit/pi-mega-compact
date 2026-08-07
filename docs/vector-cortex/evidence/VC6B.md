# VC6B Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run (`MEGACOMPACT_VC6B=0`, byte-identical), the conformance/`docs-check`/regression gates, the dashboard client typecheck/build, and the dashboard route tests.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Goal recap

Exact source restoration (VC6B) — owns `RestoreRequestV1` / `RestoreResultV1`. VC6A optimized WHICH EDGES the closure plan walks; VC6B answers the next question: when the plan needs a node whose bytes are no longer in the live window, WHERE do those bytes come from? The answer is deliberately narrow — an EXACT source, or nothing.

**The cardinal rule.** Restored bytes are ONLY ever read from (1) an `ExactShardV1` whose range and digest both match the request, or (2) a scan of the `EventV2` occurrence ledger over the requested seq range. Bytes are NEVER inferred from an embedding, a semantic shard, or a RAPTOR summary. A semantic tier can say what a span was ABOUT; it cannot say what the span WAS. VC6B has no code path that can do it: `RestoreReader` exposes exactly the two exact sources and nothing else, so "restore from a derived source" is not merely forbidden by policy — it is **unrepresentable in the type**.

**The verification rule.** Every restored span must hash to the SHA-256 the REQUEST pinned, checked immediately before insertion. A source matching by range but not by hash is rejected (`HEAL_RESTORE_DIGEST_MISMATCH`) — never "close enough".

Algorithm (exact contract):
1. **Bounds, before any reader touch.** `RESTORE_LIMIT_SPANS` (64) and `RESTORE_LIMIT_BYTES` (4 MiB) are computed PURELY from the request (`byteEnd - byteStart`, needing no source) and checked first; on breach `restoreSources` returns immediately having never read `reader.exactShards`/`reader.ledgerEvents`. Inverted ranges contribute 0 rather than reducing the total, so an inverted span cannot smuggle a large request under the bound.
2. **Exact shard → ledger → missing**, strongest-first, per span in request order. `readExactShard` selects by range identity + the shard's recorded digest, then **re-hashes `originalBytes`** (defense in depth: the recorded digest is metadata living in the same file as the bytes, so a swapped file carries a matching wrong pair). `readLedgerSpan` is an INDEPENDENT path — no shard index — that sorts covering records ascending by seq (caller array order is untrusted), verifies each record's own `bytesDigest`, then hashes the concatenation against the span digest.
3. **Mode from what happened, not what was attempted.** A = every span from a shard; B = all restored, ≥1 via ledger scan; C = something missing → the span is OMITTED and the loss DISCLOSED (`semanticLossStated`), never substituted with derived text.
4. `verifyRestored` re-derives every digest from the bytes the result ACTUALLY CARRIES (so a result mutated after `restoreSources` returned still fails), and cross-checks each `nodeId`'s digest against the request — two distinct invariants, two distinct codes (`HEAL_RESTORE_DIGEST_MISMATCH` = bytes lie about themselves; `HEAL_RESTORE_RANGE_MISMATCH` = internally honest bytes answering a different question). `insertable` is wholesale: all spans or none.

`MEGACOMPACT_VC6B` gate (default ON; `=0` → byte-identical predecessor, VC6A). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/heal/`):
- `heal/restore-types.ts` (185) — `RestoreSpanRequest` / `RestoreRequestV1` / `RestoreSpanResult` / `RestoreResultV1` / `RestoreFailureCode` / `RestoreVerification` / `RestoreReader` / `RestoreEventName`; `RESTORE_LIMIT_SPANS` (64) + `RESTORE_LIMIT_BYTES` (4 MiB); `RESTORE_IDS` (HEAL-016..030) + `RESTORE_NAMED_IDS = ["HEAL-SPAN-001","HEAL-LIMIT-002","HEAL-DIGEST-003"]`. Documents the **three-digest-field hazard**: `ReconstructionSpan.digest`/`ExactShardV1.digest`/`RestoreSpanRequest.digest` are BARE lowercase hex; `EventV2.bytesDigest` is `sha256:<hex>` WITH the prefix, used only for per-record verification inside the ledger path.
- `heal/restore.ts` (165) — `restoreSources` orchestrator + `orderCodes` (fixed priority order so `codes` is deterministic regardless of which span failed first) + `requestedBytes` + `limitExceeded`. Never throws: an unrestorable request yields mode C, not an exception (non-fatal store discipline).
- `heal/restore-readers.ts` (145) — `readExactShard` (mode A) + `readLedgerSpan` (mode B) + `sha256Hex` / `bareHex` / `rangeEquals` / `ReadOutcome`. Split out of `restore.ts` so the orchestrator stays a short policy file (both well under the 300-line soft limit).
- `heal/verify.ts` (93) — `verifyRestored` + `insertable`, the pre-insertion gate.
- `heal/restore-emit.ts` (94) — `reportSourceRestored` / `reportRestoreDigestRejected`, gated on `VC6B_ENABLED()` (the ONLY flag seam). Payload discipline: COUNTS and MODES only — never restored bytes, node text, or a digest of user content.
- `heal/_restore-fixture.ts` (163) — fixture I/O + base64/BigInt decoding into REAL `ExactShardV1`/`EventV2` objects; `withVc6bFlagsOn`. Sibling of VC6A's `_acceptance-fixture.ts` (whose `V2`/`readManifest` it reuses) so neither approaches the soft limit.

Context delegations (dashboard + flag):
- `src/config/vector-cortex.ts` — `VC6B_ENABLED()` added after `VC6A_ENABLED()`; `src/config.ts` re-exports it.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` — `MEGACOMPACT_VC6B` ("VC6B Exact Source Restoration") added to "Vector Cortex" SETTINGS as a toggle (NOT in `EXCLUDED_SETTINGS`).

Tests (`src/vector-cortex/`):
- `vc6b-acceptance.test.ts` (24, delegate-shell) — the aggregation logic originally co-located here (391 lines, 31 tests over `restoreSources` → `verifyRestored`) was split into sibling files under `./heal/` to stay under the 300-line soft limit (soft-as-hard gate on later sprints): `vc6b-conformance.test.ts` (registration + id range), `vc6b-fixture-acceptance.test.ts` (HEAL-016..030 + named rows), `vc6b-byte-identity.test.ts` (byte-identity + insertion invariants), `vc6b-failure-injection.test.ts` (unique injections), `vc6b-triad.test.ts` (forced A/B/C), `vc6b-boundary.test.ts` (disjoint spans + limit boundary), `vc6b-flag-parity.test.ts` (flag-off arithmetic). This file is now the doc-mandated registration entry-point only.
- `heal/restore.test.ts` (293, **14 tests**) — mode A (verbatim bytes; invalid UTF-8 unnormalized), mode B (fall-through; multi-event concatenation; out-of-order input sorted; out-of-range events excluded; cross-session events never scanned), mode C (omission + disclosure), digest rejection (wrong pinned digest; **shard bytes swapped after indexing**; ledger record whose own `bytesDigest` is wrong), and bounds (65 spans rejected; 64 accepted at the boundary; >4 MiB rejected; **reader properties proven untouched via throwing getters**).
- `heal/verify.test.ts` (168, **9 tests**) — valid results; digest mismatch (tampered bytes, truncated read); range/provenance mismatch (unrequested nodeId; digest disagreeing with the request's pin for that node); code dedup in priority order; `insertable` wholesale gating (all spans, or none — the good half is withheld too).

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-heal.ts` — reader-only `GET /api/vector-cortex/restore` returning `VectorCortexRestoreView` (enabled, mode, restoreAttempts, restoredCount, missingCount, digestRejections, codes, updatedAt). Aggregates ONLY — **there is no payload endpoint**, so no restored bytes/span ids/node ids/byte ranges/ledger text can leak. 405 on non-GET. Flag-off → `enabled:false`, mode "C".
- `extensions/dashboard-server/routes-vector-cortex-restore.test.ts` (107, **4 tests**) — ON: reader-only aggregate; OFF: `enabled:false` + mode C; 405 on non-GET; and an explicit assertion that the body carries counts+codes ONLY (never a payload surface).
- `extensions/dashboard-server/api-contracts/vector-cortex-heal.ts` — `VectorCortexRestoreView`; re-exported via `api-contracts/vector-cortex.ts`; dispatch through `route-dispatch.ts` / `routes.ts` / `routes-vector-cortex.ts`.
- `extensions/dashboard-client/src/types/vector-cortex.ts` + `src/api/vector-cortex.ts` — `VectorCortexRestoreView` type + `fetchVectorCortexRestore()`.
- `extensions/dashboard-client/src/tabs/VectorCortexRestoreCard.tsx` (NEW, 42) — presentational restore card, extracted so `VectorCortexTab.tsx` (334) stays well under the 500-line hard limit.

Scripts:
- `scripts/gen-fixtures/restoration.mjs` (NEW, 469) — `restoreFixture(...)` for `HEAL-016..030` + the 3 named rows. **Digests are computed by `node:crypto`, never hand-written**, so the corpus is self-consistent by construction; `HEAL-DIGEST-003` is the one deliberate exception (a digest that does NOT match its bytes — the point of that row).
- `scripts/gen-fixtures/schemas.mjs` — `restoration-fixture.schema.json` registered.
- `scripts/gen-fixtures/write.mjs` — `RESTORATION_DIR`, the fixture-writing loop, manifest rows with `algorithm:"restoration"`, the `domain`/`owner`/`schemaVersion` strings, and `restorationCount`/`restorationNamedCount` stats.
- `scripts/vector-cortex-publish-acceptance.mjs` — **no change required**: the heal subtree is mirrored via `copyTree`, so the five new runtime files are picked up automatically (the mirror count rose 5 → 12 heal files, verified in the build log).

Docs: `docs/vector-cortex/evidence/VC6B.md` (this record); `docs/vector-cortex/sprints/VC6B-source-restoration.md` — Status `planned` → `next`, and the `Production ownership:` line amended to list all VC6B files (see Known findings).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/restoration/` (`HEAL-016..030` + `HEAL-SPAN-001` + `HEAL-LIMIT-002` + `HEAL-DIGEST-003`, schema `restoration-fixture.schema.json`); 18 new fixture files + 1 schema.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 548 fixtures canonical (548 files).` (548 = 529 prior (VC6A) + 18 new fixtures + 1 schema; the restoration domain supersedes no prior domain).

Coverage: HEAL-016..020 exact-shard mode A (single, multi-disjoint, **invalid UTF-8 verbatim**, tool-pair never split, large-but-in-bounds); HEAL-021..025 ledger mode B (single, multi-event concatenation, **shuffled input sorted by seq**, tool call/result pair across two events, non-UTF8 concatenation); HEAL-026..028 mixed/missing (exact+ledger → B; one span uncovered → C; all uncovered → C); HEAL-029/030 bounds (65 spans; 6 MiB aggregate). All canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

Regenerating the corpus is **idempotent** — re-running `node scripts/vector-cortex-gen-fixtures.mjs` produced no fixture churn (`git status` showed only the expected new/untracked paths), confirming the generator is deterministic.

## Migration

**Pure sprint — no migration.** `restoreSources`/`verifyRestored` are pure in-memory logic over caller-supplied readers; no persistent store is created, read, or altered, and no on-disk format changes. Rollback sets `MEGACOMPACT_VC6B=0` → dashboard view `enabled:false`, mode "C", events suppressed; the restore/verify arithmetic is byte-identical (the flag gates only the reporter + dashboard seam). Handoff to VC6C: `RestoreRequestV1`/`RestoreResultV1` + the `HEAL_RESTORE_*` codes are the contracts the self-healing controller consumes.

## A/B/C and independence evidence

Triad over the restoration domain, exercised as a **forced** triad on one fixed span in `vc6b-acceptance.test.ts` ("forced A/B/C triad") so the three modes are compared on identical input:

- **A** — an indexed exact shard serves the read (`source:"exact-shard"`, `verifyRestored` ok). Fixtures HEAL-016..020, HEAL-SPAN-001.
- **B** — the exact index is empty, forcing the **INDEPENDENT** ledger range scan (`source:"ledger-scan"`). The test asserts B's bytes are **byte-identical to A's** for the same span: the two paths share no lookup machinery, so agreement is real corroboration rather than a shared-code tautology. Fixtures HEAL-021..026.
- **C** — neither source exists: the span is OMITTED, `missing` carries identity only, `semanticLossStated:true`, `HEAL_RESTORE_SOURCE_MISSING`. The test explicitly asserts `restored.length === 0` — *nothing fabricated from a derived source*. Fixtures HEAL-027..030 + both failing named rows.

Independence where it matters: a range-matching shard with the wrong digest does NOT silently fall through to the ledger (a corrupt exact shard is a fact worth surfacing) — it reports `HEAL_RESTORE_DIGEST_MISMATCH`; per-record ledger verification localizes corruption to one occurrence while the span-level hash catches a scan that is individually valid but collectively wrong (a missing middle record); the bounds path is independent of every reader. No network-denial mode applies (PREVENT-PI-004 inherently satisfied: zero fetch/HTTP at runtime; the localhost exceptions are N/A here).

### Unique failure injections

1. **Swap an exact shard's bytes AFTER the index lookup resolves.** The shard's recorded `digest` and `range` are left untouched (so the lookup still resolves it — the lure), but `originalBytes` is replaced. Only the re-hash of what was actually READ catches this. → `HEAL_RESTORE_DIGEST_MISMATCH`, `restored.length === 0`, mode C, `insertable` empty.
2. **Swap a ledger record and fix up its own `bytesDigest`** so the per-record check passes. Only the span-level hash rejects it → `HEAL_RESTORE_DIGEST_MISMATCH`, nothing inserted. This is precisely the failure a per-record-only verifier would miss.
3. **Mutate a verified result in transit** (bytes replaced after `restoreSources` returned, and separately an in-place edit of the very buffer the result carries) → `verifyRestored` fails, `insertable` returns `[]`.
4. **Reader-touch proof for the bound.** `HEAL-LIMIT-002` is re-run with a reader whose `exactShards`/`ledgerEvents` getters **throw**; the restorer returns `HEAL_RESTORE_LIMIT` with the getters never invoked. An implementation that bounded inside the loop would report `SOURCE_MISSING` (or throw) instead.

### Mutation testing (tests proven non-vacuous)

To confirm the suite fails for the right reasons rather than passing vacuously, four targeted mutations were applied to the production sources, rebuilt, and reverted:

| Mutation | Result |
| --- | --- |
| Disable the span-count bound (`> RESTORE_LIMIT_SPANS * 100000`) | acceptance 28/31, restore.test 12/14 — **5 tests killed** |
| Skip the exact-shard re-hash (trust the recorded digest) | acceptance 30/31, restore.test 13/14 — **2 killed** |
| Remove the ledger seq sort (trust arrival order) | acceptance 30/31, restore.test 13/14 — **2 killed** |
| `verify.ts` skips the request cross-check | verify.test 6/9 — **3 killed** |

Every mutation was killed; the working tree was byte-compared against pre-mutation backups afterwards and confirmed identical.

## Commands and verbatim summaries

- `npm run build` → tsc clean (`vector-cortex-publish-acceptance: published 20 acceptance ... + 12 heal + ...` — the heal mirror rose from 5 to 12 files, picking up the VC6B runtime automatically).
- `node --test dist/vector-cortex/vc6b-acceptance.test.js` → `ℹ tests 31 / ℹ pass 31 / ℹ fail 0` (flag ON).
- `MEGACOMPACT_VC6B=0 node --test dist/vector-cortex/vc6b-acceptance.test.js` → `ℹ tests 31 / ℹ pass 31 / ℹ fail 0` (flag OFF, byte-identical).
- `node --test dist/src/vector-cortex/heal/restore.test.js` → `ℹ tests 14 / ℹ pass 14 / ℹ fail 0`.
- `node --test dist/src/vector-cortex/heal/verify.test.js` → `ℹ tests 9 / ℹ pass 9 / ℹ fail 0`.
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-restore.test.js` → `ℹ tests 4 / ℹ pass 4 / ℹ fail 0`.
- `node --test dist/vector-cortex/vc6a-acceptance.test.js` → `ℹ tests 25 / ℹ pass 25 / ℹ fail 0` (predecessor unaffected).
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).`
- `python3 scripts/regression_check.py --all` → `0 blocking (runtime high/critical) | 7 warning(s) (dev-only/moderate/low)`.
- `python3 scripts/regression_check.py --soft-as-hard --pre-commit` → `0 blocking (runtime high/critical) | 7 warning(s) (dev-only/moderate/low)` (no file over its soft limit).
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 548 fixtures canonical (548 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/vector-cortex-gen-fixtures.mjs` → `... + 15 restoration + 3 named restoration fixtures + 28 schemas + manifest` (idempotent; no churn on re-run).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; `✓ built in 2.15s`.
- `scripts/vector-cortex-scope-check.mjs VC6B HEAD` → all VC6B-authored file(s) inside Production ownership + allowed cross-cutting seams. (Residual: `package.json`/`package-lock.json` are reported only because HEAD is the v0.20.8 release commit, which touched those files; they are NOT modified in the VC6B working tree — `git status` is clean for them. Same benign residual VC6A recorded.)

## Evaluation

The acceptance aggregator proves the sprint's central claim — **restored bytes are the original bytes, or there are no bytes**. Every restored span across all 18 fixtures re-hashes to the digest the request pinned, and each is independently rebuilt from the decoded sources and compared verbatim (exact-shard payload, or the seq-sorted ledger concatenation) rather than merely "a result was produced". Invalid UTF-8 survives both tiers unnormalized (HEAL-018 exact, HEAL-025 ledger), which is the sharpest test of byte fidelity: any layer that decoded-and-re-encoded would corrupt those payloads and fail the digest.

The two exact tiers are genuinely independent and genuinely agree: the forced triad restores the same span through the shard index and through the ledger scan and asserts the outputs are byte-identical, while mode C proves the system omits-and-discloses rather than substituting derived text. The bounds are proven to precede the readers by construction (throwing getters), not merely by inspection. The digest contract holds against all three realistic tamper classes — a swapped shard file, a swapped-and-fixed-up ledger record, and a result mutated in transit — and `insertable`'s wholesale rule prevents splicing the good half of a partially-corrupt result into a reconstruction.

Flag-off parity: the restore and verify arithmetic is pure and produces identical results under `MEGACOMPACT_VC6B=0` (asserted over the entire fixture corpus, not a single row); the flag gates only the reporter and dashboard seam.

## Known findings / concerns

- **Ownership amendment (helpers + readers + reporter).** The spec's `Production ownership:` line named only `restore.ts` and `verify.ts`, but the sprint necessarily shipped `restore-types.ts` (the contract, which must precede the implementation), `restore-readers.ts` (split out to keep `restore.ts` under the 300-line soft limit), `restore-emit.ts` (task 5's reporter), and `_restore-fixture.ts` (fixture decoding, keeping the aggregator under the 600-line test limit). The line was amended to list all of them, following the VC6A precedent. Recorded as an amendment to `VC6B-source-restoration.md`.
- **Scope-check residual on HEAD release commit (OPEN, not a defect).** `scripts/vector-cortex-scope-check.mjs VC6B HEAD` lists `package.json`/`package-lock.json` as out-of-scope because HEAD is the v0.20.8 release commit and the gate runs against the commit range, not the uncommitted working tree. Those files are NOT modified by VC6B (`git status` clean for them). The gate will pass cleanly when run against the VC6B commit(s) after they land. Identical to the residual VC6A documented.
- **No durable restore store this sprint.** `GET /api/vector-cortex/restore` reports the enabled flag + mode + aggregate attempt/restored/missing/digest-rejection counts truthfully, but they are **ephemeral in-memory per-process counters** (currently zero-initialized), matching the VC4A–VC6A reader-only routes. `VectorCortexRestoreView` is the seam a future sprint populates with per-epoch event data once a durable heal store lands. Stated plainly so the dashboard never overclaims liveness.
- **Restoration is on-demand and stateless.** There is no restore runtime or background process; `restoreSources` is a pure function invoked per reconstruction. The dashboard aggregates are cumulative process counters for observability only, never presented as a live breaker.
- **`verify.ts`'s request cross-check is covered by the unit test, not the aggregator.** Mutation 4 (disabling the `wanted !== span.digest` branch) killed 3 tests in `verify.test.ts` but 0 in `vc6b-acceptance.test.ts` — the aggregator's fixtures never produce a result whose nodeId/digest diverges from the request, since `restoreSources` cannot generate one. This is expected (the branch defends against results assembled or mutated OUTSIDE the restorer, which is exactly the unit test's threat model), and the aggregator does exercise the same gate via its in-transit tamper injection. Noted so a future reader does not mistake the aggregator's coverage for total coverage of `verify.ts`.
