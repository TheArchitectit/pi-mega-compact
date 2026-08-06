# Phase DOC — Documentation Drift & Hygiene

**Status:** planned | **Depends on:** all other phase specs in this program (placeholder audit consumes their handoffs) | **Phase:** DOC
**Flag scope:** none — pure-docs phase. No new `MEGACOMPACT_*` flag, no runtime config change. The placeholder-audit script is developer tooling wired as a no-op-friendly check alongside docs-check.

## Premise

Nine evidence files carry `Status:` values that have drifted from the shipped tag history (still `REVIEWED`/`implementer-complete` when the shipped version is PUBLISHED); three PC sprint headers (PC-B/C/D) say `planned` for shipped sprints; PLAN_V2 still says `Draft` while its anchor-floor filter chain is shipped; the README and ADOPTION guide claim "opt-in" when prompt-cache striping is default-ON. Meanwhile no systematic check exists for placeholders, TODOs, or stale deferral markers across the entire docs/ + sprints/ corpus — drift accumulates silently.

DOC-0a fixes the nine drift targets (stamps, headers, PLAN_V2 status, README/ADOPTION refresh). DOC-0b builds the placeholder-audit script (`scripts/doc-drift-check.mjs`), runs it, and dispositions every finding: expected-edit items are handed to their owning sprint specs; structural gaps are recorded in the audit report.

## Architectural invariants (do not violate)

1. **No runtime change** — DOC touches only `docs/`, `conformance/` manifests (PUBLISHED stamps only), and one new script (`scripts/doc-drift-check.mjs`). No `src/` or `extensions/` files change.
2. **Stamp-only edits to evidence files** — evidence status fields advance to PUBLISHED with the correct version; no retroactive edits to evidence bodies (append-only attestation rows only).
3. **PC-B header consistency** — the PC-B spec and the PC-B evidence file agree on the memory-map/enrichment boundary. Any staleness in the current PC-B spec header is corrected at DOC-0a task 3, not silently left drifted.
4. **Placeholder audit is read-only** — `scripts/doc-drift-check.mjs` scans and reports; it never modifies the files it audits. The disposition table in `docs/vector-cortex/placeholder-audit-report.md` is the actionable output.
5. **No fabricated handoffs** — the disposition table lists only items found by the scan. If a category has no findings, the disposition row says `(none found)`. Handoffs name the owning sprint; they do not pre-decide the implementation.

## Sprint chain (DOC-0a → DOC-0b)

| Sprint | Title |
|--------|-------|
| DOC-0a | Evidence + PLAN_V2 drift fixes |
| DOC-0b | Placeholder scan + deferred-item gate |

### DOC-0a — Evidence + PLAN_V2 drift fixes

Stamps nine evidence files PUBLISHED (VC9A @ v0.20.27, VC9B @ v0.20.28, VC5C @ v0.20.33, VC5D @ v0.20.34, VC7C @ v0.20.35, VC8C @ v0.20.36, PC-A @ v0.20.37, DEDUP-ATTR @ v0.20.42, ML5E @ v0.20.38); updates PC-B/C/D spec headers `planned`→`shipped`; flips PLAN_V2 header `Draft`→`Active — anchor-floor chain shipped (PC-A..E)`; mines the `promptcache striping filter: tallies action=promptcache-striping bytes_saved=4443` event line for PLAN_V2 §Evolution Status and fills the four Node Runtime sub-status rows; refreshes README:14 and ADOPTION:71–72+84 from "opt-in" to default-ON.

**Ownership:** `docs/vector-cortex/evidence/{VC9A.md,VC9B.md,VC5C.md,VC5D.md,VC7C.md,VC8C.md,PC-A.md,DEDUP-ATTR.md,ML5E.md}; docs/vector-cortex/sprints/{PC-B-enrichment-consumer.md,PC-C-substitution-quality.md,PC-D-rollup-canary-drain.md}; docs/vector-cortex/PLAN_V2.md; README.md; docs/ADOPTION.md; docs/vector-cortex/evidence/DOC-0a.md`.

### DOC-0b — Placeholder scan + deferred-item gate

Creates `scripts/doc-drift-check.mjs` (read-only scan for placeholder/TODO/TBD/stale-deferral markers across `docs/vector-cortex/{sprints,phases,evidence}/*.md` + `PLAN_V2.md` + `README.md` + `docs/ADOPTION.md`); runs the scan; dispositions every finding into the report at `docs/vector-cortex/placeholder-audit-report.md`.

**Ownership:** `scripts/doc-drift-check.mjs; docs/vector-cortex/placeholder-audit-report.md; docs/vector-cortex/evidence/DOC-0b.md`.

## Conformance fixtures — DOC reserved family

_None. The DOC phase is pure documentation + developer tooling; it owns no conformance fixture family. (The phase row in CONFORMANCE.md records `(none — pure-docs phase; no conformance fixtures)`.)_

## Exit evidence

Both sprints run the mandatory docs gates: `npm run build` (no-op for docs-only), `npm run lint` (no-op), `git diff --check`, `node scripts/vector-cortex-docs-check.mjs`. DOC-0b adds one structural gate: `node scripts/doc-drift-check.mjs` runs as part of the sprint's own evidence check — the report must exist and every finding must have a disposition row before evidence acceptance. No browser validation burden — DOC touches no dashboard surface.
