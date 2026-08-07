# PC — Prompt Cache Flag Rollout (Retro)

**Phase:** `docs/vector-cortex/phases/PC-prompt-cache-rollout.md` (sprints PC-A…PC-D)
**Retro created:** 2026-08-07 (CONFORM-HYGIENE, retroactive per framework §5)
**Scope:** defect records for defects found *after* the PC phase landed, mapped to
the PREVENT rule that now covers each and the corrective action. This closes the
"found late → now instrumented" loop.

| Defect found after landing | PREVENT rule now covering it | Corrective action that landed |
|---|---|---|
| **PC-D spec-vs-actual arithmetic drift** — `evidence/PC-D.md:16` had to correct hand-maintained spec counts (sprints 36→37, fixtures 795→811); the evidence carried the authoritative numbers instead of the stale spec (audit Table 5-B). | **PREVENT-SPEC-DRIFT-001** (error) | `scripts/vector-cortex-docs-check.mjs` now derives the fixture count and reserved-range closure from `conformance/vector-cortex/v2/manifest.json` instead of literals; `EXPECTED_SPRINTS` stays a documented constant. A divergent literal is now a check failure at sprint exit, not an ad-hoc courtesy fix. |
| **EVAL projection-guard prose IDs used by PC/VC evidence were absent from the manifest** — `EVAL-BUCKET-001`, `EVAL-ORDER-003`, `EVAL-REDACT-002` are referenced by `PC` phase doc (`EVAL-REDACT-002` in phase Failure section) and every PC/VC evidence record as projection guards, but had no manifest rows (audit Table 4). | Conformance-grows-monotonically + **PREVENT-SPEC-DRIFT-001** | Registered the EVAL trio as `prose-id` dispositions in `manifest.json` `reservedRanges` and documented them in the CONFORM-HYGIENE evidence; the trio is no longer "claimed in docs but absent from the manifest". |
| **Hand-maintained `EXPECTED_SPRINTS`/indices drifted** (framework §5 observed the whole class, seeded by PC-D) | **PREVENT-SPEC-DRIFT-001** | Bounded: `vector-cortex-docs-check.mjs` recomputes counts from live glob + manifest at check time (framework §3.4). |

Net new coverage added by this retro: **PREVENT-SPEC-DRIFT-001 enforced end-to-end** —
the drift class PC-D first surfaced is now a deploy-blocking docs-check failure.
