# VC7 — Provider-honest immutable crystals

**Status:** planned | **Depends on:** VC6 reviewer-accepted | **Sprints:** VC7A, VC7B, VC7C

## Phase goal and boundary

Own Range-keyed crystals, provider economics, full request hash migration and cache breakers. Inputs are only accepted predecessor evidence and the normative [contracts](../CONTRACTS.md), [evaluation](../EVALUATION.md), [triads](../TRIAD_RESILIENCE.md), and applicable asset/security/codec specifications. Outputs: **CrystalKeyV1, CacheExperimentV1, CacheDiagnosticV1**. Current storage/backend facts defer to root `CLAUDE.md` and inspected source, not stale `PLAN.md` better-sqlite text.

## Sprint boundaries

- **VC7A:** contract/schema/fixture seam and first production capability; contract review is a hard gate.
- **VC7B:** deterministic core/integration and phase-specific migration or artifact work.
- **VC7C:** conformance, chaos, qualification, powered rollout, or handoff. Each sprint may use multiple small production-first sub-sprints with full gates.

No implementation crosses into the next boundary before predecessor evidence is reviewer-accepted. Each sprint names exact files, aggregator test, fixtures, thresholds, flag, migration disposition, and A/B/C independence.

## Failure and evaluation

A is the phase-specific optimized path; B is an independently implemented deterministic local path; C is exact current transcript/ledger or accepted legacy path and honestly may lack older semantic context. Authority outage freezes derived frontier. Apply common 60-second window, 20-attempt minimum, cooldown/backoff/hysteresis/N=3 probes, spool ack/dedup, restart and monotonic-clock rules. Qualification uses per-head metrics and one-sided non-inferiority; live advancement requires duration **and** powered samples/events.

## Migration, config, privacy, dashboard

Migration disposition: **M5 request-hash-v2; consume M6**. Compatibility journal and downgrade export remain active for post-v2 writes. Every feature flag is positive `MEGACOMPACT_<SPRINT>`, default ON and `=0` off, defined in `src/config/vector-cortex.ts`, re-exported by `src/config.ts`, and represented in SETTINGS or explicitly excluded. Exact ledger bytes are never automatically learning data. Dashboard sprints use the common vector-cortex API/route/client ownership stated in sprint specs and reader-only GET capabilities.

## Phase exit and rollback

All three sprint evidence files are reviewer-accepted; exact project, targeted, docs-link/schema, offline/network, asset, dashboard, and external Rust gates (when applicable) pass. Hard safety violations are zero; touched files remain below limits and neither pre-existing hard violation worsens. Rollback selects C, restores prior derived pointers, preserves authority/journal/evidence, and rehearses old-binary export where writes occurred.

Handoff: VC8 receives causal telemetry, never shadow savings claims. Update README status only after reviewer attestation.
