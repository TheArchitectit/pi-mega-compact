# ENC-0d — Promotion gate over real trained assets + atomic swap

**Status:** planned | **Depends on:** ENC-0c | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0D`, defined in `src/config/vector-cortex-enc0d.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0D=0` disables and must be byte-identical to the predecessor — the promotion gate accepts no candidate and performs no swap, the shipped manifest stays at the ENC-0c survivor, and no promote/rollback events are emitted. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Turn the ML5-E promotion gate into the real-asset promotion path.** `scripts/ml5/promotion-gate.mjs` already exists (ML5-E) and evaluates five-head thresholds + held-out beat; this sprint extends it to accept **`{color}` real candidate manifests** (the ENC-0c trained head weights + the ENC-0b trunk, staged under `~/.pi/mega-compact-encoder/candidates/`), perform an **atomic asset swap with digest verification**, and **roll back to the previous asset on qualification failure** — all emitting structured events to the monitoring `events.log`. The prior asset is never lost: the manifest stays append-only (ML5-E precedent), so a regressed promoted asset is restorable by SHA-256 in O(1).

The promotion gate is the operator UX seam the ML5-D "Improve Cortex" flow already drives; ENC-0d makes that flow promote **real trained assets** instead of empty candidates. The candidate lifecycle: `{color}` (a promotion color, e.g. `green`/`red`) comes from the gate qualification — a "green" promotion atomically swaps the shipped manifest to the real trained asset and flips the runtime into qualified mode A; a "red" qualification emits `demoted_new_asset` and keeps the prior asset live.

Outputs: `PromotionV1` ledger rows (type exists in `src/vector-cortex/encoder/promotion.ts` from ML5-E), the `vector_cortex_asset_promoted`, `vector_cortex_asset_demoted`, and `vector_cortex_asset_rollback_back` events, and the atomic swap performed only when the digest-verified candidate is green.

Production ownership: `src/config/vector-cortex-enc0d.ts`; `src/config/vector-cortex.ts`; `src/config.ts`; `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts`; `src/vector-cortex/encoder/promotion.ts`; `src/vector-cortex/encoder/promotion-emit.ts`; `scripts/ml5/promotion-gate.mjs`; `scripts/ml5-enc/gen-fixtures.mjs`; `src/vector-cortex/enc0d-acceptance.test.ts`; `conformance/vector-cortex/v2/encoder-promotion/*`; `conformance/vector-cortex/v2/schemas/encoder-promotion-fixture.schema.json`; `docs/vector-cortex/evidence/ENC-0d.md`; `docs/vector-cortex/sprints/ENC-0d-nightly-promotion-real-assets.md (this file)`. Notes: the promotion-gate script evolves to accept color-tagged real candidate manifests (the trained head weights plus the trunk) with digest verification of every staged byte before any swap, atomic swap, and rollback-to-previous on qualification failure; promotion.ts gains the color field and the assetDigestStack on PromotionV1 plus the pure atomic swap and rollback helpers (no delegate split was needed — the file holds at ~226 lines under the 300 soft cap); promotion-emit.ts is the new append-only event writer for the promote, demote, and rollback events onto the monitoring log, non-fatal; the encoder-promotion directory holds fixtures ENC-PROMO-001 through ENC-PROMO-006; the v2 manifest registration bump is cross-cutting.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0D` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0d.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = no candidate accepted, no swap, no events.
2. Extend `src/vector-cortex/encoder/promotion.ts`: `PromotionV1` gains `{ color:"green"|"red", assetDigestStack: string[] }` (the LIFO of shipped asset digests for O(1)-by-sha256 rollback); keep the append-only manifest invariant. Use a delegate-shell split (`promotion-rollback.ts` sibling) so promotion.ts stays ≤ 300.
3. Create `src/vector-cortex/encoder/promotion-emit.ts`: `appendPromotionEvent(kind, fields)` writing `vector_cortex_asset_promoted` / `vector_cortex_asset_demoted` / `vector_cortex_asset_rollback_back` JSON lines to the monitoring `events.log` via the existing `appendEvent` seam. Non-fatal; never breaks the agent loop.
4. Evolve `scripts/ml5/promotion-gate.mjs`: accept a `{color}` candidate manifest; **digest-verify every staged byte** (trunk model.onnx + tokenizer + the five head weights) against the candidate's sha256 before ANY swap; on green → atomic swap of the shipped `assets/vector-cortex/encoder-v1/` manifest to the candidate (write-temp-then-rename, never a partial state) + emit `vector_cortex_asset_promoted`; on red or any verification failure → keep the prior asset live, emit `vector_cortex_asset_demoted`. Flag-off → exit 0, no swap, no events (byte-identical predecessor).
5. Add the rollback: a later week-N+1 gate that scores a previously-promoted asset worse calls the atomic digest-swap-rollback that restores the **previous** asset SHA-256 from `assetDigestStack` and emits `vector_cortex_asset_rollback_back` — no partial state, no lost evidence.
6. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-PROMO-001..006`, register them + owner `ENC-0d` in the v2 manifest against a new `schemas/encoder-promotion-fixture.schema.json`; manifest bump is cross-cutting.
7. Add the sprint acceptance aggregator `src/vector-cortex/enc0d-acceptance.test.ts`, then evidence `ENC-0d.md` recording one green promote + one rollback round-trip on the operator device.

## Failure triad and independence

A green promotion: a digest-verified `{color:"green"}` candidate atomically swaps the shipped manifest and emits `vector_cortex_asset_promoted`; the runtime now serves the trained asset (fixtures 501; ids use the `ENC-PROMO-` prefix). B red qualification: a `{color:"red"}` candidate (or a five-head/holdout miss) is not swapped; the prior asset stays live and `vector_cortex_asset_demoted` is emitted (fixture 502). C digest-failure rollback-preservation: a candidate whose staged bytes fail sha256 verification performs NO swap, preserves the prior asset byte-for-byte, and emits a demotion (fixtures 503–504). The append-only stack + rollback are pinned by 505 (a regressed promoted asset restores the previous `assetDigestStack` entry with no partial state), and flag-off byte-identity by 506 (`MEGACOMPACT_ENC_0D=0` accepts nothing, swaps nothing, emits nothing). A is produced by the green swap; B by the red path; C purely by the digest-verification gate. `MEGACOMPACT_ENC_0D=0` is byte-identical to the ENC-0c survivor. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-promotion/`. Schema: `schemas/encoder-promotion-fixture.schema.json` (new sibling).

- `ENC-PROMO-001: green digest-verified candidate -> atomic swap + vector_cortex_asset_promoted`.
- `ENC-PROMO-002: red candidate (threshold/holdout miss) -> no swap, prior asset live, vector_cortex_asset_demoted`.
- `ENC-PROMO-003: one-byte staged model.onnx mutation -> sha256 fail -> no swap, no partial state`.
- `ENC-PROMO-004: digest-mismatched head weights -> no swap, prior asset preserved byte-for-byte`.
- `ENC-PROMO-005: regressed promoted asset -> atomic rollback to previous assetDigestStack entry (O(1) by sha256)`.
- `ENC-PROMO-006: flag-off -> candidate accepted by nothing, no events, byte-identical predecessor`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0d-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/src/vector-cortex/enc0d-acceptance.test.js
```

Expected assertions: all `ENC-PROMO-001..006` rows registered with algorithm `encoder-promotion` against the `encoder-promotion` schema, expected `ok`; aggregator flag-agnostic. Gate unit assertions: swap is temp-write-then-rename (never in-place partial); the append-only manifest grows on promote, never overwrites; the authority stack keeps the prior digest; every event is a JSON line `{ts,event}` on the monitoring events.log. Unique failure injection: a candidate that is green on heads but has a one-byte-truncated `model.onnx` forced `sha256` mismatch — the gate must refuse the swap AND leave the prior manifest byte-identical (a mutated shipped manifest is a gate failure, not a silent partial swap). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0D=0 node --test dist/src/vector-cortex/enc0d-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: no payload leakage — promotion events carry digests/colors/verdicts only, never message content (EVAL-REDACT-002); zero network (the gate reads/writes local files only, PREVENT-PI-004). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** The promotion gate swaps `assets/vector-cortex/encoder-v1/` manifest entries (append-restorable by sha256) and writes ledger rows + events; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) §fixtures-synthetic; the gate handles digest-verified model artifacts and emits color/digest/verdict events, never exact ledger bytes or user message content. Dashboard: **no changes** — promotion remains driven by the existing ML5-D "Improve Cortex" operator flow; this sprint touches no `extensions/` dashboard files (`promotion.ts`/`promotion-emit.ts` are `src/`), so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. Rollback sets `MEGACOMPACT_ENC_0D=0`; the gate accepts nothing and the shipped manifest stays at the ENC-0c survivor, byte-identical, without deleting candidates or evidence. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/src/vector-cortex/enc0d-acceptance.test.js
MEGACOMPACT_ENC_0D=0 node --test dist/src/vector-cortex/enc0d-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0d <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0d
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-0d.md` records the operator-device round-trip: one green promotion into `assets/vector-cortex/encoder-v1/` and one rollback back to the previous stack entry, plus the three event lines. No dashboard client or server files are touched.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
