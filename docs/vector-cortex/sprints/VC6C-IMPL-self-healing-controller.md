# VC6C-IMPL — Self-healing controller: production gap detection + rebuild wiring

**Status:** planned | **Depends on:** VC6C | **Phase:** VC6C
**Flag:** `MEGACOMPACT_VC6C` (already defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, already in the dashboard `VECTOR_CORTEX_SETTINGS` as a boolDirect toggle, default ON). This implementation sprint does NOT add a new flag — it makes the existing `VC6C_ENABLED()` gate drive real gap detection/rebuild instead of the placeholder emit. `MEGACOMPACT_VC6C=0` must remain byte-identical to the predecessor (the placeholder `reportRepairPlanned` continues firing with the existing hardcoded shape; rebuild is a no-op).

## Goal and inputs/outputs

This is the **implementation sprint** that fulfills the existing [VC6C spec](../sprints/VC6C-self-healing-controller.md) (whose design completes at status "next"). It resolves the 2026-08-05 stub/mock audit **Table 5-A status contradiction** — the existing VC6C evidence claims "implementer-complete" while the spec still reads "next" — by making the implementation **real and reviewer-attestable**: the two placeholder emit blocks in the production compact handler are replaced with genuine post-compact gap detection that drives the repair pipeline, and the VC6C status is reconciled.

**Stub being closed (audit Table 1, stub 4):**
- `extensions/mega-events/context-handler/afterCompact.ts:282` — `// event counts move; real gap detection/rebuild is a future sprint.`
- `extensions/mega-events/context-handler/afterCompact.ts:304` — `// VC6C: repair-planner placeholder (no real gap detection yet).` Emits `reportRepairPlanned` with hardcoded `backoffMs:0, gapSize:compactedFrom`.

Both are replaced by a real controller drive: after a compact, compare each derived subsystem's **pre/post compact chunk counts** against the durable authority high-water, and when a real gap exists plan + execute an atomic rebuild through `repair-plan.ts` / `rebuild.ts`. When no real gap exists, emit nothing (no rebuild without a real gap — VC6C-IMPL-006). Rate-limit to one rebuild per subsystem per 5 min with deterministic exponential backoff, per the existing VC6C design.

The existing `src/vector-cortex/heal/` modules (`controller.ts`, `rebuild.ts`, `repair-types.ts`, `repair-emit.ts`) **already ship the pure gap-detection / copy-verify-switch / backoff primitives** (implemented by the VC6C track, 74 tests passing) but are **not wired into the production compact path** — which is exactly why the audit still classes the handler as a placeholder. This sprint owns the production seam that makes the controller real.

Production ownership:
- `extensions/mega-events/context-handler/afterCompact.ts` (REPLACES the two placeholder blocks at :282,:304 with the real controller drive)
- `extensions/mega-events/context-handler/controller.ts` (NEW — gap detection comparing pre/post compact chunk counts per subsystem)
- `src/vector-cortex/reconstruct/repair-plan.ts` (NEW — `RepairPlanV1` / `RepairEventV1` production types + plan builder)
- `src/vector-cortex/reconstruct/rebuild.ts` (NEW — atomic pointer switch via manifest digest swap, matching the ML5-E rollback pattern)
- `src/vector-cortex/vc6c-impl-acceptance.test.ts` (NEW — acceptance aggregator)
- `src/vector-cortex/heal/vc6c-impl-acceptance.test.ts` (NEW — the VC6C-IMPL fixture suite)
- `src/vector-cortex/heal/_vc6c-impl-fixture.ts` (NEW — self-healing/ fixture loader)
- `extensions/mega-events/context-handler/controller.test.ts` (NEW — production seam tests)
- `conformance/vector-cortex/v2/self-healing/` (NEW — VC6C-IMPL-001..006 fixtures, reserved range)
- `scripts/vector-cortex-gen-fixtures-vc6c-impl.mjs` (NEW generator)
- `scripts/vector-cortex-docs-check.mjs` (EXPECTED_SPRINTS 37→44, EXPECTED_PHASES 10→11 — authoritative bump to the on-disk sprint/phase count; see the evidence note)
- `scripts/vector-cortex-publish-acceptance.mjs` (ACCEPTANCE_RE broadened to allow hyphens so `vc6c-impl-acceptance.test.js` mirrors)
- `docs/vector-cortex/evidence/VC6C-IMPL.md` (NEW)
- `docs/vector-cortex/evidence/VC6C.md` (reconciled — real implementation landed via VC6C-IMPL; attestation cleared)
- `docs/vector-cortex/sprints/VC6C-self-healing-controller.md` (status bump: "next" → "implementation-complete" once VC6C-IMPL lands)

Inputs: the existing VC6C design spec (accepted), the pure heal primitives in `src/vector-cortex/heal/`, the compact result (`ran.result`) already available in `afterCompact.ts`. Outputs: real per-compact gap detection + atomic rebuild wired into production, six conformance fixtures, and a reviewer-attested evidence record resolving Table 5-A.

## Numbered implementation tasks

1. Add `RepairPlanV1` / `RepairEventV1` production types + plan builder in `src/vector-cortex/reconstruct/repair-plan.ts` (new). These are the production-facing shape the handler emits; the pure `heal/repair-types.ts` contract stays the canonical design carrier and `repair-plan.ts` maps a compact result into a plan (subsystem, `[seqStart, seqEnd]` range, generation, backoff).
2. Create `extensions/mega-events/context-handler/controller.ts` (new): `detectPostCompactGaps(left, right)` — compare the pre-compact and post-compact per-subsystem chunk counts against the durable authority high-water; return the set of subsystems whose derived high-water fell behind authority. Pure and `nowMs`-injected (fake-clock fixtures).
3. Create `src/vector-cortex/reconstruct/rebuild.ts` (new): atomic rebuild of a planned range into a new generation, verify the root manifest digest is a strict successor, then swap the pointer in a single atomic commit (manifest digest swap — mirrors the ML5-E rollback pattern). Failed verification keeps the old pointer and **deletes no evidence**.
4. Replace the two placeholder blocks in `extensions/mega-events/context-handler/afterCompact.ts` (:282 and :304) with the controller drive: call `detectPostCompactGaps`, and only when a real gap exists route through `repair-plan.ts` → `rebuild.ts` → `reportRepairPlanned`/`reportRepairPointerSwitched`/`reportRepairBackoff`. When no gap exists, emit nothing. Hardcode nothing — `backoffMs` and `gapSize` come from the plan, not literals.
5. Rate-limit to one rebuild per subsystem per 5 min (`REPAIR_RATE_LIMIT_MS`, boundary exclusive) with deterministic exponential backoff (`30s * 2^attempt`, 15 min cap, ±10% jitter derived from SHA-256 of subsystem+attempt, never `Math.random`) — reuse the existing heal primitives, which already enforce these rules.
6. Add `scripts/vector-cortex-gen-fixtures-vc6c-impl.mjs` emitting `VC6C-IMPL-001..006` into `conformance/vector-cortex/v2/self-healing/`, register them + owner `VC6C-IMPL` in the v2 manifest, bump `EXPECTED_SPRINTS` 37→38 in `scripts/vector-cortex-docs-check.mjs`, add the acceptance aggregator `src/vector-cortex/vc6c-impl-acceptance.test.ts`, then evidence `VC6C-IMPL.md`; bump the existing VC6C spec status "next" → "implementation-complete" and get `evidence/VC6C.md` reviewer-attested (clearing the "Not yet attested — pending independent reviewer" flag, audit Table 5-A).

## Failure triad and independence

A **targeted rebuild**: only the planned `[seqStart, seqEnd]` range is rebuilt into a new generation, reusing the prior generation elsewhere (cheap, incremental; requires a healthy prior generation). B **full deterministic rebuild**: the whole subsystem is re-derived from the byte ledger sharing no index, no prior generation, no incremental state (independent assets — a corruption or bug breaking A cannot break B the same way). C **disable derived state**: no rebuild, `semanticLossStated:true`, the subsystem serves nothing rather than something stale. Each arm uses independent algorithms/assets/indexes. Authority is never mutated — the controller has no write path to the durable authority, and an authority outage freezes the derived high-water (a frozen frontier is CORRECT, not a gap to chase). Common cooldown/spool/restart/clock rules remain normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/self-healing/`. Schema: `schemas/vc-fixture.schema.json` is NOT present in the tree, so the v2 standard for this domain is reused — the existing `schemas/healing-controller-fixture.schema.json` (the VC6C heal seam's schema), keeping the healing domain on one canonical schema.

- `VC6C-IMPL-001: gap detection triggers rebuild` — a post-compact chunk-count delta behind the authority high-water yields a non-empty plan and a rebuild executes.
- `VC6C-IMPL-002: rate-limit 5min backoff` — a second rebuild inside the 5-min `REPAIR_RATE_LIMIT_MS` window is suppressed (boundary exclusive).
- `VC6C-IMPL-003: atomic pointer switch` — a verified new-generation root digest flips the pointer exactly once; a failed verification keeps the old pointer and retains evidence.
- `VC6C-IMPL-004: RepairPlanV1 shape` — `{ subsystem, range:[seqStart,seqEnd], generation, backoffMs }` with exact plan order preserved from input.
- `VC6C-IMPL-005: RepairEventV1 emission` — `vector_cortex_repair_planned` / `_pointer_switched` / `_backoff` emitted with subsystem/generation/timings/codes only, never rebuilt bytes or user-content digests.
- `VC6C-IMPL-006: no rebuild without a real gap` — level-with-authority (or ahead) subsystems emit nothing and rebuild is a no-op.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc6c-impl-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc6c-impl-acceptance.test.js
```

Exact flag-off comparison: `MEGACOMPACT_VC6C=0 node --test dist/vector-cortex/vc6c-impl-acceptance.test.js` — the placeholder `reportRepairPlanned` firing with the existing hardcoded shape (`backoffMs:0, gapSize:compactedFrom`) must be byte-identical to the predecessor and rebuild is a no-op. Expected assertions: all `VC6C-IMPL-001..006` rows registered against the `self-healing` seam; 001 triggers, 002 rate-limits, 003 switches-atomically, 004/005 pin the V1 shapes, 006 proves no-rebuild-without-real-gap. Invariant: authority is never mutated; pointer generations strictly increase; a frozen frontier is never chased. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — derived pointer generations only**; no schema/state change to the durable authority (the controller compares high-waters without writing authority). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the emitted repair events contain subsystem names, generation numbers, timings, and codes only — never rebuilt bytes or a root/digest of user content. Dashboard: no new endpoint (the existing `GET /api/vector-cortex/repair` reader-only view already aggregates repair counters; the repair card is unaffected by this flag-first wiring change — no client/component/route file is touched, so the dashboard-client typecheck/build is NOT a mandatory gate for this sprint).

Rollback sets `MEGACOMPACT_VC6C=0`: the placeholder emit continues firing with the existing hardcoded shape, rebuild is a no-op, and behavior is byte-identical to the predecessor — without deleting evidence. The existing VC6C design guarantees no authority writes, so rollback touches only the derived seam.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc6c-impl-acceptance.test.js`, `MEGACOMPACT_VC6C=0 node --test dist/vector-cortex/vc6c-impl-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs VC6C-IMPL <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs VC6C-IMPL`, `git diff --check`. No permissive globs or warning-only scans count. Review of VC6C-IMPL must also re-audit `extensions/mega-events/context-handler/afterCompact.ts` to confirm neither placeholder block (:282 or :304) remains.

This sprint adds one sprint file (`VC6C-IMPL-self-healing-controller.md`). `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped to 44 and `EXPECTED_PHASES` to 11 — the authoritative version on the on-disk count (my branch was created after the docs commit that landed ML5-A..E + CONFORM-HYGIENE + the ML5 phase doc, so the count was already 44 sprints / 11 phases when this sprint began; the one authoritative bump makes the constant match reality, the same rationale as the PC-D spec-drift precedent).
