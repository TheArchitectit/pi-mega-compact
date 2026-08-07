# CONFORM-HYGIENE — Conformance + docs hygiene: closure sprint

**Status:** planned | **Depends on:** VC6C-IMPL | **Phase:** CONFORM
**Flag:** none — this is a **pure-hygiene sprint** with NO runtime flag and NO runtime behavior change. The scanners (`scripts/stub-scan.mjs`, `scripts/mock-scan.mjs`) are additive CI/gate tools; they run in the gate, never at a runtime path. Use the sprint-level tracking marker `MEGACOMPACT_CONFORM_HYGIENE` (a docs/gate marker only, not an env flag) so `scripts/vector-cortex-docs-check.mjs`'s positive-flag line requirement passes; it is deliberately NOT wired into any runtime path and NOT added to `SETTINGS`.

## Goal and inputs/outputs

Close every conformance + docs gap raised by the 2026-08-05 stub/mock audit, and land the process scanners the audit's §9 recommends. This is **not a feature sprint** — it introduces no new runtime code path, no flag, no behavioral change to the encoder/recall/dashboard. It is pure closure: backfill or explicitly-document the missing conformance rows (Table 4), fix the two digest-skip sentinels (Table 2), register the two missing hard gates (Table 3), reconcile game-mode disposition (Table 6), add superseded-doc banners (Table 5-D), land the stub/mock scanners + PREVENT-STUB/PREVENT-MOCK/PREVENT-PLACEHOLDER/PREVENT-VERIFICATION-BYPASS guardrails (framework §3/§7, Table 9), and make docs-check compute fixture counts from the manifest, not literals (PREVENT-SPEC-DRIFT-001).

Production ownership: (amended per spec-staleness precedent — see deviation note below)
- `conformance/vector-cortex/v2/manifest.json` (ADDITIVE fixture rows + reservedRanges dispositions)
- `conformance/vector-cortex/v2/ledger/MIG-DOWN-002.json` (NEW — emitted ledger fixture)
- `conformance/vector-cortex/v2/setup-dashboard/SETUP-CORTEX-001.json` `SETUP-CORTEX-002.json` `SETUP-CORTEX-003.json` `SETUP-CORTEX-005.json` `SETUP-CORTEX-006.json` `SETUP-CORTEX-007.json` `SETUP-CORTEX-008.json` `SETUP-CORTEX-009.json` `SETUP-CORTEX-020.json` (RE-HASHED — HG-6/HG-7 blocker_ids added to canonical 6-item set; 014..019 + 023..029 documented reserved-unused in manifest reservedRanges, not emitted as fixtures)
- `src/vector-cortex/reconstruct/validate.ts` (PLACEHOLDER_DIGEST sentinel — task 2)
- `src/vector-cortex/reconstruct/_acceptance-helpers.ts` (digestOverride ?? PLACEHOLDER_DIGEST alignment — task 2)
- `src/vector-cortex/platform/_cross-language-fixture.ts` (commit fixture marker — task 2)
- `src/vector-cortex/setup-cortex-blockers-compute.ts` (HG-6/HG-7 registration — task 3; canonical source, extensions/dashboard-server/setup-cortex-blockers.ts re-exports)
- `extensions/dashboard-server/routes-setup-cortex.test.ts` (6-item blocker set assertion — task 3)
- `src/vector-cortex/vc9a-acceptance.test.ts` (6-item blocker set assertion — task 3)
- `docs/AGENT_GUARDRAILS.md` (version 1.3 → 1.4; four PREVENT rules table — task 4)
- `.guardrails/prevention-rules/pattern-rules.json` (four PREVENT-* entries, enabled:false — task 4)
- `.guardrails/prevention-rules/pattern-rules.schema.json` (rule_id pattern generalization — task 4)
- `scripts/stub-scan.mjs` (NEW scanner — task 5)
- `scripts/mock-scan.mjs` (NEW scanner — task 5)
- `src/vector-cortex/encoder/runtime.ts` `src/vector-cortex/encoder/heads.ts` `src/vector-cortex/encoder/calibrate.ts` `src/vector-cortex/encoder/runtime-stub.ts` (guardrails-allow annotations — task 6)
- `src/vector-cortex/prompt-dag/_acceptance-shuffle.ts` (guardrails-allow PREVENT-STUB-001: VC5A — task 6)
- `src/vector-cortex/residual/fixture-payload.ts` (guardrails-allow PREVENT-STUB-001: VC4B — task 6)
- `src/cache-stripe-impl.ts` `src/cache-stripe-score.ts` (guardrails-allow PREVENT-MOCK-001: hash-bag IS mode B — task 6)
- `src/embedder.ts` (guardrails-allow PREVENT-MOCK-001: TrigramEmbedder mode-B default — task 6)
- `extensions/mega-events/context-handler/afterCompact.ts` (guardrails-allow PREVENT-STUB-001: VC6C-IMPL — task 6)
- `scripts/vector-cortex-gen-assets.mjs` (guardrails-allow PREVENT-PLACEHOLDER-001: ML5-A — task 6)
- `package.json` (lint script wiring: stub-scan + mock-scan with --fail-on-unregistered — task 7)
- `scripts/vector-cortex-docs-check.mjs` (EXPECTED_SPRINTS bump + manifest-derived fixture count — task 8)
- `docs/game-mode-design.md` (superseded banner — task 10)
- `docs/specs/game-mode-sprint-plan.md` (superseded banner — task 10)
- `docs/vector-cortex/vc2-model-prep.md` (reference-only research-note banner — task 10)
- `docs/vector-cortex/retros/PC-RETRO.md` (NEW — task 11)
- `docs/vector-cortex/retros/VC9-RETRO.md` (NEW — task 11)
- `docs/vector-cortex/evidence/CONFORM-HYGIENE.md` (NEW — task 12)

**Deviation note (spec-staleness amendment, DASH-0B/0c precedent):** The original
ownership listed only 13 of the 41 touched files. The amendment adds the 28 files
the agent annotated with `// guardrails-allow` annotations (task 6 — the 8 existing
stub sites span 13 source files, not the 4 named in the original spec), the
pattern-rules JSON + schema (task 4's "also land in pattern-rules.json" clause),
the 9 re-hashed SETUP-CORTEX fixtures (blocker_ids changed), the 2 test files
updated for the 6-item blocker set, the 2 additional superseded-banner docs, the 2
retro artifacts (task 11), and `package.json` (task 7 lint wiring). No file outside
this amended set was touched. The deviation is documented in the evidence §6.

Inputs: the 2026-08-05 audit (Tables 1–9), the framework doc `docs/development-framework/SELF_IMPROVING_DEVELOPMENT.md` (§3 scanners, §7 guardrails table, §6 rollout map), and the current v2 manifest. Outputs: a manifest/fixture/evidence tree that is internally consistent and reviewer-attestable, two gate scanners wired into CI, the two sentinels fixed, HG-6/HG-7 surfaced, and a reviewer-accepted CONFORM-HYGIENE evidence record.

## Numbered implementation tasks

1. **Backfill / disposition the Table 4 conformance gaps.** (a) `MIG-DOWN-002` — emit `conformance/vector-cortex/v2/migrations/MIG-DOWN-002.json` OR mark the ID intentionally unused with a documented decision in the evidence. (b) `SETUP-CORTEX 014-019` (6 IDs) + `023-029` (7 IDs) — emit into `setup-dashboard/` OR document as reserved-unused in the evidence. (c) `EVAL-BUCKET-001` / `EVAL-ORDER-003` / `EVAL-REDACT-002` — register fixture rows in the manifest under the existing `eval-fixture.schema.json`, OR document them as prose-IDs (projection guards referenced by `VC0A.md`/evidence records, not literal fixture rows). All choices ADDITIVE to `manifest.json`.
2. **Fix the two digest-skip sentinels (Table 2).** (a) `src/vector-cortex/reconstruct/_acceptance-helpers.ts:342` — replace `digestOverride ?? "0"` so it aligns with the `validate.ts` producer's convention (no silent per-shard-digest bypass); (b) `src/vector-cortex/platform/_cross-language-fixture.ts:72` — replace `commit: "0".repeat(40)` with a real commit hash or an explicit fixture marker, resolving the "no mocks, no stubs" header contradiction.
3. **Register HG-6 / HG-7 in the dashboard blockers manifest (Table 3).** Additive rows in `extensions/dashboard-server/setup-cortex-blockers.ts` (`setup-cortex-blockers` is the single canonical source; no string literals in the route file): HG-6 "4 threads mandatory for 512-token p95 per vc2-model-prep §6 row 6" and HG-7 "model-card / dataset-manifest / frozen calibration per vc2-model-prep §6 row 7", both `status:"open"` so they surface in the Setup Cortex blockers card.
4. **Amend `docs/AGENT_GUARDRAILS.md` (1.3 → 1.4, framework §7).** Add the `### PREVENT-STUB / PREVENT-MOCK rules` table with the four PREVENT rules (PREVENT-STUB-001 error; PREVENT-MOCK-001 error; PREVENT-PLACEHOLDER-001 error; PREVENT-VERIFICATION-BYPASS-001 critical) verbatim from framework §7, and bump the Version line. **Also land the four PREVENT-* rules as entries in `.guardrails/prevention-rules/pattern-rules.json`** (framework §2/§7) so `scripts/guardrails-scan.mjs` reads them — this step belongs to this sprint, not the AGENT_GUARDRAILS.md edit alone.
5. **Land the scanners (framework §3, Table 9).** Add `scripts/stub-scan.mjs` (flags runtime stubs/placeholders in `src/`+`extensions/` and verification-skip sentinels, unless a `// guardrails-allow PREVENT-STUB-001: <closure sprint id>` exists) and `scripts/mock-scan.mjs` (flags `Math.random()`/seeded PRNG + hash-as-embedding markers outside tests, unless a `// guardrails-allow PREVENT-MOCK-001: <reason — accuracy-floor acknowledged>` exists). Wire both into the gate (task 6).
6. **Register all 8 existing stub sites (audit Table 1) as tracked placeholders.** Each gets an inline `// guardrails-allow PREVENT-STUB-001: <closure-sprint>` annotation naming its closure sprint: `runtime.ts:107`, `heads.ts:11,48`, `calibrate.ts:87,126` → **ML5-A**; `afterCompact.ts:282,304` → **VC6C-IMPL** (this is a post-hoc registration — the closure sprint will already have landed or is landing in parallel; annotate accordingly); `backfill.ts:136` → **ML5-B**; `validate.ts:65` + `_acceptance-helpers.ts:342` → **CONFORM-HYGIENE** (fixed this sprint); `vector-cortex-gen-assets.mjs` (42-byte `model.onnx`) → **ML5-A**; `dashboard-snapshot.ts:163` → **VC6C/ML5-D**.
7. **Wire stub-scan + mock-scan into the gate.** Add both to `npm run lint` (or a new gate step) so a NEW stub or mock in `src/`/`extensions/` without an allow-annotation fails at the sprint boundary, not months later (framework §5 "fail-on-unregistered").
8. **Make docs-check compute fixture counts from `manifest.json`, not literals.** Update `scripts/vector-cortex-docs-check.mjs` to derive the fixture count and reserved-range closure from the manifest (killing PREVENT-SPEC-DRIFT-001 — the exact drift class PC-D's evidence had to correct manually), and bump `EXPECTED_SPRINTS` (task 9).
9. **Game-mode disposition (Table 6).** Confirm the GM-B/C/D rows: if superseded by `docs/game-mode-design.md` §10 ("Future (out of scope for v1)"), mark them resolved-by-supersede in the evidence; otherwise give them an explicit traceable home (a GM phase spec or transfer into this sprint). The cited plan file `docs/plans/vc0p-game-mode-design-2026-08-05.md` does not exist — document this non-invention in the evidence.
10. **Superseded banners (Table 5-D).** Add a "superseded by / status: reference-only" banner to stale design docs (e.g. the game-mode family, `vc2-model-prep.md` as a research note vs the shipped contract) where current-source-of-truth is ambiguous.
11. **Land the phase RETRO.md artifacts (framework §5/§6).** Add a "retro" task per phase — `PC` and `VC9` both get `docs/vector-cortex/retros/PC-RETRO.md` and `VC9-RETRO.md` listing (a) every defect found after the phase landed, (b) which new PREVENT rule now covers it, (c) the corrective action that landed. ML5-A gets its own retro at phase-end. The retro artifact is the self-correction loop closing: the audit's defects are the seed, every phase leaves a record, and PREVENT coverage grows as a result.
12. **Evidence + closure.** Write `docs/vector-cortex/evidence/CONFORM-HYGIENE.md` recording every Table 4 closure decision, both sentinel fixes, HG-6/HG-7 registration, the GM disposition, the scanner-gate wiring, the guardrails amendment, the pattern-rules entries, and the retro artifacts; get it reviewer-accepted.

## Failure triad and independence

A **emission closure** — the missing Table 4 fixture rows (MIG-DOWN-002, SETUP-CORTEX 014-019 + 023-029, EVAL trio) are either emitted and registered in the manifest or documented as intentional-unused/prose-IDs; the manifest, conformance check, and evidence are mutually consistent. B **sentinel + scanner closure** — the two digest-skip sentinels are fixed and the scanners + guardrails amendment land; `stub-scan`/`mock-scan` clean runs on the whole tree. C **hard-gate + docs closure** — HG-6/HG-7 are registered in the blockers manifest, the superseded banners are applied, and `EXPECTED_SPRINTS`/fixture counts are computed from the manifest. Each arm exercises independent files and gates (manifest+conformance / scanners+guardrails / dashboard-blockers+docs-check), so a failure in one cannot masquerade as closure in another. Common cooldown/spool/restart/clock rules remain normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md). No runtime code path changes in any arm — shutting down a scanner cannot change extension behavior.

## Tests, fixtures, and assertions

Fixture closure (Table 4) — all additive to `conformance/vector-cortex/v2/`:
- `MIG-DOWN-002`: a migration-family downgrade fixture under `conformance/vector-cortex/v2/migrations/` (schema `minhash-migration.schema.json`, matching the M4 family) OR the ID is documented intentional-unused in the evidence.
- `SETUP-CORTEX-014..019` + `SETUP-CORTEX-023..029`: 13 IDs under `setup-dashboard/` (schema `setup-cortex-fixture.schema.json`) OR documented reserved-unused in the evidence, with the reserved range `001..039` fully accounted for in the manifest.
- `EVAL-BUCKET-001` / `EVAL-ORDER-003` / `EVAL-REDACT-002`: registered as fixture rows under `evaluation/` (schema `eval-fixture.schema.json`) OR documented as prose-IDs in the evidence.

Sentinel assertions (Table 2):
- `_acceptance-helpers.ts:342` no longer defaults to a `"0"` digest that silently skips per-shard verification — the digest is produced consistently with `validate.ts`.
- `_cross-language-fixture.ts:72` no longer carries `commit: "0".repeat(40)` — a real commit hash or an explicit fixture marker, so the "no mocks, no stubs" header claim holds.

Scanner + gate assertions (framework §3/§5, Table 9):
- `scripts/stub-scan.mjs` and `scripts/mock-scan.mjs` exist, run clean on the whole tree, and are wired into the gate.
- All 8 Table 1 stub sites carry a `// guardrails-allow PREVENT-STUB-001: <closure-sprint>` annotation (or are already closed), so a `--fail-on-unregistered` run passes.
- `docs/AGENT_GUARDRAILS.md` is Version 1.4 and carries the four-PREVENT rules table.

Docs/drift assertions (PREVENT-SPEC-DRIFT-001):
- `scripts/vector-cortex-docs-check.mjs` derives fixture counts and reserved-range closure from `manifest.json` (no literal fixture-count constants that can drift like PC-D's), and `EXPECTED_SPRINTS` is bumped.

Dashboard assertion:
- `extensions/dashboard-server/setup-cortex-blockers.ts` lists HG-1, HG-3, HG-4, HG-5, HG-6, HG-7 — the Setup Cortex blockers card surfaces all open gates.

No acceptance aggregator test file is required for this pure-hygiene sprint; the closures are verified by the project gates (below) and reviewer reading. Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state change and no runtime migration** (the sentinel fixes alter only how a digest/fixture value is produced, not stored data; the conformance additions are additive rows, never a schema change). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the new fixtures carry synthetic/aggregate data only, never real payload bytes (EVAL-REDACT-002 discipline). Dashboard: additive blockers-manifest rows only (HG-6/HG-7) — no route, contract, or client change, so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT a mandatory gate for this sprint.

Rollback: none required — this is an additive hygiene sprint. Disabling a scanner or reverting a banner/evidence edit restores prior state with no behavioral delta, since nothing in the runtime path changes. The two sentinel edits are the only production-source touches and are independently revertible with zero observable-runtime impact (they align producers, never delete a check).

## Exit evidence

Run exact project gates: `npm run build`, `npm test`, `npm run lint` (now including stub-scan + mock-scan), `node scripts/stub-scan.mjs --fail-on-unregistered`, `node scripts/mock-scan.mjs --fail-on-unregistered`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs CONFORM-HYGIENE <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs CONFORM-HYGIENE`, `git diff --check`. No permissive globs or warning-only scans count.

This sprint adds a 39th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 38 to 39 (after VC6C-IMPL's 37→38).
