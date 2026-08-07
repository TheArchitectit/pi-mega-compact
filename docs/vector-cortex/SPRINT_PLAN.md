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

**COMPLETED: VC0F — Dashboard Restart-on-Upgrade (session_start auto-restart).** VC0E shipped as v0.20.25 (honest status badges: LIVE / AWAITING DATA / DEFERRED instead of bare zeros), but exposed a durability gap: `pi update --extensions` swaps the on-disk package while long-running `_dashboard-runner.mjs` processes keep serving the old in-memory bundle. After v0.20.25, six orphan servers on :9320–9325 were still reporting v0.20.24. The immediate mitigation is in `scripts/deploy.sh` (post-publish bounce of local runners — commit `ea2e097`); VC0F shipped the durable, device-side complement: the stale-replace block is lifted out of the `/mega-dashboard` handler into `bounceStaleRunnerIfAny()` (dependency-injected, delegate-shell `extensions/mega-dashboard-bounce.ts`), called from `session_start` with a once-per-process gate, and `port.pid` + the generated runner both stamp the bundle version so the marker path skips the HTTP probe. See [sprint spec](sprints/VC0F-dashboard-restart-on-upgrade.md) (Status: **done**; evidence reviewer-accepted at `docs/vector-cortex/evidence/VC0F.md`). No new `MEGACOMPACT_*` flag — flag-off is byte-identical by construction.

**NEXT SPRINT: VC9A — Setup Cortex status read path (server).** The setup/dashboard surface phase (see `docs/vector-cortex/sprints/` — VC9x workstream spec to be added) exposes the VC encoder gate through the existing dashboard Setup tab: a reader-only `/api/setup-cortex-status` endpoint surfacing mode A/B/C + qualification verdict + blocker list derived from `docs/vector-cortex/vc2-model-prep.md §6`, the action drivers wrapping `scripts/vc2-model-prep/`, the Cortex sub-tab client, and an embedder-detect consolidation. The hard-gate items (5-head training, onnxruntime-node install path, darwin-x64 matrix, RSS margin) are tracked as OPEN out-of-session follow-ups per the VC5C canary precedent.

**COMPLETED: VC0E — Dashboard Live Data + Status Indicators (v0.20.25, 2026-08-05).** All 27 sprints (VC0A→VC8C) + the VC0D production-wiring follow-up are complete at code level. VC0E fixed the wiring gaps the shipped dashboard exposed: emitters that were defined but never called (VC5B render seam, VC0A recall latency), wired-but-degenerate decisions (VC5C `decideLivePath` missing `clock`/`evidence`), routes that hardcoded zeros without consulting `events.log` (rollout, outcomes, platform), and every card rendering zeros without showing status. See [sprint spec](sprints/VC0E-dashboard-live-data.md). Branch: `feat/vc-dashboard-live-data` (merged to master at `863b7bd`).

**Deferred VC2 ML gate (real learned mode A).** VC2A/VC2B/VC2C shipped the encoder *contract* (manifest, runtime, five heads, qualification, packaging) with a 42-byte placeholder `model.onnx` and no `onnxruntime` dependency. The system runs without the learned encoder because trigram-B and lexical-C are live and independently implemented. The real learned-mode-A gate is closed by training/exporting the five heads onto a real MiniLM ONNX, not by any remaining code sprint. The empirical backend viability study + measured benchmarks + surfaced blockers (install-budget, darwin-x64 gap, opset re-export requirement) are recorded in [`docs/vector-cortex/vc2-model-prep.md`](docs/vector-cortex/vc2-model-prep.md), with reproducible dev tooling under `scripts/vc2-model-prep/`. That note is the starting brief for whoever closes the real gate.

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
node scripts/vector-cortex-scope-check.mjs <SPRINT> <COMMIT...>   # assert every committed file inside the spec's Production ownership + fixed cross-cutting seams
node scripts/vector-cortex-evidence-check.mjs <SPRINT>           # assert the evidence record's concrete claims (line counts, test counts, flag parity, fixture counts) match the shipped tree
git diff --check
```

### Scope discipline

A sprint ships **only** what the spec's `Production ownership:` block names (plus the fixed cross-cutting seams every sprint wires: the flag in `src/config/`, the dashboard wiring files, the conformance gen fixtures, the evidence record). No side repos, no "prep for a later sprint", no speculative tooling. If an implementer starts anything outside that set, the scope-check fails and the controller kills it. All work lands in this repo. External-provided work (e.g. the VC8C Rust parity artifact) is *supplied by the user* — never scaffolded here.

Dashboard touch also runs `cd extensions/dashboard-client && npm run typecheck && npm run build`. Storage changes run schema integrity/foreign-key and migration interruption/resume tests. Asset release runs manifest digest, supported matrix, `npm pack --dry-run` listing only, network-denied clean-install packaged inference, and enhanced `scripts/deploy.sh` gate. VC8C evidence from external Rad workspace must include:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
```

plus fixture runner and TS↔Rust cross-read/write on supported platforms. This repository creates no Rust workspace.

## Rollout, evidence, release

At each percentage require both ≥72h and powered samples plus ≥10,000 eligible events/200 sessions; lower one-sided 95% bound(A-C) ≥−1pp. Hard integrity failure immediately selects C/manual halt. Shadow cache numbers remain estimates; randomized session provider telemetry is required for causal savings.

Create only the executing sprint’s [evidence record](EVIDENCE_TEMPLATE.md). Implementer status is not acceptance; reviewer attests and then updates README. Releases use `./scripts/deploy.sh <version>` only, npm distribution only, after clean tree and maintainer approval. Dry-run package listing never creates `.tgz`.
