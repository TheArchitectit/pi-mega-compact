# DOC-0b — Placeholder-scan audit report and deferred handoff gate

**Status:** planned | **Depends on:** none (docs-only hygiene over already-shipped tree state) | **Phase:** DOC
**Flag:** none — this is a **pure-hygiene docs sprint** with NO runtime flag, NO `SETTINGS` integration, and NO behavior change. It produces one audit report doc and applies comment-only edits to files whose referenced sprint has SHIPPED. Use the docs/gate marker line `MEGACOMPACT_DOC_0B` (a documentation marker only, never an env flag, never wired into any runtime path, never added to `SETTINGS`) so `scripts/vector-cortex-docs-check.mjs`'s positive-`MEGACOMPACT_*` flag-line rule passes — the `MEGACOMPACT_CONFORM_HYGIENE` precedent.

## Goal and inputs/outputs

Sweep the tree for **justification-style comments** that assert a "placeholder" / "stub" / "until \<sprint\> wires it" / "next sprint wires it" that is now stale because the referenced sprint has shipped, and route every hit to a disposition. This sprint is the single, durable record of the placeholder landscape so that (a) truly stale claims are corrected in place (comment-only, zero behavior change), (b) claims owned by the DASH workstream are handed off without editing, and (c) claims owned by the ENC workstream are handed off without editing. Conformance note: this sprint does **NOT** add conformance fixtures; the registry/manifest are untouched.

The sweep scope is `src/vector-cortex/` (esp. `encoder/`), `extensions/**`, and `scripts/` — non-test source and tooling. The deliverable is a single report `docs/vector-cortex/placeholder-audit-report.md` listing each hit with `path:line`, whether the referenced sprint has shipped (git tag), and the disposition. DOC edits ONLY the **(a) stale-claim fix** set; (b) and (c) are recorded as handoffs.

Inputs: the shipped tree on `master` (v0.20.42), git tags (shipped-status authority), the DASH/ENC workstream specs, and the current comment text. Outputs: `docs/vector-cortex/placeholder-audit-report.md` (new) plus zero-or-more comment-only edits on files whose referenced sprint has shipped and which the audit classifies as (a).

Production ownership (exact file list — scope-check is satisfied by this exact set):
- `docs/vector-cortex/placeholder-audit-report.md` (NEW — the single audit report)
- Zero or more **comment-only** edits on the audit's (a)-classified files (expected **empty/near-empty** — see the disposition table below: every named placeholder claim routes to a DASH or ENC handoff). The audit report names the exact (a) files; if none, DOC edits only the report.
- `docs/vector-cortex/sprints/DOC-0b-placeholder-scan-and-deferred-gate.md` (this spec)
- `scripts/vector-cortex-docs-check.mjs` — `EXPECTED_SPRINTS` count reconciliation only (this sprint adds a sprint file; same single-numeric-value reconciliation DOC-0a performs; see DOC-0a's "Scope deviation" note — it applies identically here and to its DOC sibling).

Cross-cutting seams: none required. The DASH-defer (`extensions/mega-runtime/widget-types.ts:58`) and ENC-defer (`src/vector-cortex/encoder/runtime.ts`, `runtime-select.ts`) files are explicitly NOT edited by this sprint — they are recorded as handoffs, per the brief. If the implementer edits any of them, that is a scope bug and the controller kills it.

## Disposition (verified against the tree on master)

| Hit | path:line | Referenced sprint shipped? | Disposition |
| --- | --- | --- | --- |
| "placeholder: real BenchResultV1 wiring ships in ML5-E" | `src/vector-cortex/encoder/runtime.ts:222` | ML5-E SHIPPED (v0.20.41) but WITHOUT wiring the bench record (code still passes `benchRecord: null`) — the claim is stale | **(c) ENC-defer** — handoff, not edit. The real `BenchResultV1` wiring is the ENC workstream's goal; DOC records the stale claim in the report only. |
| "the LCG placeholder STILL drives infer by default ... only the runtime-selection event seam was added this sprint" | `src/vector-cortex/encoder/runtime.ts:265` | "this sprint" = ML5-C, SHIPPED (v0.20.39) | **(c) ENC-defer** — the trained asset remains non-authoritative; the real-asset source-of-truth is the ENC workstream (`ENC-0b` / `ENC-0d`). Recording only. |
| "placeholder 42-byte asset has no measured p95" (x3) | `src/vector-cortex/encoder/runtime-select.ts:38,91,134` | The 42-byte placeholder still exists on master; the claim is **accurate current-state** | **context-correct** — no edit. Real p95 arrives with the ENC real-asset work. |
| "mirrors the VC2A projectSemantic placeholder pattern" / "deterministic placeholder projectHead" | `src/vector-cortex/encoder/heads.ts:11,146` | VC2A SHIPPED; the placeholder *pattern* is still the committed default (ML5-A trained heads are not bundled) | **(c) ENC-defer / context-correct** — accurate; no edit. |
| "This frozen threshold is a normative placeholder" | `src/vector-cortex/encoder/calibrate.ts:128` | Accurate current-state (real calibration arrives with ENC) | **context-correct** — no edit. |
| "Stub = 1 until S33 wires the real scoring" | `extensions/mega-runtime/widget-types.ts:58` | S33 SHIPPED and wired `getTurnLevelImpl` (`runtime-helpers.ts:115-119`) — claim is stale | **(b) DASH-defer** — handoff. **Already owned by DASH-0a sprint task 7** (`widget-types.ts:58` comment-only fix). DOC does NOT edit; records only. |
| "A pinned digest of '0' is a placeholder" | `src/vector-cortex/reconstruct/validate.ts:65` | — | **CONFORM-defer** — handoff. CONFORM-HYGIENE sprint task 2 already owns this sentinel fix. DOC records only. |
| VC9 "in flight" reminders | (audit-wide) | All VC9× shipped (v0.20.27–30) | **sweep result**: my verification found NO remaining "in flight"/"ships next" remarks referencing VC9 in non-test `src/vector-cortex/` or `extensions/**`. If the audit surfaces any beyond the above, and the referenced sprint has shipped with no live handoff, classify **a** and fix. |

**Expected (a) edit set: empty by default.** Every named placeholder claim resolves to a DASH/ENC/CONFORM handoff or is accurate current-state. The audit report therefore records dispositions and, where the brief's named claims are the only hits, performs zero comment edits. If the implementer finds additional stale "until \<sprint\> wires" claims whose sprint has shipped AND no workstream owns them, those become the (a) comment-only edits — but the expected set is none, and the report is the concrete deliverable.

## Numbered implementation tasks

1. **`EXPECTED_SPRINTS` reconciliation is owned by the integration step.** Same as DOC-0a task 1: the program's 15 new sprint docs land in one commit set; the integration pass sets `EXPECTED_SPRINTS` to the true count — **60** — in `scripts/vector-cortex-docs-check.mjs`. `EXPECTED_PHASES` (11) untouched by this sprint (integration adds the program's phase files). The invariant is `EXPECTED_SPRINTS === ` literal directory count, asserted at integration time.
2. **Produce `docs/vector-cortex/placeholder-audit-report.md`.** One doc containing: (a) a scope note (sweep of `src/vector-cortex/`, `extensions/**`, `scripts/` non-test; conformance registry/manifest NOT touched, no fixtures added); (b) a table mirroring the Disposition table above with, for each hit: `path:line`, the quoted comment, the referenced sprint + whether it shipped (with the git tag for shipped), and the disposition `a`/`b`/`c`/context-correct; (c) an explicit "handoffs" section naming the DASH-defer (`widget-types.ts:58`, owner `DASH-0a`), the ENC-defer set (`runtime.ts:222`, `runtime.ts:265`, `runtime-select.ts` p95 comments, `heads.ts`, `calibrate.ts` — owner ENC workstream), and the CONFORM-defer (`validate.ts:65`, owner CONFORM-HYGIENE); (d) a "shipped-status authority" note describing how `git tag` determined each referenced sprint's shipped status.
3. **Apply the (a) stale-claim fixes, if any.** For every hit the audit classifies (a), make a comment-only edit (reword the stale claim to the true current-state or drop the obsolete "ships in \<sprint\>" clause). Each edit changes zero code tokens, so emitted JS is byte-identical; verify with `git diff` that ONLY comment text changed. Expected set: none (see above).
4. **Run the full project gate** (exit-evidence) and confirm the report's path:line references are accurate against the committed tree.
5. **Reconciliation note.** This sprint writes no `docs/vector-cortex/evidence/DOC-0b.md` record (brief forbids `evidence/` touches for DOC sprints). The audit report itself is the durable record; it stands alone without an aggregator.

## Failure triad and independence

A **sweep + report** — the audit report exists, lists every verified placeholder hit with correct `path:line`, and each referenced sprint's shipped-status is backed by a git tag; no named placeholder claim is dropped. B **disposition correctness** — every hit is routed to exactly one of (a) edit / (b) DASH-defer / (c) ENC-defer / CONFORM-defer / context-correct, and DOC edits ONLY the (a) set (expected empty); the DASH/ENC files are verifiably untouched by this sprint's commit. C **gate + count** — `EXPECTED_SPRINTS` equals the literal `sprints/` count, `docs-check` passes, and the (a) comment edits (if any) are byte-safe on emitted JS. Independence: the report is read by the reviewer, the handoff ownership is checked against the DASH/ENC specs, and the count is checked by docs-check — a failure in one surface cannot masquerade as closure in another. No runtime code path changes in any arm; flag-off is **N/A** (no flag).

## Tests, fixtures, and assertions

**Test sources: NONE** — state explicitly this is a docs/comment-only sprint with **no new test files** and no edits to existing tests. **Acceptance aggregator: NONE** — state explicitly the audit report stands alone without an aggregator (the CONFORM-HYGIENE precedent). **No new conformance fixtures; registry/manifest untouched** — the conformance register is preserved exactly; the `vector-cortex-conformance.mjs --check` gate must pass with no delta.

Expected assertions:
- `docs/vector-cortex/placeholder-audit-report.md` exists and names all hits from the Disposition table with correct `path:line`.
- `git tag`-backed shipped-status for every referenced sprint in the report.
- `git diff --stat` on the commit shows ONLY the new report, this spec, the (a) comment-edit files (if any), and the single-line docs-check count edit; `git diff` on any DASH/ENC file is empty (they must be untouched).
- Any (a) comment edit is comment-only: `git diff -w` shows text inside `//` or `/* */` and no token change in the surrounding code; emitted JS byte-identical (verify with a build + compare, or rely on the fact that comments never affect the emitted bundle).
- `node scripts/vector-cortex-docs-check.mjs` passes with `EXPECTED_PHASES` unchanged.

## Unique failure injection

The audit report is disposed identically to DOC-0a's verifier for anti-regression: the report's disposition table has no separate executable seam (this sprint's concrete code output is expected empty), so the unique gate is the report's accuracy — a reviewer reads each `path:line` against the shipped tree, and the DASH/ENC handoff ownership is cross-checked against the `DASH-0a` and `ENC-0a..f` sprint specs. If a future sprint reintroduces a stale "ships in \<shipped-sprint\>" claim, the report records the regression and gates it. (DOC-0a owns the executable drift verifier `scripts/doc-drift-check.mjs`; DOC-0b defers to that seam for the evidence-stamp half and this report for the comment half.)

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no migration, no schema/state change, no runtime migration.** Privacy: **none — docs/comment only; no payload, no network, no user data.** Dashboard: NOT touched — no route/contract/client/server change; the DASH-defer file is deliberately left to DASH-0a. The `cd extensions/dashboard-client && npm run typecheck && npm run build` gate is therefore NOT mandatory; state the skip explicitly.

Flag-off command: **N/A** — no runtime flag; `MEGACOMPACT_DOC_0B` is a docs-check positive-flag marker only, never wired anywhere.

Rollback: **`git revert`** of the single DOC-0b commit restores every edited doc/comment to its prior byte content; since no runtime path changes, revert is observationally silent and any (a) comment edits (expected none) revert without behavioral delta.

## Exit evidence

Run the project gates; scope-check passes trivially by this exact-file-list ownership; `vector-cortex-evidence-check DOC-0b` is **N/A** (no evidence record created). Full list:

```bash
npm run build                      # no src change; tree still compiles
npm test                           # no test change; nothing broke
npm run lint                       # fresh only; doc-drift-check side clean
node scripts/doc-drift-check.mjs   # DOC-0a's verifier still green (shared seam)
node scripts/vector-cortex-docs-check.mjs   # EXPECTED_SPRINTS reconciled to the true count
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check   # registry/manifest untouched, zero delta
node scripts/vector-cortex-scope-check.mjs DOC-0b <COMMIT_SHA>   # every committed file in the exact Production ownership list
# vector-cortex-evidence-check DOC-0b — N/A: no evidence record created by this sprint
git diff --check
```

The dashboard-client gate is SKIPPED by scope declaration (no dashboard touch); note the skip in the commit body. Like DOC-0a, the program's `EXPECTED_SPRINTS` reconciliation (45→60) is integration-owned; this sprint performs no per-sprint bump (the CONFORM-HYGIENE / DEDUP-ATTR reconciliation precedent).
