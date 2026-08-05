# VC8B Evidence

Status: pending independent reviewer attestation — all sprint gates green.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Goal recap

Bounded shadow adaptive policy + M7 pressure-v2 migration (VC8B) — a finite-action policy engine whose token budgets are clamped into a configured window after a pressure factor, wrapped in a shadow evaluator that is structurally incapable of mutating the live path, plus the M7 copy/validate/switch migration from legacy pressure labels to the v2 canonical five. VC8B ships five pure subsystems (none read the feature flag — only the emit seam is gated):

- **`PolicyDecisionV1` / `evaluatePolicy()`** — actions from a finite set (admit/dampen/defer/escalate/reject) chosen deterministically by the canonical pressure level. Budgets clamped into a configured window (`clampBudget`). Unknown pressure labels rejected as `POL_PRESSURE_UNKNOWN`, never coerced to a neighbour. Bad bounds rejected as `POL_BOUNDS_INVALID`. Pure, no flag read.
- **`ShadowResult` / `evaluateShadow()`** — hashes the prompt on entry, deep-copies all inputs via `copyPolicyInput`, evaluates each copy, re-hashes the prompt on exit. `liveMutations = promptUnchanged ? 0 : 1` — structurally always 0. Imports only `node:crypto` + `./policy.js` + `./types.js` (statically verified).
- **`M7 migratePressureV2()`** — copy/validate/switch pattern for pressure-v2. `m7Copy` is resumable per identity. `m7Switch` re-reads the host at switch time to catch post-copy label injection, THEN flips the pointer. An unknown label blocks the switch (`M7_PRESSURE_UNKNOWN`) and keeps the legacy pointer.
- **`policy-emit.ts`** — `reportShadowDecisionRecorded` + `reportPolicyActionRejected`, gated on `VC8B_ENABLED()`. `safe()` wrapper: broken telemetry never escapes.
- **`pressure-v2-types.ts` / `pressure-v2-ops.ts`** — the M7 migration types and operations, split to stay under the 300-line soft limit.

`MEGACOMPACT_VC8B` gate (default ON; `=0` -> byte-identical predecessor, VC8A). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/controller/` + `src/vector-cortex/migrations/`):
- `controller/types.ts` (196) — `PolicyDecisionV1`, `PressureV2`, `PRESSURE_LEVELS` (low/medium/high/ultra/mega), `POLICY_ACTIONS` (admit/dampen/defer/escalate/reject), `POLICY_REASONS`, `PolicyBounds`, `PolicyInput`, `ShadowMetrics`, `ShadowResult`, `ShadowRejection`, `POLICY_CONFORMANCE_IDS` (POL-001..025), `M7_CONFORMANCE_IDS` (M7-001..015), `POLICY_NAMED_FIXTURES`.
- `controller/policy.ts` (199) — `clampBudget` (NaN to min, infinities clamp), `validatePressureLabel` (throws `POL_PRESSURE_UNKNOWN`), `validateAction` (throws `POL_ACTION_FORBIDDEN`), `validateBounds` (rejects min>max, negative, non-finite), `evaluatePolicy` (validate -> pressure factor -> clamp), `isDecisionWithinBounds`. PRESSURE_FACTOR: low/medium=1, high=0.75, ultra=0.5, mega=0.25. PRESSURE_ACTION: low/medium=admit, high=dampen, ultra=defer, mega=reject.
- `controller/shadow.ts` (137) — `evaluateShadow`: hashes prompt on entry, deep-copies all inputs via `copyPolicyInput`, evaluates each copy, re-hashes prompt on exit, `liveMutations = promptUnchanged ? 0 : 1`. Imports only `node:crypto` + `./policy.js` + `./types.js` (statically verified by test).
- `controller/policy-emit.ts` (83) — `reportShadowDecisionRecorded` + `reportPolicyActionRejected`, gated on `VC8B_ENABLED()`. `safe()` wrapper.
- `migrations/pressure-v2-types.ts` (84) — `PRESSURE_V2_VERSION=2`, `PRESSURE_LEGACY_VERSION=1`, M7 fail codes, M7 IDs (M7-001..015), `M7Host` interface, `M7ValidateResult`.
- `migrations/pressure-v2.ts` (60) — delegate shell re-exporting from -types and -ops.
- `migrations/pressure-v2-ops.ts` (205) — `derivePressureDigest` (SHA-256 over length-prefixed fields), `mapPressureRow` (throws `M7_PRESSURE_UNKNOWN`), `allLabelsCanonical`, `m7Copy` (resumable per identity), `m7Verify` (label check + count check + digest check), `m7Switch` (re-reads host, re-validates, THEN flips pointer), `migratePressureV2` (copy -> catch -> switch).

Config:
- `src/config/vector-cortex.ts` — added `VC8B_ENABLED()` (default ON, `=0` byte-identical to VC8A).
- `src/config.ts` — re-exported `VC8B_ENABLED`.

Tests:
- `controller/policy.test.ts` (289) — POL-CLAMP-001, clamp boundaries, pressure validation, action validation, evaluatePolicy, invariant sweep, determinism, non-mutation.
- `controller/shadow.test.ts` (251) — POL-SHADOW-002, input copying, prompt immutability, no live capability (static import check), metrics, determinism.
- `migrations/pressure-v2.test.ts` (286) — M7 copy/validate/switch, failure injection (unknown after copy keeps old pointer), idempotent resume, empty store, NOT_ON_LEGACY.
- `controller/flag-parity-vc8b.test.ts` (149) — arithmetic parity ON vs OFF, event suppression OFF.
- `vc8b-acceptance.test.ts` (27) — delegate-shell listing siblings + run commands.

Dashboard:
- `api-contracts/vector-cortex-policy.ts` (47) — `VectorCortexPolicyView` (enabled, mode, shadowDecisions, clampedDecisions, rejectedInputs, liveMutations, pressureVersion, lastFailure, updatedAt).
- `routes-vector-cortex-policy.ts` (60) — GET /api/vector-cortex/policy (reader-only, counts + codes).
- `routes-vector-cortex-policy.test.ts` (118) — ON aggregate, OFF mode C, non-GET rejected, payload-free body.
- `route-dispatch.ts` — wired `handleVectorCortexPolicy`.
- `dashboard-client/src/types/vector-cortex-vc8.ts` — added `VectorCortexPolicyView`.
- `dashboard-client/src/types/vector-cortex.ts` — re-exported `VectorCortexPolicyView`.
- `dashboard-client/src/api/vector-cortex.ts` — `fetchVectorCortexPolicy()`.
- `dashboard-client/src/tabs/VectorCortexPolicyCard.tsx` (43) — VC8B shadow adaptive policy card.
- `dashboard-client/src/tabs/VectorCortexTab.tsx` — imported + rendered `VectorCortexPolicyCard`.
- `dashboard-client/src/tabs/useVectorCortexPoll.ts` — `fetchVectorCortexPolicy` + `policy` state.

Scripts:
- `scripts/gen-fixtures/adaptive-policy.mjs` (336) — 25 POL-001..025 (20 valid policy rows + 5 unknown-label rejections), 15 M7-001..015 (5 canonical migrations + 5 unknown rejections + multi-row + empty + resume + one-bad + inject-after-copy), 3 named (POL-CLAMP-001, POL-SHADOW-002, M7-PRESSURE-003). Mirrors PRESSURE_FACTOR/ACTION/reasonFor from policy.ts.
- `scripts/gen-fixtures/schemas.mjs` — added policy-decision, policy-shadow, pressure-v2 fixture schemas.
- `scripts/gen-fixtures/write.mjs` — wired adaptive-policy import + ADAPTIVE_DIR + fixture-writing loop + manifest extensions.
- `scripts/vector-cortex-publish-acceptance.mjs` — added controller/ subtree mirroring (nController).

## Fixtures and corpus digests

Conformance root: `conformance/vector-cortex/v2/adaptive-policy/`.

| ID | Kind | Assertion |
| --- | --- | --- |
| POL-001..POL-025 | policy-decision | Finite actions, bounded budgets, unknown-pressure rejection |
| M7-001..M7-015 | pressure-migration | Copy/validate/switch, unknown label rejection, idempotent resume |
| POL-CLAMP-001 | named | Budget clamped at max boundary |
| POL-SHADOW-002 | named | Shadow evaluator: liveMutations always 0 |
| M7-PRESSURE-003 | named | Unknown pressure blocks switch (M7_PRESSURE_UNKNOWN) |

## Gate results

- `npm run build` — PASS (tsc + Vite dashboard)
- `npx tsc --noEmit` — PASS
- `node --test dist/src/vector-cortex/vc8b-acceptance.test.js` (aggregator + siblings) — PASS (80/80)
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-policy.test.js` — PASS (4/4)
- `npm test` (full suite) — PASS (3159/3159, 0 failures)
- `npm run lint` — PASS (tsc + guardrails-scan + semantic-scan)
- `python3 scripts/regression_check.py --all` — PASS
- `node scripts/vector-cortex-conformance.mjs --check` — PASS (737 fixtures canonical)
- `cd extensions/dashboard-client && npx tsc --noEmit` — PASS
- `cd extensions/dashboard-client && npm run build` — PASS

## Rollback

`MEGACOMPACT_VC8B=0` selects mode C (fixed legacy thresholds), restores VC8A predecessor behavior. The policy/shadow/migration arithmetic still runs (pure) but no events are emitted and the dashboard reports `enabled:false` + mode C.
