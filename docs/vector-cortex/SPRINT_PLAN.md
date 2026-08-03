# Vector Cortex Master Plan — 27 Sprints

Normative inputs: [readiness](IMPLEMENTATION_READINESS.md), [contracts](CONTRACTS.md), [model](MODEL_ASSET.md), [codec](RESIDUAL_CODEC.md), [privacy](SECURITY_PRIVACY.md), [triads](TRIAD_RESILIENCE.md), [evaluation](EVALUATION.md), [conformance](CONFORMANCE.md).

## Roadmap and closure order

| Phase | A | B | C | Exit |
| --- | --- | --- | --- | --- |
| VC0 | baseline/annotations | M3 replay | breaker/spool | trusted safety envelope |
| VC1 | EventV2 bytes | M2 ledger+journal | M4/conformance/export | exact authority |
| VC2 | runtime/asset decision | five heads | qualification/package | learned A or live B/C |
| VC3 | store contract | topology | M6 query invalidation | deterministic graph |
| VC4 | semantic/exact shards | residual/parity | **mandatory closure** | live-safe candidates |
| VC5 | PromptDag/planner | renderer/profile registry | powered rollout | live cortex |
| VC6 | closure optimization | exact restore | derived self-heal | advanced repair |
| VC7 | range crystals | provider economics/M5 | diagnostics/switch | causal caching |
| VC8 | outcomes/consent | shadow/M7 | canary/external Rust | adaptive platform |

Serial dependency is `VC0A → … → VC4C → VC5A → … → VC8C`; VC5 cannot begin without VC4C conservative closure. Rust fixture-runner work may begin externally after VC1C but engine selection remains VC8C.

## Named migrations and current-source evidence

| ID | Owner | Defect/evidence | Required regression |
| --- | --- | --- | --- |
| M2 occurrence-v2 | VC1B | `src/mirror/mirror.test.ts` documents `raw_transcript` PK duplicate occurrence loss | repeated equal bytes retain distinct seq/event IDs |
| M3 effective-cut-v2 | VC0B | capped replay effective cut must respect boundary/commit/capture minima | cap inside tool pair retreats safely |
| M4 minhash-v2 | VC1C | `src/dedup/l1-minhash.ts` signature/precision versioning | unsigned TS/neutral golden equality and v1 isolation |
| M5 request-hash-v2 | VC7B/C | cache-poison request-prefix hashing | entire canonical outbound request collision corpus |
| M6 router-generation-v2 | VC3C | `src/tieredRouter.ts::invalidateSession` string-prefix invalidation | session/generation/range invalidation, no stale hits |
| M7 pressure-v2 | VC8B | `src/config.ts::PressureBand` persistence/dashboard/language drift | exhaustive known values; unknown rejects |

Each is resumable copy-validate-switch and works with the compatibility journal/downgrade exporter. Pure sprint specs explicitly say no migration.

## Flags, dashboard, and files

Every sprint has one positive `MEGACOMPACT_<SPRINT>` flag in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON and `=0` off. Adjustable values must appear in `extensions/dashboard-server/routes-rag-settings.ts::SETTINGS`; immutable/security exclusions enter `EXCLUDED_SETTINGS`. Flag-off produces predecessor bytes.

Dashboard work owns `extensions/dashboard-server/api-contracts/vector-cortex.ts`, `routes-vector-cortex.ts`, registration in `routes.ts`, client `src/{api,types}/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, and route/client/component tests. GET receives only reader capabilities; mutations require explicit admin and audit.

All new files obey project soft/hard limits. Baseline has two pre-existing hard violations: never worsen them. Any sprint touching context-handler splits it first via delegate-shell.

## Gates

Every sprint creates its exact acceptance aggregator named in its spec, then runs it (no globs), followed by:

```bash
npm run build
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
git diff --check
```

Dashboard touch also runs `cd extensions/dashboard-client && npm run typecheck && npm run build`. Storage changes run schema integrity/foreign-key and migration interruption/resume tests. Asset release runs manifest digest, supported matrix, `npm pack --dry-run` listing only, network-denied clean-install packaged inference, and enhanced `scripts/deploy.sh` gate. No-network enforcement patches Node network modules to throw while exercising all runtime paths and statically scans TS/JS plus Rust Cargo.lock/source. VC8C evidence from external Rad workspace must include:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
```

plus fixture runner and TS↔Rust cross-read/write on supported platforms. This repository creates no Rust workspace.

## Rollout, evidence, release

At each percentage require both ≥72h and powered samples plus ≥10,000 eligible events/200 sessions; lower one-sided 95% bound(A-C) ≥−1pp. Hard integrity failure immediately selects C/manual halt. Shadow cache numbers remain estimates; randomized session provider telemetry is required for causal savings.

Create only the executing sprint’s [evidence record](EVIDENCE_TEMPLATE.md). Implementer status is not acceptance; reviewer attests and then updates README. Releases use `./scripts/deploy.sh <version>` only, npm distribution only, after clean tree and maintainer approval. Dry-run package listing never creates `.tgz`.
