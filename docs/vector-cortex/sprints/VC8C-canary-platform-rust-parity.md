# VC8C — Canary selection and external Rust parity

**Status:** planned | **Depends on:** VC8B | **Phase:** VC8
**Flag:** `MEGACOMPACT_VC8C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC8C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **EngineAbiV1 / ParityReportV1**. Production ownership: `src/vector-cortex/platform/{types,select}.ts; scripts/vector-cortex-cross-conformance.mjs; conformance/vector-cortex/v2/cross-language/*`. Algorithm: This repo has no Rust workspace and creates none. External Rad repo supplies artifact URL+commit+Cargo.lock digest/evidence; neutral fixture stdin/stdout runner cross-reads/writes.

## Numbered implementation tasks

1. Define `EngineAbiV1` version/input/output/error envelopes and `ParityReportV1` artifact/commit/Cargo.lock digest/matrix; register `RUST-001..030`.
2. Implement `platform/select.ts` to accept an external artifact only when ABI, URL metadata, commit, Cargo.lock digest, and supported platform all match evidence; create no Rust workspace here.
3. Implement `vector-cortex-cross-conformance.mjs` neutral stdin/stdout framing so TS and external Rust each read and write every listed fixture.
4. Compare canonical output bytes and failure codes in both directions; any mismatch returns `RUST_PARITY_MISMATCH` and selects TS B.
5. Emit `vector_cortex_engine_parity_checked` and `vector_cortex_engine_selection_demoted`; own parity/selection endpoint and VectorCortexTab status.
6. After selector/runner/dashboard production gates pass, add cross-read fixtures/tests and 72h powered canary evidence `VC8C.md`.

## Failure triad and independence

A qualified external Rust artifact; B TS reference; C legacy path. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cross-language/`.

- `RUST-ABI-001: TS and external runner exchange EventV2 golden`.
- `RUST-ERR-002: both runners return same invalid-UTF8 failure code`.
- `RUST-META-003: Cargo.lock digest mismatch rejects artifact`.

Exact test sources: `src/vector-cortex/platform/select.test.ts`; `src/vector-cortex/platform/cross-read.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc8c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc8c-acceptance.test.js
```

Expected assertions: all `RUST-001..030 plus every neutral fixture` conformance rows return their manifest bytes or exact listed failure code; generate length-framed neutral records and valid/invalid ABI versions; invariant: cross-read/write outputs and failure codes are byte-equal. Unique failure injection: external runner exits after writing a partial frame; harness returns `RUST_FRAME_TRUNCATED`, selects B, and never retries as A. Forced triad: A=qualified external Rust artifact; B=TS reference forced by parity/metadata failure; C=legacy path forced when TS reference breaker opens. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC8C=0 node --test dist/vector-cortex/vc8c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: all goldens byte-equal; supported matrix pass; 72h AND powered canary; rollback <1 session. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—engine selection record only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: engine parity/selection endpoint and VectorCortexTab. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC8C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: program handoff includes external cargo evidence and TS rollback rehearsal.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc8c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
