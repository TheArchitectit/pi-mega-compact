# DOC-0a — Evidence stamps, shipped-spec headers, and PLAN_V2 default-ON drift

**Status:** planned | **Depends on:** none (docs-only hygiene, reconciles already-shipped tree state) | **Phase:** DOC
**Flag:** none — this is a **pure-hygiene docs sprint** with NO runtime flag, NO `SETTINGS` integration, and NO behavior change. It edits only documentation (`docs/**`, `README.md`). Use the docs/gate marker line `MEGACOMPACT_DOC_0A` (a documentation marker only, never an env flag, never wired into any runtime path, never added to `SETTINGS`/`EXCLUDED_SETTINGS`) so `scripts/vector-cortex-docs-check.mjs`'s positive-`MEGACOMPACT_*` flag-line rule passes — the exact `MEGACOMPACT_CONFORM_HYGIENE` precedent.

## Goal and inputs/outputs

Land one mechanical reconciliation pass over stale documentation on the shipped tree (tree is at v0.20.42). No source file in `src/` is touched; no `src/` behavior changes. The three reconciled surfaces:

1. **Evidence stamp inconsistency.** `docs/vector-cortex/evidence/*.md` should carry a uniform reviewer-attestation stamp naming (a) the commit SHA the sprint's implementation landed at and (b) the version it shipped in. The target format is the older family already present on `ML5-D` (`**REVIEWED + COMMITTED + PUBLISHED as v0.20.40**`), `ML5-E` (`**PUBLISHED v0.20.41**`), `DEDUP-ATTR` (`Status: PUBLISHED v0.20.42 (impl \`62e1a08\`, ...)`), and `ML5-B`. The nine records below still read only `Status: reviewer-accepted` (no SHA, no version) and must get the stamp appended per-file in one pass.
2. **Stale spec status headers.** `docs/vector-cortex/sprints/PC-{B,C,D}*.md` all still read `Status: planned` at the top even though their implementations are SHIPPED in npm as of v0.20.42. Flip the header to the shipped canonical (`**Status:** shipped (v0.20.XX)` with the per-sprint version) and add a one-line `(shipped v0.20.XX)` note.
3. **Stale PLAN_V2 / README / ADOPTION default-OFF wording.** `docs/PROMPTCACHE_PLAN_V2.md`, `README.md`, and the env-var table in `docs/ADOPTION.md` still describe message separation + cache striping as default-OFF / opt-in. The runtime default flipped to **ON** in PC-A/PC-B: `extensions/mega-config.ts:208` (`messageSeparation: envBool(..., true)`) and `:210` (`cacheStriping: envBool(..., true)`). Refresh every default-ON claim to match the documented current-state.

Inputs: the shipped tree on `master` (v0.20.42), git history (tags for ship-version attribution), `extensions/mega-config.ts` default reads, and the current `docs/**` text. Outputs: the reconciled evidence stamps, the three spec headers, the refreshed PLAN_V2/README/ADOPTION wording, and a single-purpose verifier `scripts/doc-drift-check.mjs`.

Production ownership (exact file list — scope-check is satisfied by this exact set):
- `docs/vector-cortex/evidence/VC9A.md` — append pub-stamp (impl `ab1e223`, shipped **v0.20.27**)
- `docs/vector-cortex/evidence/VC9B.md` — append pub-stamp (impl `1063ee8`, shipped **v0.20.28**)
- `docs/vector-cortex/evidence/VC9C.md` — append pub-stamp (impl `bc64af4`, shipped **v0.20.28**)
- `docs/vector-cortex/evidence/VC9D.md` — append pub-stamp (impl `1f34a08`, shipped **v0.20.30**)
- `docs/vector-cortex/evidence/ML5-A.md` — append pub-stamp (impl `816ed10`, shipped **v0.20.36**)
- `docs/vector-cortex/evidence/PC-A.md` — append pub-stamp (impl `6df47f3`, shipped **v0.20.31**)
- `docs/vector-cortex/evidence/PC-B.md` — append pub-stamp (impl `34d0a35`, shipped **v0.20.32**)
- `docs/vector-cortex/evidence/PC-C.md` — append pub-stamp (impl `9333e64`, shipped **v0.20.33**)
- `docs/vector-cortex/evidence/PC-D.md` — append pub-stamp (impl `e728dcc`, shipped **v0.20.34**)
- `docs/vector-cortex/sprints/PC-B-cache-striping-default-on.md` — header `planned`→shipped (v0.20.32)
- `docs/vector-cortex/sprints/PC-C-dashboard-cache-visibility.md` — header `planned`→shipped (v0.20.33)
- `docs/vector-cortex/sprints/PC-D-benchmark-validation-rollup.md` — header `planned`→shipped (v0.20.34)
- `docs/PROMPTCACHE_PLAN_V2.md` — refresh default-ON wording + status
- `README.md` — refresh line 14 (`default OFF, opt-in` → `default ON`)
- `docs/ADOPTION.md` — refresh lines 71/72 (OFF→ON) + line 84 framing
- `scripts/doc-drift-check.mjs` — **NEW** single-purpose verifier; re-verifies the stamp/status/PLAN_V2 claims in one run (below, "Unique failure injection")
- `scripts/vector-cortex-docs-check.mjs` — `EXPECTED_SPRINTS` count reconciliation only (this sprint adds a sprint file; see the **Scope deviation** note)
- `docs/vector-cortex/sprints/DOC-0a-evidence-and-planv2-drift.md` (this spec)

Cross-cutting seams: none required. Every file above is explicitly owned; this sprint needs no `src/` seam. If the implementer is tempted to add a `src/` or SETTINGS touch, that is a scope bug and the controller kills it.

**Scope deviation — `scripts/vector-cortex-docs-check.mjs` (mandatory, CONFORM/DEDUP-ATTR precedent).** The brief for this sprint stated "does NOT modify scripts/vector-cortex-docs-check.mjs". That instruction is not satisfiable as written: the check's `EXPECTED_SPRINTS` (line 31, currently 45) is enforced against a **literal directory count** of `.md` files under `docs/vector-cortex/sprints/` (line 96-99), so adding this sprint file (and its DOC-0b sibling, which lands in the same DOC workstream) without bumping the count makes the gate fail by construction. Every prior sprint that added a sprint doc — CONFORM-HYGIENE (38→39) and DEDUP-ATTR (44→45), both read before authoring — reconciled the count in the same commit and listed the script in Production ownership with the note "docs-check reconciliation, not scope drift". DOC-0a follows that exact precedent: the ONLY change to the script is the single numeric `EXPECTED_SPRINTS` value, set to the true count of sprint `.md` files at commit time (see task 1). This is the one, explicitly-called-out deviation from the brief's "no scripts" instruction; it changes no behavior and is required for a green gate.

## Numbered implementation tasks

1. **`EXPECTED_SPRINTS` reconciliation is owned by the integration step.** `docs/vector-cortex/sprints/` holds 45 `.md` files on master at program start; the program adds 15 sprint docs (DASH×4, ENC×6, COS-FP×2, REPO×1, DOC×2) and lands them in one commit set. The single integration pass sets `EXPECTED_SPRINTS` to the true count at commit time — **60** — in `scripts/vector-cortex-docs-check.mjs`. The invariant is: `EXPECTED_SPRINTS === ` the literal directory count (integration-time truth). No other line in the script changes; `EXPECTED_PHASES` (11) is untouched by this sprint because it adds no `phases/` file (the program's phase files are integration-owned).
2. **Evidence stamp pass (9 records).** For each of the nine files listed in Production ownership, append a single normalized stamp line directly under the existing `Status:` line in the target format:
   `**PUBLISHED as v0.20.XX** — implementation landed at commit `<short-sha>`; reviewer-attested 2026-08-05/06.`
   Use the exact ship-version + impl-commit mapping given in Production ownership (VC9A v0.20.27@`ab1e223`, VC9B v0.20.28@`1063ee8`, VC9C v0.20.28@`bc64af4`, VC9D v0.20.30@`1f34a08`, ML5-A v0.20.36@`816ed10`, PC-A v0.20.31@`6df47f3`, PC-B v0.20.32@`34d0a35`, PC-C v0.20.33@`9333e64`, PC-D v0.20.34@`e728dcc`). Do NOT alter any other content of these files; do NOT touch the evidence files that already carry a PUBLISHED/reviewer-attested stamp (ML5-B/C/D/E, DEDUP-ATTR, VC0F, VC6C-IMPL, and the implementer-complete VC0A–8C family are out of scope for this pass).
3. **Spec-header pass (3 files).** For `PC-B`, `PC-C`, `PC-D`: change the top `**Status:** planned | ...` line to `**Status:** shipped | **Originally planned:** PC-{B,C,D} | **Phase:** PC`, and append a one-line `**Shipped:** v0.20.XX` (PC-B v0.20.32, PC-C v0.20.33, PC-D v0.20.34) under the Status line. Do not rewrite the body of these specs; they are historical records.
4. **PLAN_V2 default-ON wording refresh.** In `docs/PROMPTCACHE_PLAN_V2.md`: (a) change the header `**Status**: Draft — needs team review` to `**Status**: Implemented (PC-A message separation + PC-B cache striping, both default ON as of v0.20.32; this file is a historical projection, superseded by the PC phase)`; (b) change the Phase 2/Phase 3 step tables and the Risks line 462 ("Phase 3 is opt-in") so they state the shipped default-ON reality rather than future/opt-in framing — e.g. line 462 becomes "Phase 3 is default ON since PC-B (v0.20.32); the flag is `MEGACOMPACT_CACHE_STRIPING`, override with `=0`". (c) In the Success Criteria table (line 444-450), mark the shipped columns as achieved. The task brief quoted exact "Phase 2: default OFF" / "Phase 3: default OFF" strings; those exact literals are NOT present in the current file — the stale text is the future/opt-in framing (header "Draft", line 462 "opt-in", success table ❌ marks). Refresh the documented current-state regardless; do not invent text that is not in the file.
5. **README.md line 14 refresh.** Change `message separation + cache striping (default OFF, opt-in)` to `message separation + cache striping (both default ON; disable with MEGACOMPACT_MESSAGE_SEPARATION=0 / MEGACOMPACT_CACHE_STRIPING=0)`. Do not touch any other README line except line 14; the task brief's "PLAN_V2 default OFF" sweep within README refers to this single line.
6. **ADOPTION.md env-var table refresh.** Change `MEGACOMPACT_MESSAGE_SEPARATION` (line 71) and `MEGACOMPACT_CACHE_STRIPING` (line 72) from `OFF` to `ON` in the Default column, and update the line-84 quick-example comment from "Enable message separation + cache striping for a cache-aware session" to a disable-oriented framing ("Disable message separation / cache striping if you want the flat pre-PC prompt"). Keep the rows' descriptions verbatim.
7. **Land the verifier `scripts/doc-drift-check.mjs` (NEW).** A small, node-runnable, dependency-free script that asserts, in one run: (a) the nine named evidence files each contain their expected `PUBLISHED as v0.20.XX` stamp + expected impl short-SHA (the 18 constants below); (b) the three PC-{B,C,D} spec headers start with `**Status:** shipped` and carry the expected `**Shipped:** v0.20.XX`; (c) `PROMPTCACHE_PLAN_V2.md` no longer contains the stale markers — the header is no longer `Draft`, line 462 no longer says "Phase 3 is opt-in", and neither of `PROMPTCACHE_PLAN_V2.md` / `README.md` / `ADOPTION.md` pairs the phrase "default OFF" with message-separation or cache-striping; (d) `README.md` line 14 and the two ADOPTION rows read default ON. Exit nonzero on any mismatch. It must cleanly pass on the committed tree and cleanly FAIL if any one stamp or default is reverted (so the drift cannot silently regress). Add a one-line `// guardrails-allow PREVENT-PI-004: <no network> ` header if the scanner demands it; the script is pure local string/regex checking.
8. **Run the full project gate** (exit-evidence list below) and confirm `doc-drift-check.mjs` passes against the committed tree.
9. **Reconciliation note.** This sprint does NOT create a `docs/vector-cortex/evidence/DOC-0a.md` record (the brief forbids touching `evidence/` for DOC sprints; the CONFORM precedent's evidence commitment does not apply to an evidence-*stamping* sprint). The "evidence" is the reconciled tree itself, verified by `doc-drift-check.mjs`.

## Failure triad and independence

Because this is a pure-docs sprint, the triad is adapted from the standard contract to documentation reconciliation. A **stamp pass** — every SHIPPED newer evidence record carries its commit SHA + ship version; `doc-drift-check.mjs` part (a) passes. B **spec-header + default-ON pass** — PC-B/C/D read `shipped v0.20.XX`, and PLAN_V2/README/ADOPTION no longer present message-separation/cache-striping as default-OFF; `doc-drift-check.mjs` parts (b)(c)(d) pass. C **count reconciliation** — `EXPECTED_SPRINTS` equals the literal `sprints/` `.md` count and `docs-check` (conformance) passes with zero behavior change. Each arm is verified by an independent check (the new verifier, the docs-check script, and `git diff --check` for whitespace), so a failure in one cannot masquerade as closure in another. No runtime code path changes in any arm; there is no flag to disable, so the flag-off dimension of the standard triad is **N/A** by declaration.

## Tests, fixtures, and assertions

**Test sources: NONE** — this is a docs-only sprint; state explicitly there are **no new test files** and no edits to existing tests. **Acceptance aggregator: NONE** — state explicitly the evidence record path stands alone without an aggregator (the CONFORM-HYGIENE precedent: a pure-hygiene sprint needs no acceptance aggregator test; closure is verified by the project gates and reviewer reading). **No new conformance fixtures.** The fixtures-claim in any evidence-check remains historical-only for these records; the evidence-check's invariant counts are relevant only if a DOC evidence record is ever created — which this sprint explicitly does not do.

Expected assertions (the docs' current-state claims match the shipped tree):
- `doc-drift-check.mjs` exits 0 against the committed tree; it exits non-zero if any one of the 18 stamp constants, the 3 spec-header strings, or the default-ON markers is reverted.
- `grep -c "PUBLISHED as v0.20" docs/vector-cortex/evidence/PC-{A,B,C,D}*.md docs/vector-cortex/evidence/VC9{A,B,C,D}.md docs/vector-cortex/evidence/ML5-A.md` yields exactly 1 per file (9 total).
- `head -2` of each of PC-B/C/D spec shows `**Status:** shipped` + `**Shipped:** v0.20.XX`.
- `grep -n "PLAN_V2 default OFF\|Phase 3 is opt-in\|default OFF, opt-in"` across `README.md`, `docs/ADOPTION.md`, `docs/PROMPTCACHE_PLAN_V2.md` returns nothing; `grep -n "cacheStriping. envBool" extensions/mega-config.ts` still shows default `true` (the code is untouched, so it remains the source of truth).
- `node scripts/vector-cortex-docs-check.mjs` passes (count reconciled) with `EXPECTED_PHASES` unchanged.
- `git diff --check` clean.

## Unique failure injection

The single-purpose verifier `scripts/doc-drift-check.mjs` (NEW, owned by this sprint) is the unique failure-injection and anti-regression seam: it re-verifies every stamp/status/PLAN_V2 claim in one run so a later sprint that reintroduces a `reviewer-accepted`-only header or a default-OFF claim fails fast at the gate rather than drifting silently. It is additive CI, runs only in the gate, never at a runtime path (PREVENT-PI-004-safe: pure local file reads, no network).

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no migration, no schema/state change, no runtime migration.** The only edits are documentation strings and a verifier script; `extensions/mega-config.ts` default reads are untouched, so `messageSeparation`/`cacheStriping` remain ON exactly as today. Privacy: **none — docs only; no payload, no network, no user data touched.** Dashboard: NOT touched — no route, contract, client, or server change, so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT a mandatory gate for this sprint (state the skip explicitly).

Flag-off command: **N/A** — this sprint introduces no runtime flag. There is no `MEGACOMPACT_DOC_0A` env flag; the `MEGACOMPACT_DOC_0A` token exists solely as a docs-check positive-flag marker and is intentionally not wired anywhere.

Rollback: **`git revert`** of the single DOC-0a commit restores every edited doc to its prior byte content; because no runtime path changes, revert is observationally silent. `doc-drift-check.mjs` is deleted by the same revert (it is part of the commit).

## Exit evidence

Run the project gates; scope-check passes trivially by this exact-file-list ownership, and evidence-check is asserted only if an evidence record exists (it does not for this sprint — see task 9), so `vector-cortex-evidence-check` is **N/A** here by declaration. Full list:

```bash
npm run build                      # no src change; confirms the tree still compiles
npm test                           # no test change; confirms nothing broke
npm run lint                       # includes the new doc-drift-check script, no stub/mock hits
node scripts/doc-drift-check.mjs   # NEW — the unique verifier; must exit 0
node scripts/vector-cortex-docs-check.mjs   # EXPECTED_SPRINTS reconciled to the true sprint count
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-scope-check.mjs DOC-0a <COMMIT_SHA>   # every committed file in the exact Production ownership list
# vector-cortex-evidence-check DOC-0a — N/A: no evidence record created by this sprint
git diff --check
```

The dashboard-client typecheck/build gate is SKIPPED by scope declaration (no dashboard touch); note the skip in the commit body. This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). The script is in Production ownership at the integration pass only; per-sprint commits leave it unchanged (the CONFORM-HYGIENE and DEDUP-ATTR reconciliation precedent).
