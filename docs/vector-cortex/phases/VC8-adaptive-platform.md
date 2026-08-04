# VC8 — Consent-bound adaptation and external Rust parity

**Status:** planned | **Depends on:** VC7 reviewer-accepted | **Sprints:** VC8A, VC8B, VC8C

## Phase goal and boundary

Own Outcome/consent ledger, bounded shadow policy, pressure migration, external Rad Rust artifact parity/canary. Inputs are only accepted predecessor evidence and the normative [contracts](../CONTRACTS.md), [evaluation](../EVALUATION.md), [triads](../TRIAD_RESILIENCE.md), and applicable asset/security/codec specifications. Outputs: **OutcomeV1, PolicyDecisionV1, EngineAbiV1, ParityReportV1**. Current storage/backend facts defer to root `CLAUDE.md` and inspected source, not stale `PLAN.md` better-sqlite text.

## Sprint boundaries

- **VC8A:** contract/schema/fixture seam and first production capability; contract review is a hard gate.
- **VC8B:** deterministic core/integration and phase-specific migration or artifact work.
- **VC8C:** conformance, chaos, qualification, powered rollout, or handoff. Each sprint may use multiple small production-first sub-sprints with full gates.

No implementation crosses into the next boundary before predecessor evidence is reviewer-accepted. Each sprint names exact files, aggregator test, fixtures, thresholds, flag, migration disposition, and A/B/C independence.

## Failure and evaluation

A is the phase-specific optimized path; B is an independently implemented deterministic local path; C is exact current transcript/ledger or accepted legacy path and honestly may lack older semantic context. Authority outage freezes derived frontier. Apply common 60-second window, 20-attempt minimum, cooldown/backoff/hysteresis/N=3 probes, spool ack/dedup, restart and monotonic-clock rules. Qualification uses per-head metrics and one-sided non-inferiority; live advancement requires duration **and** powered samples/events.

## Migration, config, privacy, dashboard

Migration disposition: **M7 pressure-v2; engine selection record only**. Compatibility journal and downgrade export remain active for post-v2 writes. Every feature flag is positive `MEGACOMPACT_<SPRINT>`, default ON and `=0` off, defined in `src/config/vector-cortex.ts`, re-exported by `src/config.ts`, and represented in SETTINGS or explicitly excluded. Exact ledger bytes are never automatically learning data. Dashboard sprints use the common vector-cortex API/route/client ownership stated in sprint specs and reader-only GET capabilities.

## Phase exit and rollback

All three sprint evidence files are reviewer-accepted; exact project, targeted, docs-link/schema, offline/network, asset, dashboard, and external Rust gates (when applicable) pass. Hard safety violations are zero; touched files remain below limits and neither pre-existing hard violation worsens. Rollback selects C, restores prior derived pointers, preserves authority/journal/evidence, and rehearses old-binary export where writes occurred.

Handoff: Program release retains TS B and legacy C rollback. Update README status only after reviewer attestation.
