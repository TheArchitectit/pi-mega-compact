# VC7C Evidence

Status: pending independent reviewer attestation — all sprint gates green (tsc, conformance, guardrails, regression, docs-check). The flag-off parity fix (bare-hex assertion in `flag-parity-vc7c.test.ts`) was applied; `deriveRequestHashV2` returns BARE lowercase hex per the VC5B convention.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Goal recap

Cache diagnostics and breakers (VC7C) — completes the M5 request-hash-v2 migration (VC7B did copy/validate; VC7C does the SWITCH) and adds cache miss-classification diagnostics and cache-level breakers. VC7C ships three pure subsystems (none read the feature flag — only the emit seam is gated):

- **`CacheDiagnosticV1` / `classifyMiss()`** — given a `MissObservation`, returns exactly ONE `MissClass` via an exclusive cascade: profile -> range -> dependency -> request -> generation -> unknown. "Absence is not a mismatch": a cold key (null cached fields) classifies `unknown`, never `profile`. The evidence is payload-free (booleans + integer counts). `isTransientMiss()` marks profile + generation as self-healable.
- **`cache/breaker.ts`** — composes VC0C's `createBreaker` (no parallel state machine). `shouldBlockServe(missClass)` blocks any miss that is not `unknown`. `decideCacheServe(missClass, breaker)` returns `{block, fallbackMode}` honoring the triad's own verdict: OPEN_C / MANUAL_HALT wins over B.
- **M5 switch (`migrateRequestHashV2`)** — completes the copy/validate/switch contract. `m5Switch()` checks `NOT_ON_LEGACY`, re-runs `m5Verify()`, checks `detectCollision()` against FRESH host state, then flips the active pointer to v2. `M5_REQUEST_HASH_COLLISION` blocks the switch. The M6 `invalidationKey` is consumed.

`MEGACOMPACT_VC7C` gate (default ON; `=0` -> byte-identical predecessor, VC7B). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/`):
- `cache/diagnostics-types.ts` (87) — `MissClass`, `MissEvidence`, `CacheDiagnosticV1`, `MissObservation`, `CACHE_DIAGNOSTIC_IDS` (CACHE-016..030), `CACHE_DIAGNOSTIC_NAMED_IDS` = ["CACHE-MISS-001","CACHE-STALE-003"]. Digest conventions: `coveredDigest` = `sha256:`-prefixed; `requestDigest` = BARE hex.
- `cache/diagnostics.ts` (114) — `collectEvidence`, `classFor` (exclusive cascade), `classifyMiss`, `isTransientMiss`. Pure, no flag read.
- `cache/diagnostics-emit.ts` (90) — `reportCacheMissClassified` + `reportCacheServeBlocked`, gated on `VC7C_ENABLED()`. Payload-free. `safe()` wrapper: broken telemetry never escapes.
- `cache/breaker.ts` (124) — composes VC0C's `createBreaker` (no parallel state machine). `tripKindForMiss(missClass)` maps profile/range/request to CORRECTNESS (trip on first failure), dependency/generation to PERFORMANCE. `shouldBlockServe(missClass)` = `missClass !== "unknown"`. `decideCacheServe(missClass, breaker)` = `{block, fallbackMode, tripKind}`. PROBE_* states never served (TRIAD_RESILIENCE line 13). `breakerRetryDelay` reused from VC0C.
- `cache/_diagnostics-fixture.ts` (32) — `diagnosticsFixture(id)` + `withVc7cFlag(value, fn)`.
- `migrations/request-hash-v2.ts` (80, delegate-shell) — re-exports from `./request-hash-v2-types.js` (87) and `./request-hash-v2-ops.js` (195). `deriveRequestHashV2` returns BARE hex. `m5Switch` completes the switch with collision check. `invalidationKey` consumed from `../topology/query.js`.

Tests:
- `cache/diagnostics.test.ts` (325) — exclusive ranking pins (CACHE-016..030 + named), classFor co-occurrence, absence-is-not-a-mismatch, isTransientMiss.
- `cache/breaker-chaos.test.ts` (106) — shouldBlockServe, mode B/C/A, MANUAL_HALT, four conditions, VC0C composition, trip-kind mapping (correctness vs performance), probe-state enforcement.
- `cache/flag-parity-vc7c.test.ts` (144) — deriveRequestHashV2 byte-identical ON vs OFF (BARE hex), event suppression, payload-free.
- `migrations/request-hash-v2.test.ts` (158) — copy/validate/switch, collision detection, identity preservation, resume-after-crash, NOT_ON_LEGACY.
- `vc7c-acceptance.test.ts` (26) — delegate-shell listing siblings + run commands.

Scripts:
- `scripts/gen-fixtures/cache-diagnostics.mjs` (721) — 15 CACHE-016..030, 20 M5-001..020, 3 named. All digests via `node:crypto`. BigInt -> plain integers for fixture JSON.
- `scripts/gen-fixtures/schemas.mjs` — added `cache-diagnostic-fixture.schema.json` + `request-hash-v2-fixture.schema.json`.
- `scripts/gen-fixtures/write.mjs` — wired cache-diagnostics import + DIAGNOSTICS_DIR + fixture loop + manifest extensions.

## Fixtures and corpus digests

Conformance: 660 total fixtures (38 new VC7C: 15 CACHE-016..030 + 20 M5-001..020 + 3 named), 33 schemas (2 new). All canonical. `node scripts/vector-cortex-conformance.mjs --check` passes.

Coverage by scenario band:
- `classify` (CACHE-016..030) — profile mismatch, range mismatch, dependency advance, request mismatch, generation invalidated, cold-key -> unknown, co-occurrence tie-breaks.
- `m5-copy`/`m5-switch` (M5-001..020) — single/multi-profile copy, economics folding, idempotent re-run, interrupted resume, identity preservation, collision detection, zero-collision switch, NOT_ON_LEGACY.
- `named` — CACHE-MISS-001 (profile wins over range+dependency), M5-COLLIDE-002 (collision blocks switch), CACHE-STALE-003 (generation invalidated blocks serve).

## Gate results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` (VC7C files) | PASS (0 errors) |
| `node scripts/vector-cortex-conformance.mjs --check` | PASS (660 fixtures) |
| `node scripts/guardrails-scan.mjs` | PASS (clean) |
| `python3 scripts/regression_check.py --all` | PASS (0 blocking, 7 dev-only) |
| `node scripts/vector-cortex-docs-check.mjs` | PASS (27 sprints / 9 phases) |

## Known findings

1. **`breaker.ts` composes VC0C's `createBreaker`** (per team-lead correction). The initial 465-line standalone state machine was abandoned — it reimplemented the VC0C cooldown/probe/hysteresis logic in parallel, which would drift from TRIAD_RESILIENCE. The current version composes `createBreaker` from `../resilience/breaker-core.js`, maps the four cache demotion conditions to `BreakerTripKind` (profile/range/request = correctness, dependency/generation = performance), enforces "probe output is never served" (PROBE_* -> block), and reuses `breakerRetryDelay` from VC0C for deterministic jitter. The breaker constants in `src/config/vector-cortex-breakers.ts` are inherited via breaker-core.ts.
2. **`deriveRequestHashV2` returns BARE hex** (no `v2:` prefix), per the VC5B convention. The original `flag-parity-vc7c.test.ts` asserted `^v2:` which would have failed. Fixed to `^[0-9a-f]+$` with minimum length 64.
3. **Concurrent-agent scope conflict**: The vc7c-dash agent (assigned `extensions/**` + config only) deleted my VC7C core files multiple times during this session. All files were recreated after each deletion burst. The test files were also (re)created by the vc7c-dash agent; I fixed the `flag-parity-vc7c.test.ts` bare-hex assertion bug.
