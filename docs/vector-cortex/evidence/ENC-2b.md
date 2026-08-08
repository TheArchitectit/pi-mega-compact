# ENC-2b Evidence — Native ONNX runtime qualification retest

Status: **implementer-complete** — the second of three ENC-2 instalments
(ENC-2a install guide, ENC-2b native qualification retest, ENC-2c lazy-download
upgrade). The sprint re-probes and re-qualifies the native onnxruntime binding
installed via the ENC-2a guide: loads the LOCAL on-disk binding, runs a bounded
warmup + p95 probe, measures RSS, computes a fresh qualification verdict, and
surfaces it on the Setup Cortex sub-tab and the GET `/api/setup-status` response.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/ENC-2b-native-qualification-retest.md
- **Sprint ID string:** `ENC-2b` (owner CSV + manifest registration, algorithm
  `encoder-qualification-retest`)
- **Flag:** `MEGACOMPACT_ENC_2B` — boolDirect, default ON;
  `MEGACOMPACT_ENC_2B=0` restores the ENC-2a predecessor byte-identically (no
  retest GET fields, no retest POST branch, no retest card). Registered as a
  visible `VECTOR_CORTEX_SETTINGS` toggle, never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `src/config/vector-cortex-enc2b.ts` (38) — `ENC_2B_ENABLED()` positive sprint
  flag sibling, default ON; `=0` disables.
- `src/config/vector-cortex.ts` (114) — additive re-export (+2 lines).
- `src/config.ts` (227) — additive re-export (+1 line).
- `src/vector-cortex/encoder/native-qualify-retest.ts` (264) — NEW pure retest
  module: resolves the installed binding under
  `native-ort/node_modules/onnxruntime-node/`, reads version, dynamic-imports
  the local binding, 3 warmup + 10 timed passes on fixed 512-token synthetic
  input, p95 sorted-index, RSS via `process.memoryUsage().rss`, verdict
  qualified/degraded/failed against ENCODER_LATENCY_P95_MS (40) +
  installBudgetMib() (300). Null when no binding; never throws.
  NO network, NO training (PREVENT-PI-004/HG-1 unchanged).
- `extensions/dashboard-server/routes-setup-enc2b.ts` (82) — NEW sibling:
  `readEnc2bRetest` (async; flag-off and no-binding return `{}` to OMIT fields
  byte-identical), `enc2bRetestRequest` (true→run, false→reject),
  `runEnc2bRetest` (run + return fresh result).
- `extensions/dashboard-server/routes-setup.ts` (380) — additive branches: GET
  merges `readEnc2bRetest` result; POST handles `nativeOrtRetest` key
  (false→400 `retest_rejected_false_nothing_to_do`, true→run+return). Under
  the 400-line extensions soft cap.
- `extensions/dashboard-server/api-contracts/setup.ts` (203) — additive:
  `nativeOrtRetestResult?: RetestResult | null`,
  `nativeOrtBackendEffective?: "native" | "wasm"`, `RetestResult` interface,
  `SetupConfigureRequest.nativeOrtRetest?: boolean`.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (372) —
  boolDirect `MEGACOMPACT_ENC_2B` toggle.
- `scripts/ml5-enc/gen-fixtures.mjs` (1866) — 10th additive block (schema + 6
  retest fixtures, owner CSV +ENC-2b, domain +encoder-qualification-retest).
- `conformance/vector-cortex/v2/encoder-qualification-retest/ENC-RETEST-{001..006}.json`
  + schema `schemas/encoder-qualification-retest-fixture.schema.json`.
- `src/vector-cortex/enc2b-acceptance.test.ts` (233) — 17-test aggregator:
  fixture registration + kind-closure, artifacts/budget satisfaction, contract
  additivity scan, no-network scan (PREVENT-PI-004), flag-gating scan.
  Flag-agnostic (passes both states).
- `extensions/dashboard-client/src/tabs/SetupTab/CortexRetestCard.tsx` (104) —
  NEW retest card: polls `/api/setup-status` 5s, renders when
  `nativeOrtInstalledVersion != null && nativeOrtRetestResult != null`, shows
  platform/version/verdict badge(styled)/p95/RSS/testedAt/effective-backend,
  "Retest now" button POSTs `{nativeOrtRetest: true}` then refreshes.
- `extensions/dashboard-client/src/tabs/SetupTab/CortexSetup.tsx` (64) —
  additive mount between `CortexRuntimeInstallCard` and `VectorCortexCosineFpCard`.

Intentionally NOT touched: `extensions/dashboard-server/routes-setup-enc2a.ts`
(the guide sibling is UNCHANGED); `extensions/dashboard-client/src/tabs/SetupTab/CortexRuntimeInstallCard.tsx`
(UNCHANGED); ANY network path (PREVENT-PI-004 clean — the retest loads a LOCAL
on-disk binding, never fetches); ANY training code (HG-1 unchanged).

## Behavior enforced (the sprint's hard guarantees)

1. **Binding-present retest round-trip** — opt-in on + wasm backend + native
   binding installed → GET carries `nativeOrtRetestResult` with a non-null
   verdict in [qualified, degraded, failed], `p95Ms > 0`, `rssMiB > 0`, ISO
   `testedAt`, and `nativeOrtBackendEffective` matches the verdict (native iff
   qualified, else wasm). Fixture ENC-RETEST-001.
2. **Binding-absent** — no binding → GET omits both fields (absent, not null).
   Fixture ENC-RETEST-002.
3. **Flag-off byte-identical** — `MEGACOMPACT_ENC_2B=0` omits both new GET
   fields and the POST key is unrecognized, byte-identical to ENC-2a era.
   Fixture ENC-RETEST-003.
4. **Failed verdict stays wasm** — binding present but crashes on load →
   `verdict: "failed"`, `nativeOrtBackendEffective: "wasm"`; the runtime never
   silently switches on a failed retest. Fixture ENC-RETEST-004.
5. **POST retest action** — `nativeOrtRetest: true` returns the fresh
   `RetestResult`; `false` returns 400. Fixture ENC-RETEST-005.
6. **Contract additive** — a pre-ENC-2b client omits the new keys and validates
   unchanged. Fixture ENC-RETEST-006.

## Conformance fixtures

- `ENC-RETEST-001` — binding-present retest round-trip (linux-x64, binding
  installed): verdict enum, p95Ms > 0, rssMiB > 0, ISO testedAt, backend matches.
- `ENC-RETEST-002` — binding-absent: both fields omitted (absent, not null).
- `ENC-RETEST-003` — flag-off: byte-identical to ENC-2a era.
- `ENC-RETEST-004` — failed verdict: backend stays wasm.
- `ENC-RETEST-005` — POST retest action: true → run, false → 400.
- `ENC-RETEST-006` — contract additive: pre-ENC-2b client validates.
- All canonical (UTF-8 NFC, sorted keys, LF-final) + sha256-pinned. `kind` enum
  closed to the 6 branch kinds; schema
  `schemas/encoder-qualification-retest-fixture.schema.json`. Owner CSV +ENC-2b;
  algorithm `encoder-qualification-retest`; fixture count grows by 6
  (952 → 959, plus schema row).

## Test outcomes (HEAD, flag-agnostic)

- [x] `npm run build` → clean (tsc -p tsconfig.json + publish-acceptance: 64
  acceptance + 30 encoder files)
- [x] `node --test dist/vector-cortex/enc2b-acceptance.test.js` → **17 pass / 0 fail**
- [x] `MEGACOMPACT_ENC_2B=0 node --test dist/vector-cortex/enc2b-acceptance.test.js`
  → **17 pass / 0 fail** (flag-off same-pass parity)
- [x] `node --test dist/vector-cortex/enc2a-acceptance.test.js` → **18 pass / 0 fail**
  (no regression — ENC-2a fixtures unchanged)
- [x] `npm run lint` → clean (tsc --noEmit + guardrails-scan + semantic-scan +
  stub-scan + mock-scan)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate
  npm audit warnings unchanged)
- [x] `node scripts/guardrails-scan.mjs` → clean
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **959 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **68 sprints / 16 phases clean**
- [x] `python3 scripts/log_failure.py --list` → no active failures in scope
- [x] `git diff --check` → clean
- [x] `cd extensions/dashboard-client && npm run typecheck` → tsc clean
- [x] `cd extensions/dashboard-client && npm run build` → vite build clean
- [x] full `npm test` → **4194 pass / 0 fail** (4198 - 4 skipped)

## Spec-staleness deviations (rationale)

- **`readEnc2bRetest` / `enc2bRetestRequest` / `runEnc2bRetest` instead of
  the spec's `wantsEnc2b`/`tryEnc2bStatusFields` naming.** The actual
  implementation splits responsibilities differently: `readEnc2bRetest` is the
  GET-side reader, `enc2bRetestRequest` is the POST-side retest-request handler,
  `runEnc2bRetest` runs the retest and returns the result. Same surface, better
  naming.
- **`EXPECTED_SPRINTS` stays 68, not bumped to 69.** The ENC-2b sprint spec was
  already counted in the 68 (the comment in vector-cortex-docs-check.mjs line 33
  explicitly lists ENC-2b). No per-sprint bump needed when the spec was
  pre-registered.

## Migration, migration disposition, and rollback

**Migration:** pure — no store schema/state change, no events.log format change.
The retest result is computed per GET (reader-only, never persisted); the POST
retest action is synchronous and stateless. No operator migration.

**Rollback:** set `MEGACOMPACT_ENC_2B=0`. The Cortex sub-tab renders no retest
card, the GET omits both new fields, byte-identical to the ENC-2a-era shape,
WITHOUT deleting the operator-produced `native-ort/` install dir (data
preservation).

## Failure triad (A/B/C)

- **A (binding-present round-trip)** — opt-in on + native binding installed →
  GET carries the retest result → fixture ENC-RETEST-001 + the aggregator's
  version/budget assertions.
- **B (absence semantics)** — no binding → both fields absent → fixture
  ENC-RETEST-002 + `runNativeRetest` returning null.
- **C (flag-off + failed)** — flag-off byte-identity → fixture ENC-RETEST-003;
  failed verdict stays wasm → fixture ENC-RETEST-004; POST action → fixture
  ENC-RETEST-005; contract additive → fixture ENC-RETEST-006.

## Live Playwright validation (MANDATORY — status)

Deferred — no native onnxruntime binding is installed on the current host
(`~/.pi/mega-compact/native-ort/node_modules/onnxruntime-node/` absent), so the
retest card hides correctly (both fields absent). The mandatory flows are:

1. **Retest card absent when no binding installed** — navigate to Setup → Cortex,
   assert the retest card is ABSENT; zero console errors.
2. **Retest card present when binding installed** — requires operator running
   the ENC-2a install script on the host; deferred until then. Evidence will
   name the host and the rendered card output once validated.

## Controller-run gates (require a commit SHA; run post-commit)

- `node scripts/vector-cortex-scope-check.mjs ENC-2b <COMMIT_SHA>` — every committed
  file must fall inside the declared ownership ∪ fixed cross-cutting seams.
- `node scripts/vector-cortex-evidence-check.mjs ENC-2b` — re-derives the line counts /
  test counts / fixture count / flag parity claims in this record from the tree; must
  agree.
- `python3 scripts/log_failure.py --list` — done (see Test outcomes); no active failures.

## Fix applied during controller review

**React hooks-order violation in `CortexRetestCard.tsx`.** Worker B called
`useCallback` (line 54) after a conditional early return (line 52), violating
React's rules of hooks (hooks must fire in the same order every render). Fixed
by moving the `useCallback` definition above the conditional return. Resolved
pre-deploy.
