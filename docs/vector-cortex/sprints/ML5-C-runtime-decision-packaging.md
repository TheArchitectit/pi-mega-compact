# ML5-C — Runtime decision + packaging (WASM vs native)

**Status:** planned | **Depends on:** ML5-B | **Phase:** ML5
**Flag:** `MEGACOMPACT_ML5_C`, defined in `src/config/vector-cortex-ml5c.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ML5_C=0` disables and must be byte-identical to the ML5-B survivor (no runtime selection runs — the encoder continues to serve mode B trigram, exactly as before, with no `vector_cortex_runtime_selected` event emitted). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Decision + packaging sprint.** ML5-B measured the encoder; ML5-C makes the decisive call — **WASM vs native** — and ships the winner as the packaged runtime. This closes **HG-3** (the 80 MiB install budget) and **HG-4** (the darwin-x64 strategy). The phase plan offers three options:

- **Option W (WASM)** — `onnxruntime-web`, WASM backend. ~9 MiB extra dependency, pure Node, covers all Node platforms (no per-platform `optionalDependencies`), no native compilation. Fits comfortably within the 80 MiB budget. Downside: 4-thread WASM is typically 2×–3× slower than native CPU; must measure to hit p95 ≤ 40 ms.
- **Option N (native)** — `onnxruntime-node` with per-platform `optionalDependencies`. Higher absolute performance, but install size ≥ 100 MiB once ≥ 3 platforms are included. Exceeds the 80 MiB budget unless the budget is amended to ~120–150 MiB.
- **Option H (hybrid)** — WASM for correctness when native is absent, native when present. Requires shipping **both** packages, defeating the budget.

**Decision rule (deterministic, measured):** ship the **WASM backend** (Option W) **if** the measured p95 at 512 tokens on 4 threads is ≤ 40 ms on `linux-x64` (the number ML5-B records for HG-3); **else** ship native (Option N) with an explicit budget amendment recorded in the evidence doc. **darwin-x64** is out-of-scope per HG-1's deferral — on Intel-Mac the runtime demotes to WASM (Option W) or mode B trigram (per HG-4 in the audit Table 3). The chosen backend is a **config decision**, not a UI change: the `vector_cortex_runtime_selected` seller event carries the decision to the dashboard's event reader so the Setup Cortex blockers card can reflect the HG-3/HG-4 state without any new route.

`src/vector-cortex/encoder/runtime.ts` is the production runtime seam **and closes the audit's Table 1 stub 8-neighbor** at `runtime.ts:107` — the deterministic LCG `projectSemantic` placeholder (audit: "the whole mode-A inference path runs on it (no onnxruntime)") is replaced by a real selection dispatch that loads either the WASM or the native `InferenceSession`. The `runtime-wasm.ts` / `runtime-native.ts` files are the two concrete backends; `select.ts` decides between them under the decision rule. The stub itself is closed structurally here and **functionally** when the ML5-A trained/trained asset lands behind the same seam.

Production ownership: `src/vector-cortex/encoder/runtime.ts (evolves — replaces the projectSemantic LCG stub at :107 with a real session-selection dispatch, delegate-shell split so runtime.ts stays under the 300 soft limit); src/vector-cortex/encoder/runtime-wasm.ts (new — onnxruntime-web WASM backend, ~9 MiB); src/vector-cortex/encoder/runtime-native.ts (new — onnxruntime-node native backend, the MEGACOMPACT_ENCODER_NATIVE=1 opt-in path); src/vector-cortex/encoder/select.ts (additive — decision-rule dispatch computed from the ML5-B bench record + platform); package.json (optionalDependencies split when native is chosen — the onnxruntime-node per-platform map); scripts/ml5/package-assets.mjs (new — assembles the platform install matrix and asserts the byte-count budget before publish); conformance/vector-cortex/v2/runtime-choice/ (fixtures ML5-RUNTIME-001..005); scripts/ml5/gen-fixtures-ml5c.mjs (new generator); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 38→39); docs/vector-cortex/evidence/ML5-C.md (new); extensions/dashboard-server/routes-vector-cortex.ts (additive event reader for the vector_cortex_runtime_selected seller — no new route, the existing route already streams the seller events the Setup Cortex card consumes)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ML5_C` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-ml5c.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive, stays ≤ 300). `vector-cortex.ts` stays ≤ 300 (one additive re-export line). The flag gates the runtime-selection dispatch only; `=0` leaves the encoder on mode B trigram exactly as ML5-B did.
2. Create `src/vector-cortex/encoder/runtime-native.ts`: the `onnxruntime-node` backend. Loads the committed ONNX `InferenceSession`, `intraOpNumThreads: 4`, opset 17 handshake, embedding output. Only imported when `MEGACOMPACT_ENCODER_NATIVE=1` and the native package is present.
3. Create `src/vector-cortex/encoder/runtime-wasm.ts`: the `onnxruntime-web` WASM backend. Same `InferenceSession` surface, WASM execution provider, ~9 MiB footprint, opset 17 handshake. This is the default backend.
4. Create `src/vector-cortex/encoder/select.ts`: the decision-rule dispatch. Consumes the ML5-B `BenchResultV1` p95 record for `linux-x64`; if ≤ 40 ms → WASM (Option W); else native (Option N, with the budget amendment); on `darwin-x64` (Intel-Mac) → WASM or mode B demotion per HG-4. Pure function of {platform, benchRecord, nativeOptIn}.
5. Evolve `src/vector-cortex/encoder/runtime.ts`: replace the `projectSemantic` LCG stub at `runtime.ts:107` with the selection dispatch delegating to `select.ts` → `runtime-wasm.ts`/`runtime-native.ts`. Use the delegate-shell split so runtime.ts stays under the 300 soft limit (mirror the `client.ts → client-http.ts + client-extra.ts` PC-C precedent — the shell keeps the public `InferenceSession`/embedding API, the backends live in the siblings). If no model asset is present, fall back to mode B trigram (per the phase's "flag-on ≠ behavior change" invariant).
6. Package: create `scripts/ml5/package-assets.mjs` which assembles the platform install matrix, asserts the **byte-count budget** (the chosen backend + its deps must fit 80 MiB, or the evidence records the amendment), and lists the shipped asset for `npm pack --dry-run` (mirrors the dashboard-bundle regression guard in `scripts/deploy.sh`). Patch `package.json` only when native is chosen — the per-platform `optionalDependencies` split; WASM needs no package.json change beyond the single `onnxruntime-web` dep.
7. Add `scripts/ml5/gen-fixtures-ml5c.mjs` emitting `ML5-RUNTIME-001..005`, register them + owner `ML5-C` in the v2 manifest against `schemas/ml5-fixture.schema.json`; bump `EXPECTED_SPRINTS` 38→39 in `scripts/vector-cortex-docs-check.mjs`.
8. Add `extensions/dashboard-server/routes-vector-cortex.ts` additive event-reader support for the `vector_cortex_runtime_selected` seller (no new route, no `EXPECTED_ENDPOINT_COUNT` bump) so the Setup Cortex blockers card sees the HG-3/HG-4 closure state.
9. Add the sprint acceptance aggregator `src/vector-cortex/ml5c-acceptance.test.ts`, then evidence `ML5-C.md` recording the decision, the measured p95 input, the byte-count, and the darwin-x64 disposition.

## Failure triad and independence

A budget compliance: with the WASM backend chosen, `package-assets.mjs` asserts the installed byte-count (onnxruntime-web + the committed asset + deps) is ≤ 80 MiB and records PASS (fixture 501; ids below use the `ML5-RUNTIME-` prefix, abbreviated as `501`). B per-platform install matrix: the matrix for the chosen backend resolves every Node platform to a concrete package/size row with no missing optionalDependency (fixture 502). C opset 17 handshake: the selected session's `opset_import` declares 17 and the handshake records OK, matching what `asset.ts` enforces (fixture 503). The stub-fallback + native opt-in is pinned by fixtures 504–505 — 504 asserts `runtime.ts` falls back to mode B trigram when the WASM artifact is absent (and `MEGACOMPACT_ML5_C=1`), and 505 asserts `MEGACOMPACT_ENCODER_NATIVE=1` + native package present routes through `runtime-native.ts` while `=0` (default) routes through `runtime-wasm.ts`. A is produced by the byte-count assert in packaging; B by the matrix resolution; C purely by the session handshake. All three use independent inputs. `MEGACOMPACT_ML5_C=0` yields byte-identical mode-B serving. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/runtime-choice/`. Schema: `schemas/ml5-fixture.schema.json` (shared ML5 schema).

- `ML5-RUNTIME-001: install budget byte-count compliance for the chosen backend` — `{ kind:"runtime-choice", flag:"MEGACOMPACT_ML5_C", backend:"wasm|native", budget_mib:80, byte_count_le_budget:true, amended_budget_mib:null }`. For native (Option N) the fixture records `amended_budget_mib` from the evidence amendment instead of `byte_count_le_budget:true`.
- `ML5-RUNTIME-002: per-platform install matrix resolves completely` — `{ kind:"runtime-choice", flag:"MEGACOMPACT_ML5_C", platforms:["linux-x64","darwin-arm64","darwin-x64","win32-x64"], matrix_complete:true, no_missing_optional_dep:true }`.
- `ML5-RUNTIME-003: opset 17 session handshake` — `{ kind:"runtime-choice", flag:"MEGACOMPACT_ML5_C", opset:17, handshake:"ok" }`.
- `ML5-RUNTIME-004: stub-fallback to mode B when WASM artifact absent` — `{ kind:"runtime-choice", flag:"MEGACOMPACT_ML5_C", asset_present:false, native_opt_in:false, fallback:"mode_B_trigram" }`.
- `ML5-RUNTIME-005: native opt-in routes through onnxruntime-node; default routes WASM` — `{ kind:"runtime-choice", flag:"MEGACOMPACT_ML5_C", native_opt_in:true, backend:"runtime-native", native_opt_in_default:false, backend_default:"runtime-wasm" }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/ml5c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/ml5c-acceptance.test.js
```

Expected assertions: all `ML5-RUNTIME-001..005` rows registered with algorithm `runtime-choice` against the `ml5-fixture` schema; 501 pins the byte-count budget (or the native amendment); 502 pins the complete platform matrix; 503 pins the opset handshake; 504 pins the mode-B stub fallback; 505 pins the native-opt-in vs default-WASM routing. Exact flag-off comparison command: `MEGACOMPACT_ML5_C=0 node --test dist/vector-cortex/ml5c-acceptance.test.js`; the aggregator is flag-agnostic (off → mode B). Acceptance: no payload leakage — `runtime.ts` returns embedding vectors and the seller event carries `{backend, p95Ms, budgetOk, platform}` only, never message content (EVAL-REDACT-002); **zero network calls at runtime** — the backend loads a local committed asset and local WASM/native binaries (PREVENT-PI-004 green; no `fetch`/HTTP anywhere in the selection or packaging paths). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (backend assets are shipped inside the package; the selection is computed, not stored; no new tables). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the runtime returns embedding vectors and the seller event carries only the four fields above — never message content (EVAL-REDACT-002). Dashboard: **no UI change** (the decision is config) — the only dashboard-side touch is the additive event reader in `routes-vector-cortex.ts`, and no client file changes, so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The seller is emitted on extension init so the Setup Cortex blockers card surfaces the HG-3/HG-4 state.

Rollback sets `MEGACOMPACT_ML5_C=0`; runtime selection is deferred and the encoder serves mode B trigram — byte-identical to the ML5-B survivor — without deleting the evidence. The flag is a visible `VECTOR_CORTEX_SETTINGS` boolDirect toggle, never `EXCLUDED_SETTINGS`.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/ml5c-acceptance.test.js`, `MEGACOMPACT_ML5_C=0 node --test dist/vector-cortex/ml5c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs ML5-C <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs ML5-C`, `git diff --check`. No permissive globs or warning-only scans count.

Because the decision is **measured, not assumed**, the evidence doc `ML5-C.md` records: the `linux-x64` p95 at 512 tokens on 4 threads from `ML5-B.md`, the chosen backend (WASM unless that p95 exceeds 40 ms), the installed byte-count versus the 80 MiB budget (or the native budget amendment), the complete platform matrix incl. the darwin-x64 → WASM/mode-B demotion, and the `vector_cortex_runtime_selected` event shape.

Soft-as-hard: `runtime.ts` must stay ≤ 300 — if it crosses its soft limit, split further into a delegate-shell + `runtime-http.ts`/`runtime-local.ts`-style sibling before completing this sprint. Any touched file crossing its soft limit blocks at `deploy.sh` (ML5-B precedent).

`<COMMIT_SHA>` in the scope-check command is this sprint's commit. No client files are touched, and the dashboard server change is a single additive event-reader branch.

This sprint adds a 39th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 38 to 39.
