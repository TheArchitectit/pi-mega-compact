# Placeholder Audit Report

**Sprint:** DOC-0b — placeholder-scan audit report and deferred handoff gate
**Date:** 2026-08-07
**Tree:** `master` at `36e0544` (v0.20.61)
**Status:** complete — zero (a)-classified stale-claim edits applied; all hits routed to handoff or context-correct.

## Scope

Sweep of `src/vector-cortex/` (especially `encoder/`), `extensions/**`, and
`scripts/` non-test source and tooling for justification-style comments that
assert a "placeholder" / "stub" / "until \<sprint\> wires it" / "next sprint
wires it" claim that is now stale because the referenced sprint has shipped.

The conformance registry/manifest is NOT touched; no fixtures added (DOC-0b
adds zero conformance fixtures by spec).

## Shipped-status authority

Each referenced sprint's shipped status is backed by a git tag on `master`:

| Sprint | Shipped tag | Verification method |
|--------|------------|---------------------|
| S33 | pre-VC0A era (S33 commits precede the v0.20.x tag series) | `git log --oneline --all \| grep S33` |
| VC2A | v0.20.x (part of the VC chain that completed v0.16.20 → v0.20.20) | `git tag` + `docs/vector-cortex/evidence/` |
| ML5-C | v0.20.39 | `git tag v0.20.39` |
| ML5-E | v0.20.41 | `git tag v0.20.41` |
| VC0D | `4d9f8f9` merge `feat/vc0d-production-wiring` | `git log --oneline 4d9f8f9` |
| VC9× | v0.20.27–30 | `git tag` series |

## Disposition table

| # | Hit (quoted comment) | path:line | Referenced sprint | Shipped? | Disposition |
|---|----------------------|-----------|-------------------|----------|-------------|
| 1 | `"placeholder: real BenchResultV1 wiring ships in ML5-E"` | `src/vector-cortex/encoder/runtime.ts:233` | ML5-E | Shipped v0.20.41 — but ML5-E did NOT wire `benchRecord` (code still passes `benchRecord: null`) | **(c) ENC-defer** — handoff. The real `BenchResultV1` wiring is the ENC workstream's goal (`ENC-0b`/`ENC-0d`). DOC records only. |
| 2 | `"the LCG placeholder STILL drives infer by default ... only the runtime-selection event seam was added this sprint"` | `src/vector-cortex/encoder/runtime.ts:285` | ML5-C ("this sprint") | Shipped v0.20.39 | **(c) ENC-defer** — the trained asset remains non-authoritative; the real-asset source-of-truth is the ENC workstream (`ENC-0b`/`ENC-0d`). Recording only. |
| 3 | `"placeholder 42-byte asset has no measured real p95"` (×3) | `src/vector-cortex/encoder/runtime-select.ts:44,100,153` | n/a (current-state) | The 42-byte placeholder still exists on master | **context-correct** — accurate current-state. Real p95 arrives with the ENC real-asset work. No edit. |
| 4 | `"mirrors the VC2A projectSemantic placeholder pattern"` / `"deterministic placeholder projectHead"` | `src/vector-cortex/encoder/heads.ts:11,146` | VC2A | Shipped; the placeholder *pattern* is still the committed default (ML5-A trained heads are not bundled) | **(c) ENC-defer / context-correct** — accurate; no edit. |
| 5 | `"This frozen threshold is a normative placeholder"` | `src/vector-cortex/encoder/calibrate.ts:128` | n/a (current-state) | Accurate current-state (real calibration arrives with ENC) | **context-correct** — no edit. |
| 6 | `"S33 wired the real scoring: getTurnLevelImpl"` | `extensions/mega-runtime/widget-types.ts:58` | S33 | Shipped — S33 wired `getTurnLevelImpl` (the claim is POST-S33, describing what S33 did, not a stale "until S33") | **(b) DASH-defer** — handoff: the comment says "S33 wired" (past tense), so it is not a stale placeholder claim but rather a historical note. Already owned by DASH-0a sprint task 7 (`widget-types.ts:58` comment-only fix). DOC does NOT edit; records only. |
| 7 | `"A pinned digest of '0' is a placeholder"` | `src/vector-cortex/reconstruct/validate.ts:65` | n/a (current-state) | Accurate current-state (the sentinel `"0"` digest is still the placeholder for tiers that did not compute a per-shard digest) | **CONFORM-defer** — handoff. CONFORM-HYGIENE sprint task 2 already owns this sentinel fix. DOC records only. |
| 8 | `"endpoints are ILLUSTRATIVE until VC0D wires a persistent instance"` | `extensions/mega-runtime/vector-cortex-safety.ts:28` | VC0D | Shipped (`4d9f8f9`) — but VC0D wired 9 subsystems into production, and the breaker `stateSource` is still `"ephemeral"` on master | **context-correct** — the claim is accurate current-state: the breaker instance is still ephemeral even after VC0D. The `stateSource:"ephemeral"` field (line 32) is the signal that the dashboard never presents it as a live breaker. No edit. |
| 9 | `"they stay static/no-op until VC0D wires a persistent breaker instance"` | `extensions/mega-runtime/vector-cortex-safety.ts:148` | VC0D | Same as #8 — VC0D shipped but did not make the breaker persistent | **context-correct** — accurate; `stateSource:"ephemeral"` is still the live signal. No edit. |
| 10 | `"the LCG stub serves mode A byte-identical to the predecessor"` | `src/vector-cortex/encoder/encoder-onnx-dispatch.ts:17` | n/a (current-state) | Accurate — the stub is still the mode-A default | **(c) ENC-defer / context-correct** — accurate; no edit. |
| 11 | `"the committed placeholder asset (assets/vector-cortex/encoder-v1/)"` | `src/vector-cortex/encoder/types.ts:38` | n/a (current-state) | The committed asset is still the 42-byte placeholder | **(c) ENC-defer / context-correct** — accurate; no edit. |

## Summary

**Total hits:** 11 (across 7 files)
**(a) stale-claim fixes applied:** 0 (empty — every named placeholder claim resolves to a DASH/ENC/CONFORM handoff or is accurate current-state)
**(b) DASH-defer handoffs:** 1 (`widget-types.ts:58`, owner DASH-0a task 7)
**(c) ENC-defer handoffs:** 5 (`runtime.ts:233`, `runtime.ts:285`, `runtime-select.ts` p95 comments, `heads.ts`, `calibrate.ts` — owner ENC workstream)
**CONFORM-defer handoffs:** 1 (`validate.ts:65`, owner CONFORM-HYGIENE task 2)
**context-correct (no edit):** 4 (`runtime-select.ts:44/100/153`, `vector-cortex-safety.ts:28/148`, `encoder-onnx-dispatch.ts:17`, `types.ts:38`)

## Handoffs

### DASH-defer
- `extensions/mega-runtime/widget-types.ts:58` — owner **DASH-0a** sprint task 7. The comment is a historical note ("S33 wired"), not a stale "until" claim; DASH-0a owns its comment-only cleanup.

### ENC-defer
- `src/vector-cortex/encoder/runtime.ts:233` — `benchRecord: null` placeholder; real `BenchResultV1` wiring owned by **ENC-0b**/`ENC-0d`.
- `src/vector-cortex/encoder/runtime.ts:285` — LCG placeholder drives infer; real ONNX trunk owned by **ENC-0b** (bge-small int8 model).
- `src/vector-cortex/encoder/runtime-select.ts:44,100,153` — 42-byte placeholder has no measured p95; real p95 arrives with **ENC-0f** (RSS/p95 qualification budget).
- `src/vector-cortex/encoder/heads.ts:11,146` — VC2A placeholder pattern for `projectHead`; trained heads owned by **ENC-0c** (five-head training).
- `src/vector-cortex/encoder/calibrate.ts:128` — frozen threshold is a normative placeholder; real calibration owned by **ENC** workstream.

### CONFORM-defer
- `src/vector-cortex/reconstruct/validate.ts:65` — `"0"` digest sentinel; owner **CONFORM-HYGIENE** sprint task 2.

## Gate

- `git diff --stat` on the DOC-0b commit shows ONLY: this report (new), the spec file (already present, unchanged), and `scripts/vector-cortex-docs-check.mjs` (EXPECTED_SPRINTS reconciliation only).
- `git diff` on any DASH/ENC/CONFORM file: **empty** (they are untouched by this sprint).
- `node scripts/vector-cortex-docs-check.mjs`: passes with `EXPECTED_SPRINTS` reconciled.
- `node scripts/vector-cortex-conformance.mjs --check`: 944 fixtures canonical (zero delta — no fixtures added).
